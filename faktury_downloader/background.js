const STATE_KEY = "alza_sidebar_state_v4";
const MAX_RETRIES_PER_ITEM = 3;
const EXEC_ACK_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 180000;
const UPLOAD_ENDPOINT = "http://10.3.109.33/faktury/alza/upload.php";

let expectedCache = null;
let runnerActive = false;
let runSeq = 0;
let ackWaiters = new Map();
let capturedBinaryByInvoice = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getState() {
  const obj = await chrome.storage.session.get(STATE_KEY);
  return obj[STATE_KEY] || {
    tabId: null,
    windowId: null,
    rows: [],
    done: {},
    running: false,
    active: null,
    queue: []
  };
}

async function setState(patch) {
  const cur = await getState();
  const next = { ...cur, ...patch };
  await chrome.storage.session.set({ [STATE_KEY]: next });
  return next;
}

async function clearAllState() {
  expectedCache = null;
  ackWaiters.forEach((resolve) => resolve({ ok: false, error: "State cleared" }));
  ackWaiters = new Map();
  await chrome.storage.session.remove(STATE_KEY);
}

async function updateDone(invoiceNo, patch) {
  const st = await getState();
  const prev = st.done[invoiceNo] || {
    pdf: false,
    isdoc: false,
    orderNo: null,
    updatedAt: Date.now(),
    lastError: null,
    pdfPath: null,
    pdfDownloadId: null,
    isdocPath: null,
    isdocDownloadId: null,
    pdfServerPath: null,
    isdocServerPath: null
  };
  const nextRec = { ...prev, ...patch, updatedAt: Date.now() };
  const done = { ...st.done, [invoiceNo]: nextRec };
  await setState({ done });
  return nextRec;
}

function toStatePatchFromDownloadItem(item) {
  if (!item) return null;
  const file = (item.filename || "").replaceAll("\\", "/");
  return {
    path: file,
    id: item.id,
    url: item.finalUrl || item.url || null,
    filename: item.filename || null
  };
}

async function sendToTab(tabId, msg) {
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch {}
}

async function pushStateToUI() {
  const st = await getState();
  if (!st.tabId) return;
  await sendToTab(st.tabId, { type: "ALZA_STATE", state: st });
}

function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/i.exec(dataUrl || "");
  if (!match) throw new Error("Neplatný data URL formát.");
  const mime = match[1] || "application/octet-stream";
  const bytes = atob(match[2]);
  const array = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) array[i] = bytes.charCodeAt(i);
  return new Blob([array], { type: mime });
}

async function hydrateServerState(rows) {
  if (!rows.length) return;

  const response = await fetch(UPLOAD_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "check-bulk",
      items: rows.map((row) => ({
        invoiceNo: row.invoiceNo,
        orderNo: row.orderNo
      }))
    })
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.error || `Bulk kontrola existence vrátila HTTP ${response.status}`);
  }

  const results = data?.results || {};
  for (const row of rows) {
    const rec = results[row.invoiceNo] || {};
    await updateDone(row.invoiceNo, {
      orderNo: row.orderNo,
      pdf: !!rec?.pdf?.exists,
      isdoc: !!rec?.isdoc?.exists,
      pdfServerPath: rec?.pdf?.path || null,
      isdocServerPath: rec?.isdoc?.path || null,
      lastError: null
    });
  }
}

async function setStatus(text) {
  const st = await getState();
  if (!st.tabId) return;
  await sendToTab(st.tabId, { type: "ALZA_STATUS", text });
}

function isPdfUrl(url) {
  if (!url) return false;
  return url.includes("pdf.alza.cz") || url.endsWith(".pdf");
}

