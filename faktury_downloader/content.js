const digits = (s) => (s || "").replace(/[^\d]/g, "");

let sidebarEl = null;

function findArchiveItems() {
  return Array.from(document.querySelectorAll('[data-testid="ordersArchive-panel"] > div'))
    .filter((el) => el.querySelector('a[href*="/my-account/order-details-"]'));
}

function getReactFiber(node) {
  if (!node) return null;
  const key = Object.keys(node).find((item) => item.startsWith('__reactFiber$'));
  return key ? node[key] : null;
}

function getAttachmentFromInvoiceNode(node) {
  let fiber = getReactFiber(node);
  for (let i = 0; i < 12 && fiber; i++) {
    const attachments = fiber.memoizedProps?.attachments;
    if (Array.isArray(attachments) && attachments.length > 0) {
      return attachments[0];
    }
    fiber = fiber.return;
  }
  return null;
}

function getInvoiceButton(card) {
  return Array.from(card.querySelectorAll('span[role="button"]'))
    .find((el) => /^Faktura\s+\d+/i.test((el.textContent || '').trim()));
}

function extractDocumentId(isdocOptionsUrl) {
  if (!isdocOptionsUrl) return null;
  try {
    return new URL(isdocOptionsUrl).searchParams.get('documentIds');
  } catch {
    return null;
  }
}

function extractRowsFromCards() {
  return findArchiveItems().map((card) => {
    const orderLink = card.querySelector('a[href*="/my-account/order-details-"]');
    const invoiceButton = getInvoiceButton(card);
    if (!orderLink || !invoiceButton) return null;

    const orderNo = digits(orderLink.textContent || orderLink.getAttribute('href') || '');
    const invoiceNo = digits(invoiceButton.textContent || '');
    const attachment = getAttachmentFromInvoiceNode(invoiceButton);
    const pdfUrl = attachment?.self?.href || null;
    const isdocOptionsUrl = attachment?.isdocAction?.href || null;
    const documentId = extractDocumentId(isdocOptionsUrl);

    if (!invoiceNo || !orderNo) return null;

    return {
      invoiceNo,
      orderNo,
      documentId,
      pdfUrl,
      isdocOptionsUrl
    };
  }).filter(Boolean);
}

function findCardByInvoice(invoiceNo) {
  return findArchiveItems().find((card) => (card.textContent || '').includes(invoiceNo)) || null;
}

function ensureSidebar() {
  if (sidebarEl) return;

  sidebarEl = document.createElement('div');
  sidebarEl.id = 'alzaSidebar';
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

  const style = document.createElement('style');
  style.textContent = `
    #alzaSidebar{
      position:fixed; top:0; right:0; height:100vh; width:480px;
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
    .alzaSbRowMeta{ margin-top:8px; opacity:.9; color:#bcd4ff; word-break:break-all; }
  `;

  document.documentElement.appendChild(style);
  document.documentElement.appendChild(sidebarEl);

  document.getElementById('alzaSbRefresh').addEventListener('click', async () => {
    await attachRows();
  });
  document.getElementById('alzaSbStartAll').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'ALZA_START_ALL' });
  });
  document.getElementById('alzaSbStartIsdoc').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'ALZA_START_ISDOC' });
  });
  document.getElementById('alzaSbStop').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'ALZA_STOP' });
  });
  document.getElementById('alzaSbClear').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'ALZA_CLEAR_DATA' });
    await attachRows();
  });
}

function setStatusText(text) {
  const el = document.getElementById('alzaSbStatus');
  if (el) el.textContent = text || '-';
}

function rowPills(rec) {
  const pdfClass = rec?.pdf ? 'ok' : (rec?.lastError && !rec?.pdf ? 'bad' : 'mid');
  const isdocClass = rec?.isdoc ? 'ok' : (rec?.lastError && !rec?.isdoc ? 'bad' : 'mid');
  return `
    <span class="pill ${pdfClass}">PDF: ${rec?.pdf ? 'OK' : 'NO'}</span>
    <span class="pill ${isdocClass}">ISDOC: ${rec?.isdoc ? 'OK' : 'NO'}</span>
  `;
}

function renderList(state) {
  const list = document.getElementById('alzaSbList');
  if (!list) return;

  const done = state.done || {};
  const active = state.active;

  list.innerHTML = state.rows.map((row) => {
    const rec = done[row.invoiceNo] || {};
    const isActive = active && active.invoiceNo === row.invoiceNo;
    const error = rec.lastError ? `<div class="alzaSbRowErr">Error: ${rec.lastError}</div>` : '';
    const activeTag = isActive ? `<span class="pill mid">ACTIVE: ${active.mode}</span>` : '';
    const serverPaths = `
      PDF server: ${rec?.pdfServerPath || '-'}<br>
      ISDOC server: ${rec?.isdocServerPath || '-'}<br>
      documentId: ${row.documentId || '-'}
    `;

    return `
      <div class="alzaSbRow" data-inv="${row.invoiceNo}">
        <div class="alzaSbRowTop">
          <div class="mono">${row.invoiceNo} • ${row.orderNo}</div>
          <div style="display:flex; gap:6px; align-items:center;">
            ${activeTag}
            ${rowPills(rec)}
          </div>
        </div>
        <div class="alzaSbRowMid">
          <button data-act="retryPdf" data-inv="${row.invoiceNo}">Retry PDF</button>
          <button data-act="retryIsdoc" data-inv="${row.invoiceNo}">Retry ISDOC</button>
          <button data-act="retryBoth" data-inv="${row.invoiceNo}">Retry obojí</button>
          <button data-act="scroll" data-inv="${row.invoiceNo}">Scroll</button>
        </div>
        <div class="alzaSbRowMeta">${serverPaths}</div>
        ${error}
      </div>
    `;
  }).join('');

  list.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const inv = btn.getAttribute('data-inv');
      const act = btn.getAttribute('data-act');
      if (!inv || !act) return;

      if (act === 'retryPdf') await chrome.runtime.sendMessage({ type: 'ALZA_RETRY', invoiceNo: inv, mode: 'pdf' });
      if (act === 'retryIsdoc') await chrome.runtime.sendMessage({ type: 'ALZA_RETRY', invoiceNo: inv, mode: 'isdoc' });
      if (act === 'retryBoth') await chrome.runtime.sendMessage({ type: 'ALZA_RETRY', invoiceNo: inv, mode: 'both' });
      if (act === 'scroll') {
        const card = findCardByInvoice(inv);
        if (card) card.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
    });
  });
}

async function attachRows() {
  ensureSidebar();
  const rows = extractRowsFromCards();
  await chrome.runtime.sendMessage({ type: 'ALZA_ATTACH', rows });
  const response = await chrome.runtime.sendMessage({ type: 'ALZA_GET_STATE' });
  if (response?.ok) renderList(response.state);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'ALZA_STATUS') {
    ensureSidebar();
    setStatusText(msg.text);
  }
  if (msg?.type === 'ALZA_STATE') {
    ensureSidebar();
    renderList(msg.state);
  }
});

(function init() {
  if (!location.href.includes('orders')) return;
  attachRows().catch(() => {});
})();
