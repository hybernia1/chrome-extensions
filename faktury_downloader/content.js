const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const digits = (s) => (s || "").replace(/[^\d]/g, "");

function extractRowsFromTable() {
  const table = document.querySelector("table");
  if (!table) return [];

  const rows = Array.from(table.querySelectorAll("tbody tr"));
  return rows.map(tr => {
    const tds = tr.querySelectorAll("td");
    if (tds.length < 2) return null;

    const invoiceText = (tds[0].innerText || "").trim();
    const invoiceNo = digits(invoiceText);

    const orderLink = tds[1].querySelector("a[title]");
    const orderNo = digits(orderLink?.getAttribute("title") || "");

    return (invoiceNo && orderNo) ? { invoiceNo, orderNo } : null;
  }).filter(Boolean);
}

function findTrByInvoice(invoiceNo) {
  const table = document.querySelector("table");
  if (!table) return null;
  const trs = Array.from(table.querySelectorAll("tbody tr"));
  return trs.find(tr => (tr.innerText || "").includes(invoiceNo)) || null;
}

function clickInvoiceInTr(tr) {
  const td0 = tr.querySelector("td");
  const clickable = td0?.querySelector("span");
  if (!clickable) throw new Error("Klikací span (Faktura) nenalezen.");
  clickable.click();
}

async function waitForFormatModal(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const modal = document.querySelector(".MuiDialog-paper[role='dialog']");
    if (modal) return modal;
    await sleep(100);
  }
  throw new Error("Modal s formáty (PDF/ISDOC) se neotevřel");
}

function findButtonByExactText(root, text) {
  const up = text.toUpperCase();
  const btns = Array.from(root.querySelectorAll("button"));
  return btns.find(b => (b.textContent || "").trim().toUpperCase() === up) || null;
}

async function waitForDownloadStartedModal(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const h3 = Array.from(document.querySelectorAll("h3")).find(n =>
      (n.textContent || "").includes("Stahování souboru začalo")
    );
    if (h3) return h3.closest(".reactPage-alz-199") || h3.closest("div") || h3;
    await sleep(100);
  }
  return null;
}

async function closeDownloadStartedModal(modalRoot) {
  if (!modalRoot) return;
  const closeBtn = findButtonByExactText(modalRoot, "Zavřít");
  if (closeBtn) closeBtn.click();
  await sleep(200);
}

async function closeFormatModal(modal) {
  const closeBtn =
    modal.querySelector("[data-testid='dialog-close-button']") ||
    document.querySelector("[data-testid='dialog-close-button']");
  if (closeBtn) closeBtn.click();
  await sleep(250);
}

async function clickDownloads(modal, mode) {
  const pdfBtn = findButtonByExactText(modal, "PDF");
  const isdocBtn = findButtonByExactText(modal, "ISDOC");
  if (!pdfBtn || !isdocBtn) throw new Error("Nenalezeno PDF/ISDOC tlačítko.");

  if (mode === "pdf" || mode === "both") {
    pdfBtn.click();
    await sleep(250);
    await closeDownloadStartedModal(await waitForDownloadStartedModal(8000));
  }

  if (mode === "isdoc" || mode === "both") {
    isdocBtn.click();
    await sleep(250);
    await closeDownloadStartedModal(await waitForDownloadStartedModal(8000));
  }
}

function restoreScroll(savedY, tr) {
  window.scrollTo({ top: savedY, left: 0, behavior: "instant" });
  try { tr.scrollIntoView({ block: "center", inline: "nearest" }); } catch {}
}

// ---------------- Sidebar UI ----------------
let sidebarEl = null;