chrome.tabs.onUpdated.addListener(async (updatedTabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "complete") return;
  const st = await getState();
  if (!st.tabId || !st.running) return;

  const url = tab.url || changeInfo.url || "";
  if (isPdfUrl(url) && updatedTabId !== st.tabId) {
    try { await chrome.tabs.remove(updatedTabId); } catch {}
    try {
      await chrome.tabs.update(st.tabId, { active: true });
      if (st.windowId != null) await chrome.windows.update(st.windowId, { focused: true });
    } catch {}
  }
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (!expectedCache) return;

  const fn = (item.filename || "").toLowerCase();
  const mime = (item.mime || "").toLowerCase();
  const url = (item.finalUrl || item.url || "").toLowerCase();

  const pdf = fn.endsWith(".pdf") || mime.includes("pdf") || url.includes(".pdf");
  const isdoc = fn.includes(".isdoc") || url.includes(".isdoc");

  if (!pdf && !isdoc) return;

  let ext = "bin";
  if (pdf) ext = "pdf";
  else if (fn.includes(".isdocx") || url.includes(".isdocx")) ext = "isdocx";
  else if (fn.includes(".isdoc") || url.includes(".isdoc")) ext = "isdoc";

  const base = pdf ? "faktury/invoice" : "faktury/isdoc";
  const filename = `${base}/${expectedCache.orderNo}/${expectedCache.invoiceNo}.${ext}`;

  suggest({ filename, conflictAction: "overwrite" });
});

function buildTargetPrefixes(orderNo, invoiceNo) {
  const pdfPrefix = `faktury/invoice/${orderNo}/${invoiceNo}.`;
  const isdocPrefix = `faktury/isdoc/${orderNo}/${invoiceNo}.`;
  return { pdfPrefix, isdocPrefix };
}

