const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const digits = (s) => (s || "").replace(/[^\d]/g, "");
const pageResolvers = new Map();
let pageRequestSeq = 0;
let autoStartTriggered = false;
let autoStartAttempted = false;
let autoRefreshTimer = null;
let accountCycleTimer = null;
let accountCycleBusy = false;
let queueEmptyRedirectStarted = false;
let sidebarCycleTimer = null;
let sidebarCycleRefreshBusy = false;

const ACCOUNT_CYCLE_STATE_KEY = "alzaAccountCycleStateV1";
const ACCOUNT_CYCLE_CONFIG_KEY = "alzaAccountCycleConfigV1";
const ALZA_DOCUMENTS_ORIGIN = "https://www.alza.cz";
const DEFAULT_ACCOUNT_PAUSE_MS = 10 * 1000;
const DEFAULT_ROUND_PAUSE_MS = 60 * 1000;

function normalizeAccountRecord(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      sessionId: String(value.sessionId || "").trim().toLowerCase(),
      email: String(value.email || "").trim().toLowerCase(),
      name: String(value.name || "").trim()
    };
  }
  return {
    sessionId: "",
    email: String(value || "").trim().toLowerCase(),
    name: ""
  };
}

function normalizeAccountRecordList(values = []) {
  return values
    .map((value) => normalizeAccountRecord(value))
    .filter((account) => account.email || account.sessionId);
}

function getAccountKey(account) {
  const normalized = normalizeAccountRecord(account);
  return normalized.email || normalized.sessionId;
}

function getAccountEmail(account) {
  return normalizeAccountRecord(account).email;
}

function getAccountLabel(account) {
  const normalized = normalizeAccountRecord(account);
  return normalized.email || normalized.name || normalized.sessionId;
}

function mergeAccountRecords(existingAccounts = [], discoveredAccounts = []) {
  const merged = [];
  const byKey = new Map();

  for (const rawAccount of [...existingAccounts, ...discoveredAccounts]) {
    const account = normalizeAccountRecord(rawAccount);
    const key = getAccountKey(account);
    if (!key) continue;

    if (!byKey.has(key)) {
      const copy = { ...account };
      byKey.set(key, copy);
      merged.push(copy);
      continue;
    }

    const current = byKey.get(key);
    if (!current.sessionId && account.sessionId) current.sessionId = account.sessionId;
    if (!current.email && account.email) current.email = account.email;
    if (!current.name && account.name) current.name = account.name;
  }

  return merged;
}

function sortAccountRecords(accounts = []) {
  return [...normalizeAccountRecordList(accounts)].sort((a, b) => {
    const keyA = getAccountEmail(a) || getAccountKey(a);
    const keyB = getAccountEmail(b) || getAccountKey(b);
    return keyA.localeCompare(keyB);
  });
}

async function getSwitcherDiscoveredCycleConfig(baseConfig = null) {
  const discoveredAccounts = getAccountRecordsFromSwitcher();
  const accounts = baseConfig?.accounts?.length
    ? mergeAccountRecords(baseConfig.accounts, discoveredAccounts)
    : normalizeAccountRecordList(discoveredAccounts);
  if (!accounts.length) return null;
  const config = {
    accounts,
    accountPauseMs: baseConfig?.accountPauseMs || DEFAULT_ACCOUNT_PAUSE_MS,
    roundPauseMs: baseConfig?.roundPauseMs || DEFAULT_ROUND_PAUSE_MS
  };
  await persistAccountCycleConfig(config);
  return config;
}

function getAutoStartMode() {
  const params = new URLSearchParams(location.search);
  const enabled = params.get("alzaAutoStart");
  if (!enabled || enabled === "0" || enabled.toLowerCase() === "false") return null;

  const mode = (params.get("alzaAutoMode") || "both").toLowerCase();
  return mode === "isdoc" ? "isdoc" : "both";
}


async function getStoredAccountCycleConfig() {
  try {
    const stored = await chrome.storage.local.get(ACCOUNT_CYCLE_CONFIG_KEY);
    const config = stored?.[ACCOUNT_CYCLE_CONFIG_KEY];
    if (!config || !Array.isArray(config.accounts) || !config.accounts.length) return null;
    const accounts = normalizeAccountRecordList(config.accounts);
    if (!accounts.length) return null;
    const roundPauseMs = Number.isFinite(config.roundPauseMs) && config.roundPauseMs > 0
      ? config.roundPauseMs
      : (Number.isFinite(config.pauseMs) && config.pauseMs > 0 ? config.pauseMs : DEFAULT_ROUND_PAUSE_MS);
    const accountPauseMs = Number.isFinite(config.accountPauseMs) && config.accountPauseMs > 0 ? config.accountPauseMs : DEFAULT_ACCOUNT_PAUSE_MS;
    return { accounts, accountPauseMs, roundPauseMs };
  } catch {
    return null;
  }
}

async function persistAccountCycleConfig(config) {
  try {
    if (!config?.accounts?.length) {
      await chrome.storage.local.remove(ACCOUNT_CYCLE_CONFIG_KEY);
      return;
    }
    await chrome.storage.local.set({
      [ACCOUNT_CYCLE_CONFIG_KEY]: {
        accounts: normalizeAccountRecordList(config.accounts),
        accountPauseMs: config.accountPauseMs,
        roundPauseMs: config.roundPauseMs
      }
    });
  } catch {}
}