function ensureSidebar() {
  if (sidebarEl) return;

  sidebarEl = document.createElement("div");
  sidebarEl.id = "alzaSidebar";
  sidebarEl.innerHTML = `
    <div class="alzaSbHeader">
      <div class="alzaSbTitle">Alza Doklady</div>
      <div class="alzaSbBtns">
        <button id="alzaSbRefresh">Refresh</button>
        <button id="alzaSbStartAll">Start all</button>
        <button id="alzaSbStartIsdoc">Start ISDOC</button>
        <button id="alzaSbStop">Stop</button>
      </div>
      <div class="alzaSbBtns">
        <button id="alzaSbClear">Clear data</button>
      </div>
      <div id="alzaSbStatus" class="alzaSbStatus">-</div>
    </div>
    <div class="alzaSbBody">
      <div id="alzaSbList" class="alzaSbList"></div>
    </div>
  `;

  const style = document.createElement("style");
  style.textContent = `
    #alzaSidebar{
      position:fixed; top:0; right:0; height:100vh; width:460px;
      z-index:2147483647;
      background:#0f1115; color:#e7e7e7;
      border-left:1px solid rgba(255,255,255,.12);
      box-shadow:0 0 24px rgba(0,0,0,.5);
      font:12px system-ui, -apple-system, Segoe UI, Roboto, Arial;
    }
    #alzaSidebar *{ box-sizing:border-box; }
    .alzaSbHeader{ padding:10px; border-bottom:1px solid rgba(255,255,255,.12); }
    .alzaSbTitle{ font-weight:700; font-size:13px; margin-bottom:8px; }
    .alzaSbBtns{ display:flex; gap:6px; margin-bottom:8px; flex-wrap:wrap; }
    .alzaSbBtns button{
      flex:1; min-width:110px; height:30px; cursor:pointer;
      border:1px solid rgba(255,255,255,.18); background:#161a22; color:#fff;
      border-radius:8px;
    }
    .alzaSbStatus{ opacity:.9; white-space:pre-wrap; }
    .alzaSbBody{ height:calc(100vh - 132px); overflow:auto; padding:10px; }
    .alzaSbList{ display:flex; flex-direction:column; gap:8px; }
    .alzaSbRow{
      padding:10px; border:1px solid rgba(255,255,255,.12); border-radius:12px;
      background:#12151c;
    }
    .alzaSbRowTop{ display:flex; justify-content:space-between; gap:10px; align-items:center; }
    .mono{ font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
    .pill{ padding:2px 8px; border-radius:999px; font-size:11px; border:1px solid rgba(255,255,255,.12); }
    .ok{ background:rgba(46,160,67,.18); border-color:rgba(46,160,67,.5); }
    .bad{ background:rgba(248,81,73,.16); border-color:rgba(248,81,73,.5); }
    .mid{ background:rgba(210,153,34,.16); border-color:rgba(210,153,34,.5); }
    .alzaSbRowMid{ margin-top:8px; display:flex; gap:6px; flex-wrap:wrap; }
    .alzaSbRowMid button{
      height:28px; padding:0 10px; cursor:pointer;
      border:1px solid rgba(255,255,255,.18); background:#161a22; color:#fff;
      border-radius:8px;
    }
    .alzaSbRowErr{ margin-top:8px; opacity:.9; color:#ffb4b4; }
  `;
  document.documentElement.appendChild(style);
  document.documentElement.appendChild(sidebarEl);

  document.getElementById("alzaSbRefresh").addEventListener("click", async () => {
    await attachRows();
  });

  document.getElementById("alzaSbStartAll").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "ALZA_START_ALL" });
  });

  document.getElementById("alzaSbStartIsdoc").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "ALZA_START_ISDOC" });
  });

  document.getElementById("alzaSbStop").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "ALZA_STOP" });
  });

  document.getElementById("alzaSbClear").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "ALZA_CLEAR_DATA" });
    await attachRows();
  });
}

function setStatusText(t) {
  const el = document.getElementById("alzaSbStatus");
  if (el) el.textContent = t || "-";
}