function filenameHasPrefix(item, prefix) {
  const f = (item.filename || "").replaceAll("\\", "/");
  return f.includes(`/${prefix}`) || f.includes(prefix);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isTaskDoneForMode(rec, mode) {
  if (!rec) return false;
  if (mode === "pdf") return !!rec.pdf;
  if (mode === "isdoc") return !!rec.isdoc;
  return !!rec.pdf && !!rec.isdoc;
}

function expandTaskByMode(invoiceNo, mode, attempts = 0) {
  if (mode === "both") {
    return [
      { invoiceNo, mode: "pdf", attempts },
      { invoiceNo, mode: "isdoc", attempts }
    ];
  }

  return [{ invoiceNo, mode, attempts }];
}

async function findLatestCompletedDownloads(orderNo, invoiceNo) {
  const { pdfPrefix, isdocPrefix } = buildTargetPrefixes(orderNo, invoiceNo);
  const pdfRegex = `(^|[\\/\\\\])${escapeRegExp(pdfPrefix)}[pP][dD][fF]$`;
  const isdocRegex = `(^|[\\/\\\\])${escapeRegExp(isdocPrefix)}([iI][sS][dD][oO][cC]|[iI][sS][dD][oO][cC][xX])$`;

  try {
    const [pdfItems, isdocItems] = await Promise.all([
      chrome.downloads.search({ filenameRegex: pdfRegex, exists: true, orderBy: ["-startTime"], limit: 20 }),
      chrome.downloads.search({ filenameRegex: isdocRegex, exists: true, orderBy: ["-startTime"], limit: 20 })
    ]);

    const pdfItem = pdfItems.find((i) => i.state === "complete") || pdfItems[0] || null;
    const isdocItem = isdocItems.find((i) => i.state === "complete") || isdocItems[0] || null;

    return { pdfItem, isdocItem };
  } catch {
    const items = await chrome.downloads.search({ exists: true, orderBy: ["-startTime"], limit: 1000 });
    let pdfItem = null;
    let isdocItem = null;
    for (const it of items) {
      if (!pdfItem && filenameHasPrefix(it, pdfPrefix)) pdfItem = it;
      if (!isdocItem && filenameHasPrefix(it, isdocPrefix)) isdocItem = it;
      if (pdfItem && isdocItem) break;
    }
    return { pdfItem, isdocItem };
  }
}

async function syncDoneWithDisk(row) {
  const st = await getState();
  const rec = st.done[row.invoiceNo] || {};
  const found = await findLatestCompletedDownloads(row.orderNo, row.invoiceNo);

  const pdfInfo = toStatePatchFromDownloadItem(found.pdfItem);
  const isdocInfo = toStatePatchFromDownloadItem(found.isdocItem);

  const patch = {
    orderNo: row.orderNo,
    pdf: !!rec.pdf || !!pdfInfo,
    isdoc: !!rec.isdoc || !!isdocInfo,
    pdfPath: pdfInfo?.path || rec.pdfPath || null,
    pdfDownloadId: pdfInfo?.id || rec.pdfDownloadId || null,
    pdfDownloadUrl: pdfInfo?.url || rec.pdfDownloadUrl || null,
    isdocPath: isdocInfo?.path || rec.isdocPath || null,
    isdocDownloadId: isdocInfo?.id || rec.isdocDownloadId || null,
    isdocDownloadUrl: isdocInfo?.url || rec.isdocDownloadUrl || null,
    pdfServerPath: rec.pdfServerPath || null,
    isdocServerPath: rec.isdocServerPath || null
  };

  if (patch.pdf && patch.isdoc) patch.lastError = null;

  await updateDone(row.invoiceNo, patch);
  return { ...rec, ...patch };
}

async function resyncDoneForRows(rows) {
  const done = {};
  for (const row of rows) {
    const found = await findLatestCompletedDownloads(row.orderNo, row.invoiceNo);
    const pdfInfo = toStatePatchFromDownloadItem(found.pdfItem);
    const isdocInfo = toStatePatchFromDownloadItem(found.isdocItem);

    done[row.invoiceNo] = {
      orderNo: row.orderNo,
      pdf: !!pdfInfo,
      isdoc: !!isdocInfo,
      pdfPath: pdfInfo?.path || null,
      pdfDownloadId: pdfInfo?.id || null,
      pdfDownloadUrl: pdfInfo?.url || null,
      isdocPath: isdocInfo?.path || null,
      isdocDownloadId: isdocInfo?.id || null,
      isdocDownloadUrl: isdocInfo?.url || null,
      pdfServerPath: null,
      isdocServerPath: null,
      lastError: null,
      updatedAt: Date.now()
    };
  }
  return done;
}

async function pollForCompletion(active, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  const started = Date.now();
  const { pdfPrefix, isdocPrefix } = buildTargetPrefixes(active.orderNo, active.invoiceNo);

  while (Date.now() - started < timeoutMs) {
    const st = await getState();
    if (!st.running) return { aborted: true };
    if (!st.active || st.active.invoiceNo !== active.invoiceNo) return { aborted: true };

    const items = await chrome.downloads.search({ limit: 80, orderBy: ["-startTime"] });

    let pdfDone = false;
    let isdocDone = false;

    for (const it of items) {
      if (it.state !== "complete") continue;
      if (filenameHasPrefix(it, pdfPrefix)) pdfDone = true;
      if (filenameHasPrefix(it, isdocPrefix)) isdocDone = true;
    }

    const rec = st.done[active.invoiceNo];
    if (rec?.pdf) pdfDone = true;
    if (rec?.isdoc) isdocDone = true;

    const finished =
      active.mode === "pdf" ? pdfDone :
      active.mode === "isdoc" ? isdocDone :
      (pdfDone && isdocDone);

    await updateDone(active.invoiceNo, {
      orderNo: active.orderNo,
      pdf: pdfDone || (rec?.pdf || false),
      isdoc: isdocDone || (rec?.isdoc || false),
      pdfPath: rec?.pdfPath || null,
      pdfDownloadId: rec?.pdfDownloadId || null,
      pdfDownloadUrl: rec?.pdfDownloadUrl || null,
      isdocPath: rec?.isdocPath || null,
      isdocDownloadId: rec?.isdocDownloadId || null,
      isdocDownloadUrl: rec?.isdocDownloadUrl || null,
      pdfServerPath: rec?.pdfServerPath || null,
      isdocServerPath: rec?.isdocServerPath || null,
      lastError: null
    });
    await pushStateToUI();

    if (finished) return { pdfDone, isdocDone };
    await sleep(1000);
  }

  return { timeout: true };
}

function nextRunId() {
  runSeq += 1;
  return `run-${Date.now()}-${runSeq}`;
}

function withExecAckWaiter(runId, timeoutMs = EXEC_ACK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ackWaiters.delete(runId);
      resolve({ ok: false, error: "Execution ack timeout" });
    }, timeoutMs);

    ackWaiters.set(runId, (result) => {
      clearTimeout(timer);
      ackWaiters.delete(runId);
      resolve(result || { ok: false, error: "Unknown execution result" });
    });
  });
}