async function getStoredCycleState(config) {
  try {
    const stored = await chrome.storage.local.get(ACCOUNT_CYCLE_STATE_KEY);
    const state = stored?.[ACCOUNT_CYCLE_STATE_KEY];
    if (!state || typeof state !== "object") return null;
    const index = Number.isInteger(state.index) ? state.index : 0;
    const completedAccounts = Array.isArray(state.completedAccounts)
      ? state.completedAccounts.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
      : [];
    const checkedAccounts = Array.isArray(state.checkedAccounts)
      ? state.checkedAccounts.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
      : [];
    return {
      index: ((index % config.accounts.length) + config.accounts.length) % config.accounts.length,
      phase: typeof state.phase === "string" ? state.phase : "ensure-account",
      waitUntil: Number.isFinite(state.waitUntil) ? state.waitUntil : 0,
      lastQueueIdleAt: Number.isFinite(state.lastQueueIdleAt) ? state.lastQueueIdleAt : 0,
      completedAccounts,
      checkedAccounts,
      roundComplete: !!state.roundComplete
    };
  } catch {
    return null;
  }
}

async function persistCycleState(state) {
  try {
    await chrome.storage.local.set({
      [ACCOUNT_CYCLE_STATE_KEY]: state
    });
  } catch {}
}

function getAutoRefreshIntervalMs() {
  const params = new URLSearchParams(location.search);
  const raw = Number.parseInt(params.get("alzaRefreshMinutes") || "10", 10);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : 10;
  return minutes * 60 * 1000;
}

