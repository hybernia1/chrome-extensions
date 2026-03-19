const STATE_KEY = "alza_sidebar_state_v3";
const MAX_RETRIES_PER_ITEM = 3;
const UPLOAD_ENDPOINT = "http://10.3.109.33/faktury/alza/upload.php";

let runnerActive = false;

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
  await chrome.storage.session.remove(STATE_KEY);
}

function normalizeDoneRecord(prev = {}) {
  return {
    orderNo: prev.orderNo || null,
    pdf: !!prev.pdf,
    isdoc: !!prev.isdoc,
    pdfUrl: prev.pdfUrl || null,
    isdocOptionsUrl: prev.isdocOptionsUrl || null,
    documentId: prev.documentId || null,
    pdfServerPath: prev.pdfServerPath || null,
    isdocServerPath: prev.isdocServerPath || null,
    lastPdfResponse: prev.lastPdfResponse || null,
    lastIsdocResponse: prev.lastIsdocResponse || null,
    lastError: prev.lastError || null,
    updatedAt: prev.updatedAt || Date.now()
  };
}

async function updateDone(invoiceNo, patch) {
  const st = await getState();
  const prev = normalizeDoneRecord(st.done[invoiceNo]);
  const nextRec = { ...prev, ...patch, updatedAt: Date.now() };
  const done = { ...st.done, [invoiceNo]: nextRec };
  await setState({ done });
  return nextRec;
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

async function setStatus(text) {
  const st = await getState();
  if (!st.tabId) return;
  await sendToTab(st.tabId, { type: "ALZA_STATUS", text });
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

async function buildQueueFromRows(rows, mode) {
  const st = await getState();
  const queue = [];

  for (const row of rows) {
    const rec = normalizeDoneRecord(st.done[row.invoiceNo]);
    const tasks = expandTaskByMode(row.invoiceNo, mode, 0);
    for (const task of tasks) {
      if (!isTaskDoneForMode(rec, task.mode)) queue.push(task);
    }
  }

  return queue;
}

function getFileExtensionFromUrl(url, fallback) {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split(".").pop();
    if (ext && ext !== pathname) return ext.toLowerCase();
  } catch {}
  return fallback;
}

async function fetchBlob(url) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} při načítání ${url}`);
  }

  const blob = await response.blob();
  if (!blob || blob.size === 0) {
    throw new Error("Stažený soubor je prázdný.");
  }

  return {
    blob,
    contentType: response.headers.get("content-type") || blob.type || "application/octet-stream"
  };
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

function getPdfUrl(row) {
  return row?.pdfUrl || null;
}

function getDocumentId(row) {
  if (row?.documentId) return row.documentId;
  if (!row?.isdocOptionsUrl) return null;
  try {
    return new URL(row.isdocOptionsUrl).searchParams.get("documentIds");
  } catch {
    return null;
  }
}

async function resolveIsdocUpload(row) {
  const optionsUrl = row?.isdocOptionsUrl;
  if (!optionsUrl) throw new Error("ISDOC options URL nenalezena.");

  const optionsResponse = await fetch(optionsUrl, { credentials: "include" });
  if (!optionsResponse.ok) {
    throw new Error(`ISDOC options selhaly: HTTP ${optionsResponse.status}`);
  }

  const optionsData = await optionsResponse.json();
  const option = (optionsData?.downloadOptions || []).find((item) => (item?.name || "").toUpperCase() === "ISDOC");
  const form = option?.onActionClick?.form;
  const actionHref = option?.onActionClick?.href;

  if (!form || !actionHref) {
    throw new Error("ISDOC form akce nebyla nalezena.");
  }

  const payload = {};
  for (const field of form.value || []) {
    payload[field.name] = Array.isArray(field.value) && field.value.length === 1 ? field.value[0] : field.value;
  }

  const requestResponse = await fetch(actionHref, {
    method: form.method || "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload)
  });

  const requestData = await requestResponse.json().catch(() => null);
  if (!requestResponse.ok) {
    throw new Error(requestData?.error || `ISDOC request selhal: HTTP ${requestResponse.status}`);
  }

  // Následující krok (requestId -> attachment) zatím není spolehlivě rozkrytý.
  throw new Error(`ISDOC request vytvořen (${requestData?.requestId || "bez requestId"}), ale finální attachment workflow zatím není implementováno.`);
}

async function executeTask(row, mode) {
  if (mode === "pdf") {
    const pdfUrl = getPdfUrl(row);
    if (!pdfUrl) throw new Error("PDF URL nenalezena.");

    const ext = getFileExtensionFromUrl(pdfUrl, "pdf");
    const filename = `${row.invoiceNo}.${ext}`;
    const { blob } = await fetchBlob(pdfUrl);
    const uploadResponse = await uploadBlob({
      blob,
      filename,
      invoiceNo: row.invoiceNo,
      orderNo: row.orderNo,
      type: "pdf",
      sourceUrl: pdfUrl
    });

    await updateDone(row.invoiceNo, {
      orderNo: row.orderNo,
      documentId: getDocumentId(row),
      pdfUrl,
      isdocOptionsUrl: row.isdocOptionsUrl || null,
      pdf: true,
      pdfServerPath: uploadResponse?.path || null,
      lastPdfResponse: uploadResponse,
      lastError: null
    });
    return;
  }

  if (mode === "isdoc") {
    const uploadResponse = await resolveIsdocUpload(row);
    await updateDone(row.invoiceNo, {
      orderNo: row.orderNo,
      documentId: getDocumentId(row),
      pdfUrl: row.pdfUrl || null,
      isdocOptionsUrl: row.isdocOptionsUrl || null,
      isdoc: true,
      isdocServerPath: uploadResponse?.path || null,
      lastIsdocResponse: uploadResponse,
      lastError: null
    });
    return;
  }

  throw new Error(`Neznámý mód ${mode}`);
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
  await setState({ queue: [...(st.queue || []), { ...task, attempts }] });
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

      const queue = [...(st.queue || [])];
      const nextTask = queue.shift();
      await setState({ queue });

      if (!nextTask) {
        await setState({ active: null, running: false });
        await setStatus("Fronta dokončena.");
        await pushStateToUI();
        return;
      }

      const row = st.rows.find((item) => item.invoiceNo === nextTask.invoiceNo);
      if (!row) {
        await setStatus(`Řádek nenalezen: ${nextTask.invoiceNo}`);
        await pushStateToUI();
        continue;
      }

      const rec = normalizeDoneRecord(st.done[row.invoiceNo]);
      if (isTaskDoneForMode(rec, nextTask.mode)) continue;

      await setState({
        active: {
          invoiceNo: row.invoiceNo,
          orderNo: row.orderNo,
          mode: nextTask.mode,
          attempts: nextTask.attempts || 0,
          startedAt: Date.now()
        }
      });
      await setStatus(`Zpracovávám: ${row.invoiceNo} (${nextTask.mode})`);
      await pushStateToUI();

      try {
        await executeTask(row, nextTask.mode);
        await setState({ active: null });
        await setStatus(`Hotovo: ${row.invoiceNo} (${nextTask.mode})`);
        await pushStateToUI();
        await sleep(250);
      } catch (error) {
        await setState({ active: null });
        await requeueWithRetry(nextTask, error?.message || "Execution failed");
      }
    }
  } finally {
    runnerActive = false;
  }
}

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

      const queue = await buildQueueFromRows(st.rows, "both");
      await setState({ running: true, queue });
      await setStatus(`Start all: ${queue.length} položek`);
      await pushStateToUI();
      startNextIfIdle().catch(() => {});
      return sendResponse({ ok: true });
    }

    if (msg.type === "ALZA_START_ISDOC") {
      const st = await getState();
      if (!st.tabId) return sendResponse({ ok: false, error: "No tab" });

      const queue = await buildQueueFromRows(st.rows, "isdoc");
      await setState({ running: true, queue });
      await setStatus(`Start ISDOC: ${queue.length} položek`);
      await pushStateToUI();
      startNextIfIdle().catch(() => {});
      return sendResponse({ ok: true });
    }

    if (msg.type === "ALZA_STOP") {
      await setState({ running: false, active: null, queue: [] });
      await setStatus("Stop.");
      await pushStateToUI();
      return sendResponse({ ok: true });
    }

    if (msg.type === "ALZA_CLEAR_DATA") {
      const stBefore = await getState();
      const rowsToKeep = stBefore.rows || [];
      const tabId = sender?.tab?.id || stBefore.tabId;
      const windowId = sender?.tab?.windowId || stBefore.windowId;

      await clearAllState();
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
      await sendToTab(tabId, { type: "ALZA_STATUS", text: "Lokální stav smazán." });
      await sendToTab(tabId, { type: "ALZA_STATE", state: await getState() });
      return sendResponse({ ok: true });
    }

    if (msg.type === "ALZA_RETRY") {
      const st = await getState();
      if (!st.tabId) return sendResponse({ ok: false, error: "No tab" });

      const { invoiceNo, mode } = msg;
      const retryTasks = expandTaskByMode(invoiceNo, mode, 0);
      await setState({ running: true, queue: [...retryTasks, ...(st.queue || [])] });
      await setStatus(`Retry queued: ${invoiceNo} (${mode})`);
      await pushStateToUI();
      startNextIfIdle().catch(() => {});
      return sendResponse({ ok: true });
    }

    sendResponse({ ok: false });
  })();

  return true;
});