function resolveExecAck(runId, result) {
  if (!runId) return;
  const waiter = ackWaiters.get(runId);
  if (waiter) waiter(result);
}

async function fetchBlob(url) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`HTTP ${response.status} při načítání ${url}`);
  const blob = await response.blob();
  if (!blob || blob.size === 0) throw new Error("Stažený soubor je prázdný.");
  return blob;
}

async function uploadBlob({ blob, filename, invoiceNo, orderNo, type, sourceUrl }) {
  const formData = new FormData();
  formData.append("invoiceNo", invoiceNo);
  formData.append("orderNo", orderNo);
  formData.append("type", type);
  formData.append("source", "alza");
  formData.append("sourceUrl", sourceUrl || "");
  formData.append("file", blob, filename);

  const response = await fetch(UPLOAD_ENDPOINT, {
    method: "POST",
    body: formData
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(data?.error || `Upload endpoint vrátil HTTP ${response.status}`);
  }

  if (data && data.ok === false) {
    throw new Error(data.error || "Upload endpoint vrátil chybu.");
  }

  return data;
}

async function checkServerArtifact(row, mode) {
  const type = mode === "pdf" ? "pdf" : "isdoc";
  const url = new URL(UPLOAD_ENDPOINT);
  url.searchParams.set("invoiceNo", row.invoiceNo);
  url.searchParams.set("orderNo", row.orderNo);
  url.searchParams.set("type", type);

  const response = await fetch(url.toString(), { method: "GET" });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.error || `Kontrola existence vrátila HTTP ${response.status}`);
  }

  return {
    exists: !!data?.exists,
    path: data?.path || null
  };
}

function inferFilename(downloadUrl, fallbackName) {
  try {
    const pathname = new URL(downloadUrl).pathname;
    const name = pathname.split("/").pop();
    if (name) return name;
  } catch {}
  return fallbackName;
}