async function getAccountCycleConfig() {
  const params = new URLSearchParams(location.search);
  const paramAccounts = (params.get("alzaAccounts") || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const storedConfig = await getStoredAccountCycleConfig();

  if (paramAccounts.length) {
    const rawPause = Number.parseInt(params.get("alzaCyclePauseMinutes") || String(DEFAULT_ROUND_PAUSE_MS / 60000), 10);
    const pauseMinutes = Number.isFinite(rawPause) && rawPause > 0 ? rawPause : (DEFAULT_ROUND_PAUSE_MS / 60000);
    const rawAccountPause = Number.parseInt(params.get("alzaAccountPauseSeconds") || String(DEFAULT_ACCOUNT_PAUSE_MS / 1000), 10);
    const accountPauseSeconds = Number.isFinite(rawAccountPause) && rawAccountPause > 0 ? rawAccountPause : (DEFAULT_ACCOUNT_PAUSE_MS / 1000);
    const accounts = mergeAccountRecords(storedConfig?.accounts || [], paramAccounts);
    const config = {
      accounts,
      accountPauseMs: accountPauseSeconds * 1000,
      roundPauseMs: pauseMinutes * 60 * 1000
    };
    if (
      !storedConfig ||
      storedConfig.accountPauseMs !== config.accountPauseMs ||
      storedConfig.roundPauseMs !== config.roundPauseMs ||
      storedConfig.accounts.length !== config.accounts.length ||
      storedConfig.accounts.some((account, index) => getAccountKey(account) !== getAccountKey(config.accounts[index]))
    ) {
      await persistAccountCycleConfig(config);
    }
    return config;
  }

  if (isAccountSwitcherPage() && !storedConfig) {
    return await getSwitcherDiscoveredCycleConfig(null);
  }

  return storedConfig;
}

function isDocumentsPage() {
  return location.pathname.includes("/my-account/documents.htm");
}

function isAccountSwitcherPage() {
  const href = location.href.toLowerCase();
  const host = location.host.toLowerCase();
  const path = location.pathname.toLowerCase();
  return (
    href.includes("prompt=select_account") ||
    href.includes("prompt%3dselect_account") ||
    href.includes("/external/login") ||
    (host.includes("identity.alza.cz") && path.includes("/account/select")) ||
    !!document.querySelector(".account-box[data-sessionid], .account-box.active")
  );
}

function buildDocumentsUrlForCycle(config = null) {
  const url = new URL("/my-account/documents.htm", ALZA_DOCUMENTS_ORIGIN);
  url.searchParams.set("alzaAutoStart", "1");
  url.searchParams.set("alzaAutoMode", "both");
  if (config?.accounts?.length) {
    url.searchParams.set("alzaAccounts", config.accounts.map((account) => getAccountEmail(account)).filter(Boolean).join(","));
    url.searchParams.set("alzaCyclePauseMinutes", String(Math.max(Math.round(config.roundPauseMs / 60000), 1)));
    url.searchParams.set("alzaAccountPauseSeconds", String(Math.max(Math.round(config.accountPauseMs / 1000), 1)));
  }
  return url.toString();
}

function buildAccountSwitcherUrl() {
  const url = new URL("https://identity.alza.cz/account/select");
  url.searchParams.set("returnUrl", "/");
  return url.toString();
}

function decodeHtmlEntities(value) {
  if (!value || typeof value !== "string") return "";
  const textarea = document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value;
}

function getHeaderHydrationSelectAccountUrl() {
  const marker = document.querySelector("script[data-component='header'][data-initialstate]");
  const raw = marker?.getAttribute("data-initialstate");
  if (!raw) return null;

  try {
    const decoded = decodeHtmlEntities(raw);
    const parsed = JSON.parse(decoded);
    const webLink = parsed?.header?.mainNavigation?.selectAccount?.webLink;
    return typeof webLink === "string" && webLink ? webLink : null;
  } catch {
    const decoded = decodeHtmlEntities(raw);
    const match = decoded.match(/"selectAccount":\{.*?"webLink":"([^"]+)"/);
    return match?.[1] || null;
  }
}

async function getCycleState(config) {
  const defaults = {
    index: 0,
    phase: "ensure-account",
    waitUntil: 0,
    lastQueueIdleAt: 0,
    completedAccounts: [],
    checkedAccounts: [],
    roundComplete: false
  };

  try {
    const stored = JSON.parse(sessionStorage.getItem(ACCOUNT_CYCLE_STATE_KEY) || "null");
    if (stored && typeof stored === "object") {
      const index = Number.isInteger(stored.index) ? stored.index : 0;
      return {
        ...defaults,
        ...stored,
        index: ((index % config.accounts.length) + config.accounts.length) % config.accounts.length
      };
    }
  } catch {
    // ignore and fall back to extension storage
  }

  const persisted = await getStoredCycleState(config);
  if (!persisted) return defaults;
  sessionStorage.setItem(ACCOUNT_CYCLE_STATE_KEY, JSON.stringify(persisted));
  return { ...defaults, ...persisted };
}

async function setCycleState(config, patch) {
  const next = { ...(await getCycleState(config)), ...patch };
  sessionStorage.setItem(ACCOUNT_CYCLE_STATE_KEY, JSON.stringify(next));
  await persistCycleState(next);
  return next;
}

async function getTargetAccountEmail(config) {
  const state = await getCycleState(config);
  return getAccountEmail(config.accounts[state.index] || config.accounts[0]);
}

async function getTargetAccount(config) {
  const state = await getCycleState(config);
  return normalizeAccountRecord(config.accounts[state.index] || config.accounts[0]);
}

async function advanceCycleIndex(config) {
  const current = await getCycleState(config);
  const nextIndex = (current.index + 1) % config.accounts.length;
  const wrapped = nextIndex === 0;
  return await setCycleState(config, {
    index: nextIndex,
    phase: "ensure-account",
    waitUntil: Date.now() + (wrapped ? config.roundPauseMs : config.accountPauseMs),
    lastQueueIdleAt: 0,
    completedAccounts: wrapped ? [] : current.completedAccounts || [],
    checkedAccounts: wrapped ? [] : current.checkedAccounts || [],
    roundComplete: wrapped
  });
}

async function completeCurrentAccountAndAdvance(config, currentAccount) {
  const normalizedCurrent = getAccountKey(currentAccount);
  const current = await getCycleState(config);
  const completedAccounts = Array.from(new Set([
    ...(current.completedAccounts || []),
    normalizedCurrent
  ].filter(Boolean)));
  const checkedAccounts = Array.from(new Set([
    ...(current.checkedAccounts || []),
    normalizedCurrent
  ].filter(Boolean)));
  const nextIndex = config.accounts.findIndex((account) => !completedAccounts.includes(getAccountKey(account)));

  if (nextIndex >= 0) {
    return await setCycleState(config, {
      index: nextIndex,
      phase: "ensure-account",
      waitUntil: Date.now() + config.accountPauseMs,
      lastQueueIdleAt: 0,
      completedAccounts,
      checkedAccounts,
      roundComplete: false
    });
  }

  return await setCycleState(config, {
    index: 0,
    phase: "ensure-account",
    waitUntil: Date.now() + config.roundPauseMs,
    lastQueueIdleAt: 0,
    completedAccounts,
    checkedAccounts: [],
    roundComplete: true
  });
}

function findHeaderContextMenuToggle() {
  return (
    document.querySelector("[data-testid='headerContextMenuToggle']") ||
    document.querySelector("button[data-testid='headerContextMenuToggle']") ||
    document.querySelector("[data-testid='headerContextMenuToggleTitle']")?.closest("button") ||
    document.querySelector("[data-testid='headerContextMenuToggleAvatar']")?.closest("button")
  );
}

function findSelectAccountLink() {
  return document.querySelector("[data-testid='headerNavigationSelectAccount']");
}

async function ensureHeaderMenuOpen() {
  const existing = findSelectAccountLink();
  if (existing) return true;

  const toggle = findHeaderContextMenuToggle();
  if (!toggle) return false;

  toggle.click();
  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (findSelectAccountLink()) return true;
    await sleep(100);
  }
  return false;
}

function getAccountSwitcherBoxes() {
  return Array.from(document.querySelectorAll(".account-box[data-sessionid], a .account-box, .account-box.active"));
}

function getAccountBoxSessionId(box) {
  return String(box?.getAttribute?.("data-sessionid") || "").trim().toLowerCase();
}

function getAccountBoxName(box) {
  return (box?.querySelector(".user-info--name")?.textContent || "").trim();
}