function rowPills(rec) {
  const pdfClass = rec?.pdf ? "ok" : (rec?.lastError ? "bad" : "mid");
  const isdocClass = rec?.isdoc ? "ok" : (rec?.lastError ? "bad" : "mid");
  return `
    <span class="pill ${pdfClass}">PDF: ${rec?.pdf ? "OK" : "NO"}</span>
    <span class="pill ${isdocClass}">ISDOC: ${rec?.isdoc ? "OK" : "NO"}</span>
  `;
}

function renderList(state) {
  const list = document.getElementById("alzaSbList");
  if (!list) return;

  const done = state.done || {};
  const active = state.active;

  list.innerHTML = state.rows.map(r => {
    const rec = done[r.invoiceNo] || {};
    const isActive = active && active.invoiceNo === r.invoiceNo;
    const title = `${r.invoiceNo} • ${r.orderNo}`;
    const err = rec.lastError ? `<div class="alzaSbRowErr">Error: ${rec.lastError}</div>` : "";
    const activeTag = isActive ? `<span class="pill mid">ACTIVE: ${active.mode}</span>` : "";

    return `
      <div class="alzaSbRow" data-inv="${r.invoiceNo}">
        <div class="alzaSbRowTop">
          <div class="mono">${title}</div>
          <div style="display:flex; gap:6px; align-items:center;">
            ${activeTag}
            ${rowPills(rec)}
          </div>
        </div>

        <div class="alzaSbRowMid">
          <button data-act="retryPdf" data-inv="${r.invoiceNo}">Retry PDF</button>
          <button data-act="retryIsdoc" data-inv="${r.invoiceNo}">Retry ISDOC</button>
          <button data-act="retryBoth" data-inv="${r.invoiceNo}">Retry obojí</button>
          <button data-act="scroll" data-inv="${r.invoiceNo}">Scroll</button>
        </div>

        ${err}
      </div>
    `;
  }).join("");

  list.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", async () => {
      const inv = btn.getAttribute("data-inv");
      const act = btn.getAttribute("data-act");
      if (!inv || !act) return;

      if (act === "retryPdf") await chrome.runtime.sendMessage({ type: "ALZA_RETRY", invoiceNo: inv, mode: "pdf" });
      if (act === "retryIsdoc") await chrome.runtime.sendMessage({ type: "ALZA_RETRY", invoiceNo: inv, mode: "isdoc" });
      if (act === "retryBoth") await chrome.runtime.sendMessage({ type: "ALZA_RETRY", invoiceNo: inv, mode: "both" });

      if (act === "scroll") {
        const tr = findTrByInvoice(inv);
        if (tr) tr.scrollIntoView({ block: "center", inline: "nearest" });
      }
    });
  });
}

async function attachRows() {
  ensureSidebar();

  const rows = extractRowsFromTable();
  await chrome.runtime.sendMessage({ type: "ALZA_ATTACH", rows });

  const resp = await chrome.runtime.sendMessage({ type: "ALZA_GET_STATE" });
  if (resp?.ok) renderList(resp.state);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "ALZA_STATUS") {
    ensureSidebar();
    setStatusText(msg.text);
  }
  if (msg?.type === "ALZA_STATE") {
    ensureSidebar();
    renderList(msg.state);
  }
  if (msg?.type === "ALZA_RUN_ROW") {
    (async () => {
      const { invoiceNo, mode } = msg;

      const savedY = window.scrollY;
      const tr = findTrByInvoice(invoiceNo);
      if (!tr) return;

      tr.scrollIntoView({ block: "center", inline: "nearest" });
      await sleep(150);

      clickInvoiceInTr(tr);
      const modal = await waitForFormatModal(15000);

      await clickDownloads(modal, mode);
      await closeFormatModal(modal);

      await sleep(100);
      restoreScroll(savedY, tr);
    })().catch(() => {});
  }
});

(function init() {
  if (!location.href.includes("documents")) return;
  attachRows().catch(() => {});
})();