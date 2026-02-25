const STATE_KEY = "alza_sidebar_state_v2";
const MAX_RETRIES_PER_ITEM = 3;
const EXEC_ACK_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 180000;

// SYNC cache for onDeterminingFilename
let expectedCache = null; // { invoiceNo, orderNo }
let runnerActive = false;
let runSeq = 0;
let ackWaiters = new Map();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getState() {
  const obj = await chrome.storage.session.get(STATE_KEY);
  return obj[STATE_KEY] || {
    tabId: null,
    windowId: null,
    rows: [],
    done: {},
    running: false,
    active: null,   // { invoiceNo, orderNo, mode:'pdf'|'isdoc'|'both', startedAt:number }
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
  const prev = st.done[invoiceNo] || { pdf: false, isdoc: false, orderNo: null, updatedAt: Date.now(), lastError: null };
  const nextRec = { ...prev, ...patch, updatedAt: Date.now() };
  const done = { ...st.done, [invoiceNo]: nextRec };
  await setState({ done });
  return nextRec;
}

async function sendToTab(tabId, msg) {
  try { await chrome.tabs.sendMessage(tabId, msg); } catch {}
}

async function pushStateToUI() {
  const st = await getState();
  if (!st.tabId) return;
  await sendToTab(st.tabId, { type: "ALZA_STATE", state: st });
}

async function setStatus(text) {
  const st = await getState();
  if (!st.tabId) return;
  await sendToTab(st.tabId, { type: "ALZA_STATUS", text });
}

// ----- Close PDF tabs -----
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

// ----- Download naming (SYNC) -----
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

// ----- Robust completion detection (polling by target path) -----
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

async function detectExistingDownloads(orderNo, invoiceNo) {
  const { pdfPrefix, isdocPrefix } = buildTargetPrefixes(orderNo, invoiceNo);
  const pdfRegex = `(^|[\/\\])${escapeRegExp(pdfPrefix)}pdf$`;
  const isdocRegex = `(^|[\/\\])${escapeRegExp(isdocPrefix)}(isdoc|isdocx)$`;

  try {
    const [pdfItems, isdocItems] = await Promise.all([
      chrome.downloads.search({ state: "complete", filenameRegex: pdfRegex, limit: 1 }),
      chrome.downloads.search({ state: "complete", filenameRegex: isdocRegex, limit: 1 })
    ]);

    return { pdf: pdfItems.length > 0, isdoc: isdocItems.length > 0 };
  } catch {
    const items = await chrome.downloads.search({ state: "complete", limit: 500 });
    let pdf = false;
    let isdoc = false;
    for (const it of items) {
      if (!pdf && filenameHasPrefix(it, pdfPrefix)) pdf = true;
      if (!isdoc && filenameHasPrefix(it, isdocPrefix)) isdoc = true;
      if (pdf && isdoc) break;
    }
    return { pdf, isdoc };
  }
}

async function syncDoneWithDisk(row) {
  const st = await getState();
  const rec = st.done[row.invoiceNo] || {};
  const fromDisk = await detectExistingDownloads(row.orderNo, row.invoiceNo);

  const patch = {
    orderNo: row.orderNo,
    pdf: !!rec.pdf || fromDisk.pdf,
    isdoc: !!rec.isdoc || fromDisk.isdoc
  };

  if (patch.pdf && patch.isdoc) patch.lastError = null;

  if (patch.pdf !== !!rec.pdf || patch.isdoc !== !!rec.isdoc || patch.orderNo !== rec.orderNo || patch.lastError !== rec.lastError) {
    await updateDone(row.invoiceNo, patch);
  }

  return { ...rec, ...patch };
}

async function pollForCompletion(active, timeoutMs = 180000) {
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

// ----- Queue runner -----
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
    await setStatus("Queue prázdná.");
    await pushStateToUI();
    return;
  }

  const row = st.rows.find(r => r.invoiceNo === nextTask.invoiceNo);
  if (!row) {
    await setStatus(`Řádek nenalezen: ${nextTask.invoiceNo}`);
    await pushStateToUI();
    continue;
  }

  const recFromDisk = await syncDoneWithDisk(row);
  if (isTaskDoneForMode(recFromDisk, nextTask.mode)) {
    await setStatus(`Přeskakuji (už staženo): ${row.invoiceNo} (${nextTask.mode})`);
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

  for (const row of rows) {
    const rec = await syncDoneWithDisk(row);
    const tasks = expandTaskByMode(row.invoiceNo, mode, 0);
    for (const task of tasks) {
      if (!isTaskDoneForMode(rec, task.mode)) {
        queue.push(task);
      }
    }
  }

  return queue;
}

// ----- Messages from content (sidebar) -----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "ALZA_ATTACH") {
      const tabId = sender?.tab?.id;
      const windowId = sender?.tab?.windowId;
      if (!tabId) return sendResponse({ ok: false });

      const st = await getState();
      await setState({ tabId, windowId, rows: msg.rows || st.rows || [] });
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
      await clearAllState();
      // after clearing, reattach tabId if possible
      const tabId = sender?.tab?.id;
      const windowId = sender?.tab?.windowId;
      if (tabId) {
        await chrome.storage.session.set({
          [STATE_KEY]: {
            tabId, windowId,
            rows: [],
            done: {},
            running: false,
            active: null,
            queue: []
          }
        });
      }
      await sendToTab(tabId, { type: "ALZA_STATUS", text: "Data smazána." });
      await sendToTab(tabId, { type: "ALZA_STATE", state: await getState() });
      return sendResponse({ ok: true });
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
      resolveExecAck(msg.runId, { ok: !!msg.ok, error: msg.error || null });
      return sendResponse({ ok: true });
    }

    sendResponse({ ok: false });
  })();

  return true;
});