function getAccountRecordsFromSwitcher() {
  const seen = new Set();
  return getAccountSwitcherBoxes()
    .map((box) => ({
      sessionId: getAccountBoxSessionId(box),
      email: getAccountBoxEmail(box),
      name: getAccountBoxName(box)
    }))
    .filter((account) => {
      const key = getAccountKey(account);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getAccountBoxEmail(box) {
  if (!box) return "";
  return (
    box.querySelector(".user-info--email")?.textContent ||
    box.querySelector("[data-testid='headerUserLogin']")?.textContent ||
    ""
  ).trim().toLowerCase();
}

function getActiveAccountBox() {
  return document.querySelector(".account-box.active") || null;
}

function getCurrentDocumentsPageAccount() {
  const email = (
    document.querySelector("[data-testid='headerUserLogin']")?.textContent ||
    document.querySelector("header .user-info--email")?.textContent ||
    ""
  ).trim().toLowerCase();

  if (!email) return null;
  return normalizeAccountRecord({ email });
}

function findAccountSwitchBox(account) {
  const normalized = normalizeAccountRecord(account);
  if (!normalized.email) return null;

  const boxes = getAccountSwitcherBoxes();
  return boxes.find((box) => {
    return normalized.email && getAccountBoxEmail(box) === normalized.email;
  });
}

function clickAccountSwitchBox(account) {
  const targetBox = findAccountSwitchBox(account);
  if (!(targetBox instanceof HTMLElement)) return false;

  targetBox.scrollIntoView({ block: "center", inline: "nearest" });
  targetBox.click();
  return true;
}

function getNextNonActiveAccountBox() {
  const boxes = getAccountSwitcherBoxes()
    .filter((box) => box.matches?.(".account-box[data-sessionid], .account-box.active"));
  const activeBox = getActiveAccountBox();
  const activeIndex = boxes.findIndex((box) => box === activeBox);
  return (
    (activeIndex >= 0 ? boxes.slice(activeIndex + 1).find((box) => !box.classList.contains("active")) : null) ||
    boxes.find((box) => !box.classList.contains("active")) ||
    null
  );
}

function isTargetAccountAlreadyActive(account) {
  const normalized = normalizeAccountRecord(account);
  const activeBox = getActiveAccountBox();
  if (!activeBox) return false;
  return !!normalized.email && getAccountBoxEmail(activeBox) === normalized.email;
}

async function syncCycleConfigWithSwitcherAccounts(config) {
  if (!config) return config;

  const discoveredAccounts = getAccountRecordsFromSwitcher();
  if (!discoveredAccounts.length) return config;

  const cycleState = await getCycleState(config);
  const currentAccounts = normalizeAccountRecordList(Array.isArray(config.accounts) ? config.accounts : []);
  const currentTargetKey = getAccountKey(currentAccounts[cycleState.index] || currentAccounts[0]);
  const authoritativeAccounts = mergeAccountRecords(currentAccounts, discoveredAccounts);
  const changed = (
    authoritativeAccounts.length !== currentAccounts.length ||
    authoritativeAccounts.some((account, index) => getAccountKey(account) !== getAccountKey(currentAccounts[index]))
  );
  const nextConfig = {
    ...config,
    accounts: authoritativeAccounts
  };

  if (changed) {
    await persistAccountCycleConfig(nextConfig);
    if (currentTargetKey) {
      const preservedIndex = authoritativeAccounts.findIndex((account) => getAccountKey(account) === currentTargetKey);
      if (preservedIndex >= 0 && preservedIndex !== cycleState.index) {
        await setCycleState(nextConfig, {
          index: preservedIndex,
          waitUntil: cycleState.waitUntil || 0,
          lastQueueIdleAt: cycleState.lastQueueIdleAt || 0
        });
      }
    }
  }
  return nextConfig;
}

async function navigateToAccountSwitcher(config = null) {
  if (config) {
    await setCycleState(config, { phase: "opening-switcher" });
  }
  const hydratedUrl = getHeaderHydrationSelectAccountUrl();
  if (hydratedUrl) {
    location.href = hydratedUrl;
    return true;
  }

  if (await ensureHeaderMenuOpen()) {
    const link = findSelectAccountLink();
    if (link) {
      link.click();
      return true;
    }
  }
  throw new Error("Nepodařilo se otevřít header menu nebo najít odkaz Přepnout účet.");
}

async function selectTargetAccount(config = null) {
  const start = Date.now();
  let targetAccount = config ? await getTargetAccount(config) : null;
  while (Date.now() - start < 15000) {
    if (targetAccount && isTargetAccountAlreadyActive(targetAccount)) {
      if (config) {
        await setCycleState(config, { phase: "await-documents", waitUntil: 0, lastQueueIdleAt: 0 });
      }
      return true;
    }

    if (targetAccount && clickAccountSwitchBox(targetAccount)) {
      if (config) {
        await setCycleState(config, {
          phase: "await-documents",
          waitUntil: Date.now() + 10000,
          lastQueueIdleAt: 0,
          checkedAccounts: Array.from(new Set([
            ...((await getCycleState(config)).checkedAccounts || []),
            getAccountKey(targetAccount)
          ])),
          roundComplete: false
        });
      }
      return true;
    }

    await sleep(250);
  }

  throw new Error(targetAccount
    ? `Nepodařilo se najít cílový účet ${getAccountLabel(targetAccount)} ve switcheru.`
    : "Nepodařilo se najít další účet ve switcheru.");
}

async function redirectToDocumentsPageForCycle(config, reasonText = "otevírám stránku dokladů…") {
  const targetEmail = await getTargetAccountEmail(config);
  setStatusText(`${await formatCycleStatus(config, targetEmail)} • ${reasonText}`);
  location.href = buildDocumentsUrlForCycle(config);
}

async function syncCycleStateWithDocumentsAccount(config) {
  if (!isDocumentsPage()) {
    return {
      state: await getCycleState(config),
      activeAccount: null
    };
  }

  const activeAccount = getCurrentDocumentsPageAccount();
  let state = await getCycleState(config);
  if (!activeAccount) {
    return { state, activeAccount: null };
  }

  const matchedIndex = config.accounts.findIndex((account) => {
    const normalized = normalizeAccountRecord(account);
    return (
      (!!activeAccount.sessionId && normalized.sessionId === activeAccount.sessionId) ||
      (!!activeAccount.email && normalized.email === activeAccount.email)
    );
  });

  if (matchedIndex >= 0 && matchedIndex !== state.index) {
    state = await setCycleState(config, {
      index: matchedIndex,
      lastQueueIdleAt: 0
    });
  }

  return { state, activeAccount };
}

async function formatCycleStatus(config, targetEmail) {
  const state = await getCycleState(config);
  const position = `${state.index + 1}/${config.accounts.length}`;
  const waitMs = Math.max((state.waitUntil || 0) - Date.now(), 0);
  if (waitMs > 0) {
    return `Účet ${position}: ${targetEmail} • další krok za ${Math.ceil(waitMs / 1000)} s…`;
  }
  return `Účet ${position}: ${targetEmail}`;
}

function formatDurationMs(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getCyclePhaseLabel(phase) {
  switch (phase) {
    case "ensure-account": return "Připravuji přepnutí účtu";
    case "opening-switcher": return "Otevírám account switcher";
    case "await-documents": return "Čekám na doklady";
    case "processing": return "Zpracovávám frontu";
    default: return phase || "Neznámý stav";
  }
}

async function updateSidebarCycleInfo() {
  const panel = document.getElementById("alzaSbCycle");
  const summaryEl = document.getElementById("alzaSbCycleSummary");
  const metaEl = document.getElementById("alzaSbCycleMeta");
  if (!panel || !summaryEl || !metaEl || sidebarCycleRefreshBusy) return;

  sidebarCycleRefreshBusy = true;
  try {
    const config = await getAccountCycleConfig();
    if (!config?.accounts?.length) {
      panel.hidden = true;
      return;
    }

    const state = await getCycleState(config);
    const currentAccount = config.accounts[state.index] || config.accounts[0];
    const nextAccount = config.accounts[(state.index + 1) % config.accounts.length] || currentAccount;
    const currentLabel = getAccountEmail(currentAccount) || getAccountLabel(currentAccount);
    const nextLabel = getAccountEmail(nextAccount) || getAccountLabel(nextAccount);
    const remainingMs = Math.max((state.waitUntil || 0) - Date.now(), 0);
    const waitLabel = remainingMs > 0
      ? `${state.roundComplete ? "Další kolo" : "Další přepnutí"} za ${formatDurationMs(remainingMs)}`
      : "Bez čekání";

    panel.hidden = false;
    summaryEl.textContent = `Účet ${state.index + 1}/${config.accounts.length}: ${currentLabel}`;
    metaEl.innerHTML = `
      <span><strong>Fáze:</strong> ${getCyclePhaseLabel(state.phase)}</span>
      <span><strong>Countdown:</strong> ${waitLabel}</span>
      <span><strong>Další účet:</strong> ${nextLabel}</span>
      <span><strong>Pauza mezi rundami:</strong> ${formatDurationMs(config.roundPauseMs)}</span>
    `;
  } catch {
    panel.hidden = true;
  } finally {
    sidebarCycleRefreshBusy = false;
  }
}

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

function matchesDownloadUrl(url, mode) {
  if (typeof url !== "string" || !url) return false;
  const lower = url.toLowerCase();
  if (mode === "pdf") return lower.includes("pdf.alza.cz") || lower.includes(".pdf");
  return lower.includes("/attachment/") || lower.includes(".isdoc");
}

function findDownloadUrlInValue(value, mode) {
  if (!value) return null;
  if (typeof value === "string") return matchesDownloadUrl(value, mode) ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDownloadUrlInValue(item, mode);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const nested of Object.values(value)) {
      const found = findDownloadUrlInValue(nested, mode);
      if (found) return found;
    }
  }
  return null;
}

function injectPageBridge() {
  if (document.getElementById("alzaPageBridge")) return;

  const script = document.createElement("script");
  script.id = "alzaPageBridge";
  script.src = chrome.runtime.getURL("page_bridge.js");
  script.onload = () => script.remove();
  (document.documentElement || document.head || document.body).appendChild(script);
}

async function captureDownloadUrl(mode, trigger, timeoutMs = 4000) {
  injectPageBridge();

  return await new Promise((resolve) => {
    const requestId = `download-url-${Date.now()}-${++pageRequestSeq}`;
    const timer = setTimeout(() => {
      pageResolvers.delete(requestId);
      resolve(null);
    }, timeoutMs + 500);

    pageResolvers.set(requestId, (payload) => {
      clearTimeout(timer);
      pageResolvers.delete(requestId);
      resolve(payload || { url: null });
    });

    window.dispatchEvent(new CustomEvent("ALZA_PAGE_CAPTURE_DOWNLOAD_URL", {
      detail: { requestId, mode, timeoutMs }
    }));

    Promise.resolve()
      .then(() => trigger())
      .catch(() => {
        clearTimeout(timer);
        pageResolvers.delete(requestId);
        resolve({ url: null });
      });
  });
}

async function clickDownloads(modal, mode) {
  const pdfBtn = findButtonByExactText(modal, "PDF");
  const isdocBtn = findButtonByExactText(modal, "ISDOC");
  if (!pdfBtn || !isdocBtn) throw new Error("Nenalezeno PDF/ISDOC tlačítko.");
  const result = { pdfDownloadUrl: null, isdocDownloadUrl: null, isdocDataUrl: null, isdocFilename: null };

  if (mode === "pdf" || mode === "both") {
    const pdfCapture = await captureDownloadUrl("pdf", () => pdfBtn.click());
    result.pdfDownloadUrl = pdfCapture?.url || null;
    await sleep(250);
    await closeDownloadStartedModal(await waitForDownloadStartedModal(8000));
  }

  if (mode === "isdoc" || mode === "both") {
    const isdocCapture = await captureDownloadUrl("isdoc", () => isdocBtn.click());
    result.isdocDownloadUrl = isdocCapture?.url || null;
    result.isdocDataUrl = isdocCapture?.dataUrl || null;
    result.isdocFilename = isdocCapture?.filename || null;
    await sleep(250);
    await closeDownloadStartedModal(await waitForDownloadStartedModal(8000));
  }

  return result;
}

function restoreScroll(savedY, tr) {
  window.scrollTo({ top: savedY, left: 0, behavior: "instant" });
  try { tr.scrollIntoView({ block: "center", inline: "nearest" }); } catch {}
}

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
        <button id="alzaSbResetCycle">Reset cycle</button>
      </div>
      <div id="alzaSbStatus" class="alzaSbStatus">-</div>
      <div id="alzaSbCycle" class="alzaSbCycle" hidden>
        <div id="alzaSbCycleSummary" class="alzaSbCycleSummary">-</div>
        <div id="alzaSbCycleMeta" class="alzaSbCycleMeta"></div>
      </div>
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
    .alzaSbCycle{
      margin-top:10px; padding:10px 12px; border-radius:12px;
      background:rgba(88,166,255,.12); border:1px solid rgba(88,166,255,.35);
    }
    .alzaSbCycleSummary{ font-size:13px; font-weight:700; margin-bottom:6px; }
    .alzaSbCycleMeta{ display:grid; gap:4px; color:#dbe9ff; }
    .alzaSbBody{ height:calc(100vh - 220px); overflow:auto; padding:10px; }
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

  document.getElementById("alzaSbResetCycle").addEventListener("click", async () => {
    await resetAccountCycleNow();
  });

  updateSidebarCycleInfo().catch(() => {});
  if (!sidebarCycleTimer) {
    sidebarCycleTimer = setInterval(() => {
      updateSidebarCycleInfo().catch(() => {});
    }, 1000);
  }
}

function setStatusText(t) {
  const el = document.getElementById("alzaSbStatus");
  if (el) el.textContent = t || "-";
  updateSidebarCycleInfo().catch(() => {});
}

function rowPills(rec) {
  const pdfClass = rec?.pdf ? "ok" : (rec?.lastError ? "bad" : "mid");
  const isdocClass = rec?.isdoc ? "ok" : (rec?.lastError ? "bad" : "mid");
  return `
    <span class="pill ${pdfClass}">PDF: ${rec?.pdf ? "OK" : "NO"}</span>
    <span class="pill ${isdocClass}">ISDOC: ${rec?.isdoc ? "OK" : "NO"}</span>
  `;
}

function rowLinks(rec, invoiceNo) {
  const pdf = rec?.pdfPath
    ? `<button data-act="openPdf" data-inv="${invoiceNo}">Otevřít PDF</button>`
    : `<button disabled title="PDF nenalezeno">Otevřít PDF</button>`;
  const isdoc = rec?.isdocPath
    ? `<button data-act="openIsdoc" data-inv="${invoiceNo}">Otevřít ISDOC</button>`
    : `<button disabled title="ISDOC nenalezen">Otevřít ISDOC</button>`;

  return `${pdf}${isdoc}`;
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
          ${rowLinks(rec, r.invoiceNo)}
          <button data-act="scroll" data-inv="${r.invoiceNo}">Scroll</button>
        </div>

        <div class="alzaSbRowErr" style="color:#bcd4ff;">
          ${rec?.pdfPath ? `PDF: ${rec.pdfPath}` : "PDF: -"}<br>
          ${rec?.isdocPath ? `ISDOC: ${rec.isdocPath}` : "ISDOC: -"}<br>
          ${rec?.pdfServerPath ? `PDF server: ${rec.pdfServerPath}` : "PDF server: -"}<br>
          ${rec?.isdocServerPath ? `ISDOC server: ${rec.isdocServerPath}` : "ISDOC server: -"}
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
      if (act === "openPdf") await chrome.runtime.sendMessage({ type: "ALZA_OPEN_DOWNLOADED", invoiceNo: inv, mode: "pdf" });
      if (act === "openIsdoc") await chrome.runtime.sendMessage({ type: "ALZA_OPEN_DOWNLOADED", invoiceNo: inv, mode: "isdoc" });
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
  if (resp?.ok) {
    renderList(resp.state);
    return { rows, state: resp.state };
  }
  return { rows, state: null };
}

async function autoStartIfRequested() {
  if (autoStartTriggered || autoStartAttempted) return;

  const mode = getAutoStartMode();
  if (!mode) return;

  autoStartAttempted = true;
  ensureSidebar();
  setStatusText("Autostart: čekám na načtení dokladů…");

  for (let attempt = 0; attempt < 90; attempt++) {
    const { rows } = await attachRows();
    if (rows.length > 0) {
      autoStartTriggered = true;
      setStatusText(`Autostart: spouštím ${mode === "isdoc" ? "ISDOC" : "PDF + ISDOC"} frontu…`);
      await chrome.runtime.sendMessage({ type: mode === "isdoc" ? "ALZA_START_ISDOC" : "ALZA_START_ALL" });
      return;
    }
    await sleep(1000);
  }

  setStatusText("Autostart: nepodařilo se načíst tabulku dokladů včas.");
}

function scheduleAutoRefreshIfRequested(accountCycleConfig = null) {
  if (autoRefreshTimer || !getAutoStartMode() || accountCycleConfig) return;

  const intervalMs = getAutoRefreshIntervalMs();
  autoRefreshTimer = setInterval(async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "ALZA_GET_STATE" });
      if (resp?.ok && resp.state?.running) {
        setStatusText("Autostart: fronta stále běží, obnovení seznamu odkládám.");
        return;
      }

      setStatusText("Autostart: obnovuji stránku kvůli novým dokladům…");
      location.reload();
    } catch (err) {
      setStatusText(`Autostart refresh selhal: ${err?.message || "neznámá chyba"}`);
    }
  }, intervalMs);
}