async function uploadDownloadedArtifact(row, mode) {
  const st = await getState();
  const rec = st.done[row.invoiceNo] || {};
  const type = mode === "pdf" ? "pdf" : "isdoc";
  const existingServerPath = mode === "pdf" ? rec.pdfServerPath : rec.isdocServerPath;
  const sourceUrl = mode === "pdf" ? rec.pdfDownloadUrl : rec.isdocDownloadUrl;
  const path = mode === "pdf" ? rec.pdfPath : rec.isdocPath;
  const capturedBinary = capturedBinaryByInvoice.get(row.invoiceNo);

  if (existingServerPath) return;
  const serverCheck = await checkServerArtifact(row, mode);
  if (serverCheck.exists) {
    await updateDone(row.invoiceNo, mode === "pdf"
      ? { pdfServerPath: serverCheck.path, lastError: null }
      : { isdocServerPath: serverCheck.path, lastError: null });
    return;
  }
  if (!sourceUrl) {
    if (mode === "isdoc" && capturedBinary?.dataUrl) {
      const blob = dataUrlToBlob(capturedBinary.dataUrl);
      const uploadResponse = await uploadBlob({
        blob,
        filename: capturedBinary.filename || `${row.invoiceNo}.isdoc`,
        invoiceNo: row.invoiceNo,
        orderNo: row.orderNo,
        type,
        sourceUrl: sourceUrl || ""
      });
      await updateDone(row.invoiceNo, { isdocServerPath: uploadResponse?.path || null, lastError: null });
      capturedBinaryByInvoice.delete(row.invoiceNo);
      return;
    }
    throw new Error(`Upload ${mode.toUpperCase()} nelze spustit: Chrome download historie nevrátila zdrojové URL.`);
  }

  const fallbackExt = mode === "pdf" ? "pdf" : "isdoc";
  const filename = inferFilename(sourceUrl, `${row.invoiceNo}.${fallbackExt}`);
  const blob = await fetchBlob(sourceUrl);
  const uploadResponse = await uploadBlob({
    blob,
    filename,
    invoiceNo: row.invoiceNo,
    orderNo: row.orderNo,
    type,
    sourceUrl
  });

  await updateDone(row.invoiceNo, mode === "pdf"
    ? { pdfServerPath: uploadResponse?.path || null, lastError: null }
    : { isdocServerPath: uploadResponse?.path || null, lastError: null });

  await setStatus(`Upload hotov: ${row.invoiceNo} (${mode})${path ? ` • ${path}` : ""}`);
  await pushStateToUI();
}

async function requeueWithRetry(task, reason) {
  const attempts = (task.attempts || 0) + 1;
  await updateDone(task.invoiceNo, { lastError: reason });

  if (attempts >= MAX_RETRIES_PER_ITEM) {
    await setStatus(`Selhalo: ${task.invoiceNo} (${task.mode}) - ${reason}`);
    await pushStateToUI();
    return;
  }

  const st = await getState();
  const queuedTask = { ...task, attempts };
  await setState({ queue: [...(st.queue || []), queuedTask] });
  await setStatus(`Retry ${attempts}/${MAX_RETRIES_PER_ITEM - 1}: ${task.invoiceNo} (${task.mode})`);
  await pushStateToUI();
}

