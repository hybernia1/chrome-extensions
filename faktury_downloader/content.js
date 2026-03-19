const digits = (s) => (s || "").replace(/[^\d]/g, "");

const pageResolvers = new Map();
let pageRequestSeq = 0;

let sidebarEl = null;

function findArchiveItems() {
  return Array.from(document.querySelectorAll('[data-testid="ordersArchive-panel"] > div'))
    .filter((el) => el.querySelector('a[href*="/my-account/order-details-"]'));
}

function isDocumentsPage() {
  return location.href.includes('documents');
}

function findDocumentRows() {
  const table = document.querySelector('table');
  if (!table) return [];
  return Array.from(table.querySelectorAll('tbody tr'));
}

function findDocumentRowByInvoice(invoiceNo) {
  return findDocumentRows().find((tr) => (tr.innerText || '').includes(invoiceNo)) || null;
}

function dispatchMouseSequence(node) {
  if (!node) return false;
  const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  for (const type of events) {
    node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  return true;
}

function getDocumentRowClickCandidates(tr) {
  const firstCell = tr.querySelector('td');
  return [
    firstCell?.querySelector('[role="button"]'),
    firstCell?.querySelector('button'),
    firstCell?.querySelector('a'),
    firstCell?.querySelector('span'),
    firstCell,
    tr
  ].filter(Boolean);
}

function clickInvoiceInDocumentRow(tr) {
  for (const candidate of getDocumentRowClickCandidates(tr)) {
    if (dispatchMouseSequence(candidate)) return;
  }
  throw new Error('Klikací element faktury nenalezen.');
}

function extractRowsFromDocumentsTable() {
  return findDocumentRows().map((tr) => {
    const tds = tr.querySelectorAll('td');
    if (tds.length < 2) return null;

    const invoiceNo = digits((tds[0].innerText || '').trim());
    const orderLink = tds[1].querySelector('a[title]');
    const orderNo = digits(orderLink?.getAttribute('title') || '');

    return invoiceNo && orderNo ? { invoiceNo, orderNo, documentId: null, pdfUrl: null, isdocOptionsUrl: null } : null;
  }).filter(Boolean);
}

function getReactFiber(node) {
  if (!node) return null;
  const key = Object.keys(node).find((item) => item.startsWith('__reactFiber$'));
  return key ? node[key] : null;
}

function findFiberContext(node) {
  let fiber = getReactFiber(node);
  for (let i = 0; i < 12 && fiber; i++) {
    const attachments = fiber.memoizedProps?.attachments;
    const processAction = fiber.memoizedProps?.processAction;
    if (Array.isArray(attachments) && attachments.length > 0) {
      return { attachment: attachments[0], processAction };
    }
    fiber = fiber.return;
  }
  return null;
}

function getAttachmentContextFromInvoiceNode(node) {
  let current = node;
  for (let i = 0; i < 6 && current; i++) {
    const context = findFiberContext(current);
    if (context) return context;
    current = current.parentElement;
  }
  return null;
}

function getAttachmentFromInvoiceNode(node) {
  return getAttachmentContextFromInvoiceNode(node)?.attachment || null;
}

function getInvoiceButton(card) {
  const candidates = Array.from(card.querySelectorAll('span[role="button"], span, a, button, div'));
  return candidates.find((el) => /^Faktura\s+\d+/i.test((el.textContent || '').trim()));
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

function extractRows() {
  return isDocumentsPage() ? extractRowsFromDocumentsTable() : extractRowsFromCards();
}

function findRowElementByInvoice(invoiceNo) {
  if (isDocumentsPage()) return findDocumentRowByInvoice(invoiceNo);
  return findArchiveItems().find((card) => (card.textContent || '').includes(invoiceNo)) || null;
}

function injectPageBridge() {
  if (document.getElementById('alzaPageBridge')) return;

  const script = document.createElement('script');
  script.id = 'alzaPageBridge';
  script.textContent = `
    (() => {
      function findArchiveItems() {
        return Array.from(document.querySelectorAll('[data-testid="ordersArchive-panel"] > div'))
          .filter((el) => el.querySelector('a[href*="/my-account/order-details-"]'));
      }

      function isDocumentsPage() {
  return location.href.includes('documents');
}

function findDocumentRows() {
  const table = document.querySelector('table');
  if (!table) return [];
  return Array.from(table.querySelectorAll('tbody tr'));
}

function findDocumentRowByInvoice(invoiceNo) {
  return findDocumentRows().find((tr) => (tr.innerText || '').includes(invoiceNo)) || null;
}

function dispatchMouseSequence(node) {
  if (!node) return false;
  const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  for (const type of events) {
    node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  return true;
}

function getDocumentRowClickCandidates(tr) {
  const firstCell = tr.querySelector('td');
  return [
    firstCell?.querySelector('[role="button"]'),
    firstCell?.querySelector('button'),
    firstCell?.querySelector('a'),
    firstCell?.querySelector('span'),
    firstCell,
    tr
  ].filter(Boolean);
}

function clickInvoiceInDocumentRow(tr) {
  for (const candidate of getDocumentRowClickCandidates(tr)) {
    if (dispatchMouseSequence(candidate)) return;
  }
  throw new Error('Klikací element faktury nenalezen.');
}

function extractRowsFromDocumentsTable() {
  return findDocumentRows().map((tr) => {
    const tds = tr.querySelectorAll('td');
    if (tds.length < 2) return null;

    const invoiceNo = digits((tds[0].innerText || '').trim());
    const orderLink = tds[1].querySelector('a[title]');
    const orderNo = digits(orderLink?.getAttribute('title') || '');

    return invoiceNo && orderNo ? { invoiceNo, orderNo, documentId: null, pdfUrl: null, isdocOptionsUrl: null } : null;
  }).filter(Boolean);
}

function getReactFiber(node) {
        if (!node) return null;
        const key = Object.keys(node).find((item) => item.startsWith('__reactFiber$'));
        return key ? node[key] : null;
      }

      function getInvoiceButton(card) {
        const candidates = Array.from(card.querySelectorAll('span[role="button"], span, a, button, div'));
        return candidates.find((el) => /^Faktura\s+\d+/i.test((el.textContent || '').trim()));
      }

      function findCardByInvoice(invoiceNo) {
        return findArchiveItems().find((card) => (card.textContent || '').includes(invoiceNo)) || null;
      }

      function getAttachmentContext(invoiceNo) {
        const card = findCardByInvoice(invoiceNo);
        const invoiceButton = card ? getInvoiceButton(card) : null;
        let fiber = getReactFiber(invoiceButton);
        for (let i = 0; i < 12 && fiber; i++) {
          const attachments = fiber.memoizedProps?.attachments;
          const processAction = fiber.memoizedProps?.processAction;
          if (Array.isArray(attachments) && attachments.length > 0) {
            return { attachment: attachments[0], processAction };
          }
          fiber = fiber.return;
        }
        return null;
      }

      function emit(detail) {
        window.dispatchEvent(new CustomEvent('ALZA_PAGE_ISDOC_RESULT', { detail }));
      }

      function matchesAttachmentUrl(url) {
        return typeof url === 'string' && /\/api\/invoices\/v1\/attachment\//.test(url);
      }

      function findAttachmentHrefInValue(value) {
        if (!value) return null;
        if (typeof value === 'string') return matchesAttachmentUrl(value) ? value : null;
        if (Array.isArray(value)) {
          for (const item of value) {
            const found = findAttachmentHrefInValue(item);
            if (found) return found;
          }
          return null;
        }
        if (typeof value === 'object') {
          for (const nested of Object.values(value)) {
            const found = findAttachmentHrefInValue(nested);
            if (found) return found;
          }
        }
        return null;
      }

      function parseOptionsPayload(data) {
        if (!data?.downloadOptions) return null;
        const pdf = (data.downloadOptions || []).find((item) => (item?.name || '').toUpperCase() === 'PDF');
        const isdoc = (data.downloadOptions || []).find((item) => (item?.name || '').toUpperCase() === 'ISDOC');
        const isdocOptionsUrl = isdoc?.onActionClick?.href || null;
        const documentId = (() => {
          try {
            return isdocOptionsUrl ? new URL(isdocOptionsUrl).searchParams.get('documentIds') : null;
          } catch {
            return null;
          }
        })();
        return {
          ok: true,
          pdfUrl: pdf?.onActionClick?.href || pdf?.href || null,
          isdocOptionsUrl,
          documentId
        };
      }

      async function runResolveOptions(detail) {
        const { requestId, invoiceNo } = detail || {};
        const row = findDocumentRowByInvoice(invoiceNo);
        if (!row) {
          emit({ requestId, ok: false, error: 'Řádek dokumentu nebyl nalezen.' });
          return;
        }

        const originalFetch = window.fetch;
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        let resolved = false;
        const finish = (payload) => {
          if (resolved) return;
          resolved = true;
          emit({ requestId, ...payload });
        };

        const inspectText = (text) => {
          try {
            const data = text ? JSON.parse(text) : null;
            const parsed = parseOptionsPayload(data);
            if (parsed) finish(parsed);
          } catch {}
        };

        window.fetch = async (...args) => {
          const response = await originalFetch(...args);
          try {
            const clone = response.clone();
            inspectText(await clone.text());
          } catch {}
          return response;
        };

        XMLHttpRequest.prototype.open = function(...args) {
          this.__alzaUrl = args[1];
          return originalOpen.apply(this, args);
        };

        XMLHttpRequest.prototype.send = function(...args) {
          this.addEventListener('load', function() {
            try {
              inspectText(this.responseText);
            } catch {}
          }, { once: true });
          return originalSend.apply(this, args);
        };

        try {
          clickInvoiceInDocumentRow(row);
          setTimeout(() => finish({ ok: false, error: 'Options endpoint se neodchytil po otevření modalu.' }), 7000);
        } catch (error) {
          finish({ ok: false, error: error?.message || 'Vyvolání options selhalo.' });
        } finally {
          setTimeout(() => {
            window.fetch = originalFetch;
            XMLHttpRequest.prototype.open = originalOpen;
            XMLHttpRequest.prototype.send = originalSend;
          }, 7500);
        }
      }

      async function runIsdoc(detail) {
        const { requestId, invoiceNo } = detail || {};
        const context = getAttachmentContext(invoiceNo);
        if (!context?.attachment?.isdocAction || typeof context.processAction !== 'function') {
          emit({ requestId, ok: false, error: 'ISDOC processAction kontext nenalezen.' });
          return;
        }

        let resolved = false;
        const finish = (payload) => {
          if (resolved) return;
          resolved = true;
          emit({ requestId, ...payload });
        };

        const originalFetch = window.fetch;
        const originalOpen = window.open;
        const originalAnchorClick = HTMLAnchorElement.prototype.click;

        window.fetch = async (...args) => {
          const response = await originalFetch(...args);
          try {
            const clone = response.clone();
            const text = await clone.text();
            const href = matchesAttachmentUrl(response.url) ? response.url : findAttachmentHrefInValue(text);
            if (href) finish({ ok: true, attachmentUrl: href });
          } catch {}
          return response;
        };

        window.open = function(url, ...rest) {
          if (matchesAttachmentUrl(url)) finish({ ok: true, attachmentUrl: url });
          return originalOpen.call(this, url, ...rest);
        };

        HTMLAnchorElement.prototype.click = function(...args) {
          try {
            if (matchesAttachmentUrl(this.href)) finish({ ok: true, attachmentUrl: this.href });
          } catch {}
          return originalAnchorClick.apply(this, args);
        };

        try {
          const result = await context.processAction(context.attachment.isdocAction);
          const href = findAttachmentHrefInValue(result);
          if (href) finish({ ok: true, attachmentUrl: href });
          setTimeout(() => finish({ ok: false, error: 'ISDOC page action nevrátil attachment URL.' }), 4000);
        } catch (error) {
          finish({ ok: false, error: error?.message || 'ISDOC page action failed' });
        } finally {
          setTimeout(() => {
            window.fetch = originalFetch;
            window.open = originalOpen;
            HTMLAnchorElement.prototype.click = originalAnchorClick;
          }, 4500);
        }
      }

      window.addEventListener('ALZA_PAGE_RUN_ISDOC', (event) => {
        runIsdoc(event.detail);
      });

      window.addEventListener('ALZA_PAGE_RESOLVE_OPTIONS', (event) => {
        runResolveOptions(event.detail);
      });
    })();
  `;

  (document.documentElement || document.head || document.body).appendChild(script);
  script.remove();
}

function resolveOptionsViaPage(invoiceNo) {
  return new Promise((resolve, reject) => {
    const requestId = `options-${Date.now()}-${++pageRequestSeq}`;
    const timer = setTimeout(() => {
      pageResolvers.delete(requestId);
      reject(new Error('Page options bridge timeout.'));
    }, 7000);

    pageResolvers.set(requestId, (result) => {
      clearTimeout(timer);
      pageResolvers.delete(requestId);
      if (result?.ok) resolve(result);
      else reject(new Error(result?.error || 'Page bridge nevrátil options data.'));
    });

    window.dispatchEvent(new CustomEvent('ALZA_PAGE_RESOLVE_OPTIONS', {
      detail: { requestId, invoiceNo }
    }));
  });
}

function resolveIsdocAttachmentViaPage(invoiceNo) {
  return new Promise((resolve, reject) => {
    const requestId = `page-${Date.now()}-${++pageRequestSeq}`;
    const timer = setTimeout(() => {
      pageResolvers.delete(requestId);
      reject(new Error('Page ISDOC bridge timeout.'));
    }, 7000);

    pageResolvers.set(requestId, (result) => {
      clearTimeout(timer);
      pageResolvers.delete(requestId);
      if (result?.ok && result?.attachmentUrl) resolve(result.attachmentUrl);
      else reject(new Error(result?.error || 'Page bridge nevrátil attachment URL.'));
    });

    window.dispatchEvent(new CustomEvent('ALZA_PAGE_RUN_ISDOC', {
      detail: { requestId, invoiceNo }
    }));
  });
}

function formatApiStatus(apiStatus) {
  if (!apiStatus?.checkedAt) return `<span class="pill mid">API: NEOVĚŘENO</span>`;
  const cls = apiStatus.connected ? "ok" : "bad";
  const label = apiStatus.connected ? "API: OK" : "API: OFF";
  return `<span class="pill ${cls}" title="${apiStatus?.message || ""}">${label}</span>`;
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
      <div id="alzaSbApiStatus" class="alzaSbStatus">API: -</div>
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

function setApiStatus(apiStatus) {
  const el = document.getElementById('alzaSbApiStatus');
  if (!el) return;
  const checked = apiStatus?.checkedAt ? new Date(apiStatus.checkedAt).toLocaleTimeString() : '-';
  el.innerHTML = `${formatApiStatus(apiStatus)} <span style="opacity:.8">${apiStatus?.message || 'Neověřeno.'} • ${checked}</span>`;
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
  setApiStatus(state.apiStatus);

  list.innerHTML = state.rows.map((row) => {
    const rec = done[row.invoiceNo] || {};
    const isActive = active && active.invoiceNo === row.invoiceNo;
    const error = rec.lastError ? `<div class="alzaSbRowErr">Error: ${rec.lastError}</div>` : '';
    const activeTag = isActive ? `<span class="pill mid">ACTIVE: ${active.mode}</span>` : '';
    const serverPaths = `
      PDF server: ${rec?.pdfServerPath || '-'}<br>
      ISDOC server: ${rec?.isdocServerPath || '-'}<br>
      PDF URL: ${row.pdfUrl ? 'ANO' : 'NE'}<br>
      ISDOC options: ${row.isdocOptionsUrl ? 'ANO' : 'NE'}<br>
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
        const rowEl = findRowElementByInvoice(inv);
        if (rowEl) rowEl.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
    });
  });
}

async function attachRows() {
  ensureSidebar();
  let rows = extractRows();

  if (!rows.some((row) => row.pdfUrl || row.isdocOptionsUrl)) {
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      rows = extractRows();
      if (rows.some((row) => row.pdfUrl || row.isdocOptionsUrl)) break;
    }
  }

  await chrome.runtime.sendMessage({ type: 'ALZA_ATTACH', rows });
  await chrome.runtime.sendMessage({ type: 'ALZA_PING_UPLOAD_API' });
  const response = await chrome.runtime.sendMessage({ type: 'ALZA_GET_STATE' });
  if (response?.ok) renderList(response.state);
}

window.addEventListener('ALZA_PAGE_ISDOC_RESULT', (event) => {
  const detail = event.detail || {};
  const resolver = pageResolvers.get(detail.requestId);
  if (resolver) resolver(detail);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'ALZA_STATUS') {
    ensureSidebar();
    setStatusText(msg.text);
  }
  if (msg?.type === 'ALZA_STATE') {
    ensureSidebar();
    renderList(msg.state);
  }
  if (msg?.type === 'ALZA_RESOLVE_ROW_OPTIONS') {
    resolveOptionsViaPage(msg.invoiceNo)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || 'Options page bridge failed' }));
    return true;
  }
  if (msg?.type === 'ALZA_RESOLVE_ISDOC_ATTACHMENT') {
    resolveIsdocAttachmentViaPage(msg.invoiceNo)
      .then((attachmentUrl) => sendResponse({ ok: true, attachmentUrl }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || 'ISDOC page bridge failed' }));
    return true;
  }
  return false;
});

(function init() {
  if (!location.href.includes('orders') && !location.href.includes('documents')) return;
  injectPageBridge();
  attachRows().catch(() => {});
})();