async function handleAccountCycleTick() {
  const config = await getAccountCycleConfig();
  if (!config || accountCycleBusy) return;

  accountCycleBusy = true;
  try {
    let cycleState = await getCycleState(config);
    if (cycleState.roundComplete && cycleState.waitUntil && Date.now() >= cycleState.waitUntil) {
      cycleState = await setCycleState(config, {
        index: 0,
        phase: "ensure-account",
        waitUntil: 0,
        lastQueueIdleAt: 0,
        completedAccounts: [],
        checkedAccounts: [],
        roundComplete: false
      });
    }
    let targetEmail = await getTargetAccountEmail(config);

    ensureSidebar();
    setStatusText(await formatCycleStatus(config, targetEmail));

    if (cycleState.waitUntil && Date.now() < cycleState.waitUntil) return;

    if (isAccountSwitcherPage()) {
      if (cycleState.phase === "await-documents") {
        const targetAccount = await getTargetAccount(config);
        if (isTargetAccountAlreadyActive(targetAccount)) {
          await redirectToDocumentsPageForCycle(config, "přepnutí potvrzeno, otevírám doklady…");
          return;
        }

        await setCycleState(config, { phase: "opening-switcher", waitUntil: 0, lastQueueIdleAt: 0 });
        setStatusText(`${await formatCycleStatus(config, targetEmail)} • přepnutí se nepotvrdilo, zkouším výběr znovu…`);
        await selectTargetAccount(config);
        return;
      }

      setStatusText(`${await formatCycleStatus(config, targetEmail)} • vybírám účet ve switcheru…`);
      await selectTargetAccount(config);
      return;
    }

    if (!isDocumentsPage()) {
      if (cycleState.phase === "await-documents" || cycleState.phase === "processing") {
        setStatusText(`${await formatCycleStatus(config, targetEmail)} • otevírám stránku dokladů…`);
        location.href = buildDocumentsUrlForCycle(config);
        return;
      }
      return;
    }

    const documentsAccountSync = await syncCycleStateWithDocumentsAccount(config);
    cycleState = documentsAccountSync.state;
    targetEmail = await getTargetAccountEmail(config);

    const resp = await chrome.runtime.sendMessage({ type: "ALZA_GET_STATE" });
    const bgState = resp?.ok ? resp.state : null;

    if (cycleState.phase === "ensure-account" || cycleState.phase === "opening-switcher") {
      setStatusText(`${await formatCycleStatus(config, targetEmail)} • otevírám account switcher…`);
      await navigateToAccountSwitcher(config);
      return;
    }

    if (cycleState.phase === "await-documents") {
      await setCycleState(config, { phase: "processing", waitUntil: 0, lastQueueIdleAt: 0 });
      autoStartAttempted = false;
      autoStartTriggered = false;
      setStatusText(`${await formatCycleStatus(config, targetEmail)} • spouštím autostart…`);
      await autoStartIfRequested();
      return;
    }

    if (cycleState.phase === "processing") {
      if (bgState?.running) {
        queueEmptyRedirectStarted = false;
        await setCycleState(config, { lastQueueIdleAt: 0 });
        setStatusText(`${await formatCycleStatus(config, targetEmail)} • fronta běží…`);
        return;
      }

      const current = await getCycleState(config);
      const idleAt = current.lastQueueIdleAt || Date.now();
      if (!current.lastQueueIdleAt) {
        await setCycleState(config, { lastQueueIdleAt: idleAt });
        const nextIndex = (current.index + 1) % config.accounts.length;
        const nextEmail = getAccountEmail(config.accounts[nextIndex]);
        setStatusText(`${await formatCycleStatus(config, targetEmail)} • vše staženo, jdu zkusit další účet ${nextEmail}…`);
        return;
      }

      if (Date.now() - idleAt < 15000) {
        const remaining = Math.max(1, Math.ceil((15000 - (Date.now() - idleAt)) / 1000));
        setStatusText(`${await formatCycleStatus(config, targetEmail)} • vše staženo, za ${remaining} s zkusím další účet…`);
        return;
      }

      const next = await completeCurrentAccountAndAdvance(
        config,
        documentsAccountSync.activeAccount || await getTargetAccount(config)
      );
      const nextEmail = getAccountEmail(config.accounts[next.index]);
      if (next.waitUntil && next.waitUntil > Date.now()) {
        setStatusText(`Účet ${targetEmail}: hotovo. Další účet ${nextEmail} zkusím za ${Math.ceil((next.waitUntil - Date.now()) / 1000)} s.`);
        return;
      }

      setStatusText(`Účet ${targetEmail}: hotovo. Přepínám na další účet ${nextEmail}…`);
      await navigateToAccountSwitcher(config);
      return;
    }
  } catch (err) {
    ensureSidebar();
    setStatusText(`Přepínání účtů selhalo: ${err?.message || "neznámá chyba"}`);
  } finally {
    accountCycleBusy = false;
  }
}