async function startNextIfIdle() {
  if (runnerActive) return;
  runnerActive = true;

  try {
    while (true) {
      const st = await getState();
      if (!st.running || !st.tabId) return;

      if (st.active) {
        const recoveredQueue = [{
          invoiceNo: st.active.invoiceNo,
          mode: st.active.mode,
          attempts: st.active.attempts || 0
        }, ...(st.queue || [])];
        await setState({ active: null, queue: recoveredQueue });
        await setStatus(`Obnovuji zaseknutou položku: ${st.active.invoiceNo} (${st.active.mode})`);
        await pushStateToUI();
        continue;
      }

      const queue = [...(st.queue || [])];
      const nextTask = queue.shift();
      await setState({ queue });

      if (!nextTask) {
        await setState({ running: false });
        await setStatus("Queue prázdná.");
        await pushStateToUI();
        return;
      }

      const row = st.rows.find((r) => r.invoiceNo === nextTask.invoiceNo);
      if (!row) {
        await setStatus(`Řádek nenalezen: ${nextTask.invoiceNo}`);
        await pushStateToUI();
        continue;
      }

      if (nextTask.mode === "both") {
        const expanded = expandTaskByMode(nextTask.invoiceNo, "both", nextTask.attempts || 0);
        await setState({ queue: [...expanded, ...queue] });
        continue;
      }

      const runId = nextRunId();
      const active = {
        invoiceNo: row.invoiceNo,
        orderNo: row.orderNo,
        mode: nextTask.mode,
        runId,
        attempts: nextTask.attempts || 0,
        startedAt: Date.now()
      };
      await setState({ active });
      expectedCache = { invoiceNo: row.invoiceNo, orderNo: row.orderNo };

      await updateDone(row.invoiceNo, { orderNo: row.orderNo, lastError: null });
      await setStatus(`Spouštím: ${row.invoiceNo} (${nextTask.mode})`);
      await pushStateToUI();

      const ackPromise = withExecAckWaiter(runId, EXEC_ACK_TIMEOUT_MS);
      await sendToTab(st.tabId, { type: "ALZA_RUN_ROW", invoiceNo: row.invoiceNo, mode: nextTask.mode, runId });
      const execAck = await ackPromise;

      const afterAck = await getState();
      if (!afterAck.running || !afterAck.active || afterAck.active.runId !== runId) return;

      if (!execAck?.ok) {
        await setState({ active: null });
        expectedCache = null;
        await requeueWithRetry(nextTask, execAck?.error || "Execution failed");
        continue;
      }

      if (nextTask.mode === "pdf" && execAck.pdfDownloadUrl) {
        await updateDone(row.invoiceNo, { pdfDownloadUrl: execAck.pdfDownloadUrl });
      }
      if (nextTask.mode === "isdoc" && execAck.isdocDownloadUrl) {
        await updateDone(row.invoiceNo, { isdocDownloadUrl: execAck.isdocDownloadUrl });
      }
      if (nextTask.mode === "isdoc" && execAck.isdocDataUrl) {
        capturedBinaryByInvoice.set(row.invoiceNo, {
          dataUrl: execAck.isdocDataUrl,
          filename: execAck.isdocFilename || `${row.invoiceNo}.isdoc`
        });
      }

      const pollResult = await pollForCompletion(active, DOWNLOAD_TIMEOUT_MS);
      const st2 = await getState();
      if (!st2.running) return;
      if (pollResult?.aborted) return;

      if (pollResult?.timeout) {
        await setState({ active: null });
        expectedCache = null;
        await requeueWithRetry(nextTask, `Timeout (${active.mode})`);
        continue;
      }

      await setState({ active: null });
      expectedCache = null;
      await syncDoneWithDisk(row);

      try {
        await uploadDownloadedArtifact(row, nextTask.mode);
      } catch (error) {
        await updateDone(row.invoiceNo, { lastError: error?.message || "Upload selhal." });
      }

      await setStatus(`Hotovo: ${active.invoiceNo} (${active.mode})`);
      await pushStateToUI();
      await sleep(250);
    }
  } finally {
    runnerActive = false;
  }
}

