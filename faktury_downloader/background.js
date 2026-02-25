const STATE_KEY = "alza_sidebar_state_v2";

// SYNC cache for onDeterminingFilename
let expectedCache = null; // { invoiceNo, orderNo }

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

// ----- Queue runner -----
async function startNextIfIdle() {
  const st = await getState();
  if (!st.running || !st.tabId) return;
  if (st.active) return;

  const nextTask = st.queue.shift();
  await setState({ queue: st.queue });

  if (!nextTask) {
    await setStatus("Queue prázdná.");
    await pushStateToUI();
    return;
  }

  const row = st.rows.find(r => r.invoiceNo === nextTask.invoiceNo);
  if (!row) {
    await setStatus(`Řádek nenalezen: ${nextTask.invoiceNo}`);
    await pushStateToUI();
    return startNextIfIdle();
  }

  const active = { invoiceNo: row.invoiceNo, orderNo: row.orderNo, mode: nextTask.mode, startedAt: Date.now() };
  await setState({ active });
  expectedCache = { invoiceNo: row.invoiceNo, orderNo: row.orderNo };

  await updateDone(row.invoiceNo, { orderNo: row.orderNo, lastError: null });
  await setStatus(`Spouštím: ${row.invoiceNo} (${nextTask.mode})`);
  await pushStateToUI();

  await sendToTab(st.tabId, { type: "ALZA_RUN_ROW", invoiceNo: row.invoiceNo, mode: nextTask.mode });

  const pollResult = await pollForCompletion(active, 180000);

  const st2 = await getState();
  if (!st2.running) return;
  if (pollResult?.aborted) return;

  if (pollResult?.timeout) {
    await updateDone(active.invoiceNo, { lastError: `Timeout (${active.mode})` });
    await setState({ active: null });
    expectedCache = null;

    await setStatus(`Timeout: ${active.invoiceNo} (${active.mode}) → Retry`);
    await pushStateToUI();
    return startNextIfIdle();
  }

  await setState({ active: null });
  expectedCache = null;

  await setStatus(`Hotovo: ${active.invoiceNo} (${active.mode})`);
  await pushStateToUI();
  await sleep(250);
  return startNextIfIdle();
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

      const q = [];
      for (const r of st.rows) {
        const rec = st.done[r.invoiceNo] || {};
        if (!(rec.pdf && rec.isdoc)) q.push({ invoiceNo: r.invoiceNo, mode: "both" });
      }

      await setState({ running: true, queue: q });
      await setStatus(`Start all: ${q.length} položek`);
      await pushStateToUI();
      startNextIfIdle().catch(() => {});
      return sendResponse({ ok: true });
    }

    if (msg.type === "ALZA_START_ISDOC") {
      const st = await getState();
      if (!st.tabId) return sendResponse({ ok: false, error: "No tab" });

      const q = [];
      for (const r of st.rows) {
        const rec = st.done[r.invoiceNo] || {};
        if (!rec.isdoc) q.push({ invoiceNo: r.invoiceNo, mode: "isdoc" });
      }

      await setState({ running: true, queue: q });
      await setStatus(`Start ISDOC: ${q.length} položek`);
      await pushStateToUI();
      startNextIfIdle().catch(() => {});
      return sendResponse({ ok: true });
    }

    if (msg.type === "ALZA_STOP") {
      expectedCache = null;
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

      const q = [{ invoiceNo, mode }, ...(st.queue || [])];
      await setState({ running: true, queue: q });

      await setStatus(`Retry queued: ${invoiceNo} (${mode})`);
      await pushStateToUI();
      startNextIfIdle().catch(() => {});
      return sendResponse({ ok: true });
    }

    sendResponse({ ok: false });
  })();

  return true;
});