async function triggerAccountSwitchAfterQueueEmpty() {
  const config = await getAccountCycleConfig();
  if (config) return false;
  if (!isDocumentsPage() || queueEmptyRedirectStarted) return;

  queueEmptyRedirectStarted = true;
  accountCycleBusy = true;
  try {
    setStatusText("Queue prázdná. Otevírám přepnutí účtu bez uložené account konfigurace…");
    await navigateToAccountSwitcher(null);
  } catch (err) {
    queueEmptyRedirectStarted = false;
    ensureSidebar();
    setStatusText(`Přechod na další účet selhal: ${err?.message || "neznámá chyba"}`);
  } finally {
    accountCycleBusy = false;
  }
}

async function scheduleAccountCycleIfRequested() {
  const config = await getAccountCycleConfig();
  if (accountCycleTimer || !config) return;

  accountCycleTimer = setInterval(() => {
    handleAccountCycleTick().catch(() => {});
  }, 2000);

  handleAccountCycleTick().catch(() => {});
}

async function resetAccountCycleNow() {
  const config = await getAccountCycleConfig();
  if (!config) {
    ensureSidebar();
    setStatusText("Reset cyklu: není k dispozici uložená konfigurace účtů.");
    return;
  }

  queueEmptyRedirectStarted = false;
  accountCycleBusy = false;
  await setCycleState(config, {
    index: 0,
    phase: "ensure-account",
    waitUntil: 0,
    lastQueueIdleAt: 0,
    completedAccounts: [],
    checkedAccounts: [],
    roundComplete: false
  });

  ensureSidebar();
  setStatusText("Cyklus účtů resetován. Spouštím nové kolo okamžitě…");
  handleAccountCycleTick().catch((err) => {
    ensureSidebar();
    setStatusText(`Reset cyklu selhal: ${err?.message || "neznámá chyba"}`);
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "ALZA_STATUS") {
    ensureSidebar();
    setStatusText(msg.text);
    if (typeof msg.text === "string" && msg.text.startsWith("Queue prázdná")) {
      (async () => {
        const config = await getAccountCycleConfig();
        if (config) {
          queueEmptyRedirectStarted = false;
          return;
        }
        setStatusText("Queue prázdná. Zkouším otevřít přepnutí účtu…");
        triggerAccountSwitchAfterQueueEmpty().catch((err) => {
          ensureSidebar();
          setStatusText(`Přechod na další účet selhal: ${err?.message || "neznámá chyba"}`);
        });
      })().catch(() => {});
    }
  }
  if (msg?.type === "ALZA_STATE") {
    ensureSidebar();
    renderList(msg.state);
  }
  if (msg?.type === "ALZA_RUN_ROW") {
    (async () => {
      const { invoiceNo, mode, runId } = msg;

      const savedY = window.scrollY;
      const tr = findTrByInvoice(invoiceNo);
      if (!tr) throw new Error(`Řádek faktury ${invoiceNo} nenalezen.`);

      tr.scrollIntoView({ block: "center", inline: "nearest" });
      await sleep(150);

      clickInvoiceInTr(tr);
      const modal = await waitForFormatModal(15000);

      const downloadInfo = await clickDownloads(modal, mode);
      await closeFormatModal(modal);

      await sleep(100);
      restoreScroll(savedY, tr);
      await chrome.runtime.sendMessage({ type: "ALZA_RUN_ROW_RESULT", runId, ok: true, ...downloadInfo });
    })().catch(async (err) => {
      await chrome.runtime.sendMessage({
        type: "ALZA_RUN_ROW_RESULT",
        runId: msg.runId,
        ok: false,
        error: err?.message || "Execution failed"
      });
    });
  }
});