async function buildQueueFromRows(rows, mode) {
  const queue = [];
  const st = await getState();

  for (const row of rows) {
    const tasks = expandTaskByMode(row.invoiceNo, mode, 0);
    for (const task of tasks) {
      const rec = st.done[row.invoiceNo] || {};
      if (task.mode === "pdf" && rec.pdfServerPath) {
        await updateDone(row.invoiceNo, { orderNo: row.orderNo, pdf: true, pdfServerPath: rec.pdfServerPath, lastError: null });
        continue;
      }
      if (task.mode === "isdoc" && rec.isdocServerPath) {
        await updateDone(row.invoiceNo, { orderNo: row.orderNo, isdoc: true, isdocServerPath: rec.isdocServerPath, lastError: null });
        continue;
      }
      queue.push(task);
    }
  }

  return queue;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "ALZA_ATTACH") {
      const tabId = sender?.tab?.id;
      const windowId = sender?.tab?.windowId;
      if (!tabId) return sendResponse({ ok: false });

      const st = await getState();
      await setState({ tabId, windowId, rows: msg.rows || st.rows || [] });
      await hydrateServerState(msg.rows || st.rows || []).catch(async (error) => {
        await setStatus(error?.message || "Nepodařilo se načíst stav ze serveru.");
      });
      await pushStateToUI();
      return sendResponse({ ok: true });
    }

    if (msg.type === "ALZA_GET_STATE") {
      const st = await getState();
      return sendResponse({ ok: true, state: st });
    }

    if (msg.type === "ALZA_START_ALL") {
      const st = await getState();
      if (!st.tabId) return sendResponse({ ok: false, error: "No tab" });

      const q = await buildQueueFromRows(st.rows, "both");
      await setState({ running: true, queue: q });
      await setStatus(`Start all: ${q.length} položek`);
      await pushStateToUI();
      startNextIfIdle().catch(() => {});
      return sendResponse({ ok: true });
    }

    if (msg.type === "ALZA_START_ISDOC") {
      const st = await getState();
      if (!st.tabId) return sendResponse({ ok: false, error: "No tab" });

      const q = await buildQueueFromRows(st.rows, "isdoc");
      await setState({ running: true, queue: q });
      await setStatus(`Start ISDOC: ${q.length} položek`);
      await pushStateToUI();
      startNextIfIdle().catch(() => {});
      return sendResponse({ ok: true });
    }

    if (msg.type === "ALZA_STOP") {
      expectedCache = null;
      ackWaiters.forEach((resolve) => resolve({ ok: false, error: "Stopped" }));
      ackWaiters = new Map();
      await setState({ running: false, active: null, queue: [] });
      await setStatus("Stop.");
      await pushStateToUI();
      return sendResponse({ ok: true });
    }

    if (msg.type === "ALZA_CLEAR_DATA") {
      const stBefore = await getState();
      const rowsToKeep = stBefore.rows || [];

      await clearAllState();
      const tabId = sender?.tab?.id;
      const windowId = sender?.tab?.windowId;
      if (tabId) {
        await chrome.storage.session.set({
          [STATE_KEY]: {
            tabId,
            windowId,
            rows: rowsToKeep,
            done: {},
            running: false,
            active: null,
            queue: []
          }
        });
      }
      await sendToTab(tabId, { type: "ALZA_STATUS", text: "Fronta smazána." });
      await sendToTab(tabId, { type: "ALZA_STATE", state: await getState() });
      return sendResponse({ ok: true });
    }

    if (msg.type === "ALZA_OPEN_DOWNLOADED") {
      const st = await getState();
      const { invoiceNo, mode } = msg;
      const rec = st.done[invoiceNo] || {};
      const id = mode === "pdf" ? rec.pdfDownloadId : rec.isdocDownloadId;
      if (!id && id !== 0) return sendResponse({ ok: false, error: "Soubor nebyl v historii nalezen." });
      try {
        await chrome.downloads.show(id);
        return sendResponse({ ok: true });
      } catch {
        return sendResponse({ ok: false, error: "Soubor nelze otevřít v systému." });
      }
    }

    if (msg.type === "ALZA_RETRY") {
      const st = await getState();
      if (!st.tabId) return sendResponse({ ok: false });

      const { invoiceNo, mode } = msg;
      if (!invoiceNo || !mode) return sendResponse({ ok: false });

      const retryTasks = expandTaskByMode(invoiceNo, mode, 0);
      const q = [...retryTasks, ...(st.queue || [])];
      await setState({ running: true, queue: q });

      await setStatus(`Retry queued: ${invoiceNo} (${mode})`);
      await pushStateToUI();
      startNextIfIdle().catch(() => {});
      return sendResponse({ ok: true });
    }

    if (msg.type === "ALZA_RUN_ROW_RESULT") {
      const st = await getState();
      if (!st.active || st.active.runId !== msg.runId) return sendResponse({ ok: false });
      resolveExecAck(msg.runId, {
        ok: !!msg.ok,
        error: msg.error || null,
        pdfDownloadUrl: msg.pdfDownloadUrl || null,
        isdocDownloadUrl: msg.isdocDownloadUrl || null,
        isdocDataUrl: msg.isdocDataUrl || null,
        isdocFilename: msg.isdocFilename || null
      });
      return sendResponse({ ok: true });
    }

    sendResponse({ ok: false });
  })();

  return true;
});