window.addEventListener("ALZA_PAGE_DOWNLOAD_URL_RESULT", (event) => {
  const detail = event.detail || {};
  const resolver = pageResolvers.get(detail.requestId);
  if (resolver) resolver(detail);
});

(async function init() {
  const accountCycleConfig = await getAccountCycleConfig();
  const onDocumentsPage = isDocumentsPage();
  const loginSuccess = new URLSearchParams(location.search).get("loginSuccess") === "1";

  if (loginSuccess && !onDocumentsPage) {
    location.href = buildDocumentsUrlForCycle(accountCycleConfig);
    return;
  }

  if (isAccountSwitcherPage() && !accountCycleConfig) {
    selectTargetAccount(null).catch((err) => {
      ensureSidebar();
      setStatusText(`Výběr dalšího účtu selhal: ${err?.message || "neznámá chyba"}`);
    });
    return;
  }

  if (!onDocumentsPage && !accountCycleConfig) return;

  if (accountCycleConfig) {
    ensureSidebar();
    await scheduleAccountCycleIfRequested();
  }

  if (!onDocumentsPage) return;

  injectPageBridge();
  attachRows().catch(() => {});
  scheduleAutoRefreshIfRequested(accountCycleConfig);
  if (accountCycleConfig) return;
  autoStartIfRequested().catch((err) => {
    ensureSidebar();
    setStatusText(`Autostart selhal: ${err?.message || "neznámá chyba"}`);
  });
})();
