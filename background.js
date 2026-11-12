// Alia runs entirely with tabs, storage, and contextMenus permissions.
// It intentionally does not inspect page DOM, form fields, or upload controls.

const STORAGE_KEYS = {
  tabState: "aliaTabState",
  domainHistory: "aliaDomainHistory",
  sensitiveDomains: "sensitiveDomains",
  suspensionStats: "aliaSuspensionStats",
};

const DEFAULT_SUSPEND_MS = 15 * 60 * 1000;
const DIM_AFTER_MS = 5 * 60 * 1000;
const SENSITIVE_RECENT_ACTIVITY_MS = 2 * 60 * 1000;
const EVALUATION_INTERVAL_MS = 60 * 1000;
const RETURN_HISTORY_LIMIT = 20;
const DEFAULT_STATS = {
  estimatedMemoryFreedMb: 0,
  totalSuspensions: 0,
  lastUpdatedAt: 0,
};

// Patterns are hostname suffixes, not URL substrings. User entries use the same format.
const BUILT_IN_SENSITIVE_DOMAINS = [
  "americanexpress.com", "bankofamerica.com", "capitalone.com", "chase.com",
  "citi.com", "discover.com", "paypal.com", "stripe.com", "wellsfargo.com",
  "accounts.google.com", "mail.google.com", "outlook.live.com", "outlook.office.com",
  "login.microsoftonline.com", "proton.me", "protonmail.com", "mail.yahoo.com",
  "kaiserpermanente.org", "mychart.com", "patientportal.com", "webmd.com",
  "cvs.com", "walgreens.com", "irs.gov", "ssa.gov", "usa.gov", "gov.uk",
  "passportindia.gov.in", "incometax.gov.in", "uidai.gov.in"
];

let lastActivatedTabId = null;
let evaluationTimer = null;

chrome.runtime.onInstalled.addListener(async () => {
  await initializeSensitiveDomains();
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "alia-toggle-sensitive-domain",
    title: "Mark tab as sensitive",
    contexts: ["page"],
  });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  await reconcileAndEvaluate();
  scheduleEvaluation();
});

chrome.runtime.onStartup.addListener(async () => {
  await initializeSensitiveDomains();
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  await reconcileAndEvaluate();
  scheduleEvaluation();
});

chrome.tabs.onCreated.addListener(async (tab) => {
  await ensureTabState(tab, Date.now());
  scheduleEvaluation();
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const now = Date.now();
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!tab || tab.id !== tabId) return;

  const data = await getStoredData();
  const state = data.tabState;

  if (lastActivatedTabId && lastActivatedTabId !== tabId && state[lastActivatedTabId]) {
    state[lastActivatedTabId].lastInactiveAt = now;
  }

  const tabRecord = state[tabId] || makeTabRecord(tab, now);
  if (tabRecord.lastInactiveAt && tabRecord.hostname) {
    addDomainReturn(data.domainHistory, tabRecord.hostname, now - tabRecord.lastInactiveAt, now);
  }

  // A secure placeholder deliberately never contains the real sensitive title or favicon.
  if (isSuspendedPlaceholder(tab.url)) {
    const originalUrl = getOriginalUrlFromPlaceholder(tab.url);
    if (originalUrl) {
      releaseMemoryEstimate(tabRecord, data.suspensionStats);
      await chrome.tabs.update(tabId, { url: originalUrl });
      state[tabId] = makeTabRecord({ ...tab, url: originalUrl }, now);
    }
  } else {
    const wasDiscardedByAlia = tabRecord.stage === "discarded";
    if (wasDiscardedByAlia) releaseMemoryEstimate(tabRecord, data.suspensionStats);
    state[tabId] = makeTabRecord(tab, now, tabRecord);
    if (wasDiscardedByAlia) {
      // Chrome normally restores discarded tabs on activation. Reload guarantees a fresh renderer.
      try {
        await chrome.tabs.reload(tabId);
      } catch (error) {
        console.debug("[Alia] Native discard restore is handling this tab.", error.message);
      }
    }
  }

  lastActivatedTabId = tabId;
  await saveStoredData(data);
  await updateActionState(tabId, "active", 0);
  await updateSensitiveContextMenuForTab(tab);
  await reconcileAndEvaluate();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.discarded === false && tab.active) {
    const data = await getStoredData();
    const current = data.tabState[tabId] || makeTabRecord(tab, Date.now());
    data.tabState[tabId] = makeTabRecord(tab, Date.now(), current);
    await saveStoredData(data);
  }

  if (changeInfo.status === "complete" && tab.active && !isSuspendedPlaceholder(tab.url)) {
    const data = await getStoredData();
    data.tabState[tabId] = makeTabRecord(tab, Date.now(), data.tabState[tabId]);
    await saveStoredData(data);
  }
  scheduleEvaluation();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const data = await getStoredData();
  if (data.tabState[tabId]) {
    releaseMemoryEstimate(data.tabState[tabId], data.suspensionStats);
    delete data.tabState[tabId];
    await saveStoredData(data);
  }
});

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  const data = await getStoredData();
  if (data.tabState[removedTabId]) {
    data.tabState[addedTabId] = data.tabState[removedTabId];
    delete data.tabState[removedTabId];
    await saveStoredData(data);
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "alia-toggle-sensitive-domain") return;
  const hostname = hostnameFromUrl(info.pageUrl || (tab && tab.url));
  if (hostname) {
    await toggleSensitiveDomain(hostname);
    await updateSensitiveContextMenuForTab(tab);
  }
});

// Some Chrome channels omit onShown. The activation path below is the compatible fallback.
if (chrome.contextMenus.onShown) {
  chrome.contextMenus.onShown.addListener((info, tab) => {
    updateSensitiveContextMenuForTab({ ...tab, url: info.pageUrl || (tab && tab.url) });
    chrome.contextMenus.refresh();
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message) {
  switch (message && message.type) {
    case "alia-get-dashboard":
      return { ok: true, dashboard: await buildDashboard() };
    case "alia-toggle-sensitive":
      return { ok: true, sensitiveDomains: await toggleSensitiveDomain(message.hostname) };
    case "alia-remove-sensitive":
      return { ok: true, sensitiveDomains: await removeSensitiveDomain(message.hostname) };
    case "alia-restore-tab":
      await restoreTab(message.tabId);
      return { ok: true };
    default:
      return { ok: false, error: "Unknown Alia message." };
  }
}

function scheduleEvaluation() {
  clearTimeout(evaluationTimer);
  evaluationTimer = setTimeout(async () => {
    await reconcileAndEvaluate();
    scheduleEvaluation();
  }, EVALUATION_INTERVAL_MS);
}

async function reconcileAndEvaluate() {
  const now = Date.now();
  const tabs = await chrome.tabs.query({});
  const data = await getStoredData();
  const liveTabIds = new Set(tabs.map((tab) => String(tab.id)));

  Object.keys(data.tabState).forEach((tabId) => {
    if (!liveTabIds.has(tabId)) delete data.tabState[tabId];
  });

  for (const tab of tabs) {
    if (isSuspendedPlaceholder(tab.url)) continue;
    data.tabState[tab.id] = data.tabState[tab.id] || makeTabRecord(tab, now);
  }

  for (const tab of tabs) {
    const record = data.tabState[tab.id];
    if (!record || isSuspendedPlaceholder(tab.url)) continue;
    const idleMs = tab.active ? 0 : Math.max(0, now - record.lastActiveAt);
    const sensitive = isSensitiveHostname(record.hostname, data.sensitiveDomains);
    const suspendAfterMs = adaptiveSuspendThreshold(record.hostname, data.domainHistory);

    // Chrome (or the user, via chrome://discards) can discard a tab outside Alia's own
    // suspension path. tab.discarded is already true at this point, so the dashboard's
    // "suspended" count (which reads tab.discarded directly) would show this tab as
    // suspended immediately - but without this adoption step, the memory estimate would
    // never be credited, since that only happens inside suspendTab(). This keeps both
    // numbers in sync regardless of who triggered the discard.
    if (tab.discarded && record.stage !== "discarded" && record.stage !== "secure-placeholder") {
      adoptExternallyDiscardedTab(record, sensitive, data, now);
      await updateActionState(tab.id, "suspended", 0, sensitive);
      continue;
    }

    if (tab.active) {
      if (record.stage !== "active") data.tabState[tab.id] = makeTabRecord(tab, now, record);
      await updateActionState(tab.id, "active", 0);
      continue;
    }

    if (record.stage !== "discarded" && idleMs >= DIM_AFTER_MS) {
      record.stage = "dimmed";
      await updateActionState(tab.id, "dimmed", idleMs);
    } else if (record.stage !== "discarded") {
      await updateActionState(tab.id, "idle", idleMs);
    }

    if (!canSuspend(tab, record, sensitive, idleMs, suspendAfterMs)) continue;
    await suspendTab(tab, record, sensitive, data, now);
  }

  await saveStoredData(data);
}

function canSuspend(tab, record, sensitive, idleMs, suspendAfterMs) {
  if (tab.active || tab.pinned || tab.audible || tab.discarded || record.stage === "discarded") return false;
  if (!isWebUrl(tab.url) || isSuspendedPlaceholder(tab.url)) return false;
  if (idleMs < suspendAfterMs) return false;
  // Without page access, Alia cannot identify forms/uploads. It only automates low-risk signals.
  if (sensitive && idleMs < SENSITIVE_RECENT_ACTIVITY_MS) return false;
  return true;
}

async function suspendTab(tab, record, sensitive, data, now) {
  const estimatedMb = sensitive ? 65 : 75;
  record.suspendedAt = now;
  record.estimatedMemoryMb = estimatedMb;
  data.suspensionStats.estimatedMemoryFreedMb += estimatedMb;
  data.suspensionStats.totalSuspensions += 1;
  data.suspensionStats.lastUpdatedAt = now;

  if (sensitive) {
    record.stage = "secure-placeholder";
    // The sensitive page receives no title, favicon, hostname, or session data - only its URL.
    const placeholderUrl = chrome.runtime.getURL(`suspended.html?url=${encodeURIComponent(tab.url)}`);
    await chrome.tabs.update(tab.id, { url: placeholderUrl });
    await updateActionState(tab.id, "suspended", 0, true);
    return;
  }

  await chrome.tabs.discard(tab.id);
  record.stage = "discarded";
  await updateActionState(tab.id, "suspended", 0);
}

// Mirrors suspendTab()'s bookkeeping for a tab Chrome already discarded on its own.
// We do not call chrome.tabs.discard() again (it is already discarded) and we do not
// navigate sensitive tabs to the secure placeholder here - rewriting the URL would force
// a reload, defeating the memory savings Chrome just achieved. The placeholder is only
// used on Alia-initiated suspensions, where we control the transition end-to-end.
function adoptExternallyDiscardedTab(record, sensitive, data, now) {
  const estimatedMb = sensitive ? 65 : 75;
  record.stage = "discarded";
  record.suspendedAt = now;
  record.estimatedMemoryMb = estimatedMb;
  data.suspensionStats.estimatedMemoryFreedMb += estimatedMb;
  data.suspensionStats.totalSuspensions += 1;
  data.suspensionStats.lastUpdatedAt = now;
}

async function restoreTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const data = await getStoredData();
  const record = data.tabState[tabId];
  if (record) {
    releaseMemoryEstimate(record, data.suspensionStats);
    record.stage = "active";
    record.lastActiveAt = Date.now();
    await saveStoredData(data);
  }
  if (isSuspendedPlaceholder(tab.url)) {
    const originalUrl = getOriginalUrlFromPlaceholder(tab.url);
    if (originalUrl) await chrome.tabs.update(tabId, { url: originalUrl, active: true });
    return;
  }
  if (tab.discarded) await chrome.tabs.reload(tabId);
  await chrome.tabs.update(tabId, { active: true });
}

async function buildDashboard() {
  const now = Date.now();
  const tabs = await chrome.tabs.query({});
  const data = await getStoredData();
  const entries = tabs.map((tab) => {
    const record = data.tabState[tab.id] || makeTabRecord(tab, now);
    const placeholder = isSuspendedPlaceholder(tab.url);
    const stage = placeholder ? "secure-placeholder" : (tab.discarded ? "discarded" : record.stage);
    const idleMs = tab.active || placeholder ? 0 : Math.max(0, now - record.lastActiveAt);
    const sensitive = placeholder || isSensitiveHostname(record.hostname, data.sensitiveDomains);
    return {
      id: tab.id,
      title: placeholder ? "Suspended - Secure Site" : (tab.title || "Untitled tab"),
      hostname: placeholder ? "secure site" : (record.hostname || hostnameFromUrl(tab.url) || "local tab"),
      active: tab.active,
      audible: tab.audible,
      pinned: tab.pinned,
      sensitive,
      stage,
      idleMs,
      suspendAfterMs: adaptiveSuspendThreshold(record.hostname, data.domainHistory),
    };
  });

  return {
    totals: {
      open: entries.length,
      dimmed: entries.filter((entry) => entry.stage === "dimmed").length,
      suspended: entries.filter((entry) => entry.stage === "discarded" || entry.stage === "secure-placeholder").length,
      estimatedMemoryFreedMb: data.suspensionStats.estimatedMemoryFreedMb,
    },
    tabs: entries.sort((a, b) => b.idleMs - a.idleMs),
    sensitiveDomains: data.sensitiveDomains.sort(),
  };
}

async function ensureTabState(tab, now) {
  const data = await getStoredData();
  data.tabState[tab.id] = data.tabState[tab.id] || makeTabRecord(tab, now);
  await saveStoredData(data);
}

function makeTabRecord(tab, now, existing = {}) {
  return {
    ...existing,
    lastActiveAt: tab.active ? now : (existing.lastActiveAt || now),
    hostname: hostnameFromUrl(tab.url) || existing.hostname || "",
    stage: tab.active ? "active" : (existing.stage || "idle"),
  };
}

function adaptiveSuspendThreshold(hostname, domainHistory) {
  const history = hostname && domainHistory[hostname];
  const samples = history && Array.isArray(history.returnIntervalsMs) ? history.returnIntervalsMs : [];
  if (!samples.length) return DEFAULT_SUSPEND_MS;
  const sorted = [...samples].sort((first, second) => first - second);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median <= 5 * 60 * 1000) return 25 * 60 * 1000;
  if (median <= 10 * 60 * 1000) return 20 * 60 * 1000;
  if (median >= 45 * 60 * 1000) return 10 * 60 * 1000;
  return DEFAULT_SUSPEND_MS;
}

function addDomainReturn(domainHistory, hostname, intervalMs, now) {
  if (!hostname || intervalMs < 2000) return;
  const current = domainHistory[hostname] || { returnIntervalsMs: [], lastReturnedAt: 0 };
  current.returnIntervalsMs = [...current.returnIntervalsMs, intervalMs].slice(-RETURN_HISTORY_LIMIT);
  current.lastReturnedAt = now;
  domainHistory[hostname] = current;
}

async function toggleSensitiveDomain(hostname) {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return (await getStoredData()).sensitiveDomains;
  const data = await getStoredData();
  const matchingDomain = data.sensitiveDomains.find((domain) => hostnameMatches(normalized, domain));
  if (matchingDomain) data.sensitiveDomains = data.sensitiveDomains.filter((domain) => domain !== matchingDomain);
  else data.sensitiveDomains.push(normalized);
  data.sensitiveDomains.sort();
  await saveStoredData(data);
  return data.sensitiveDomains;
}

async function removeSensitiveDomain(hostname) {
  const data = await getStoredData();
  data.sensitiveDomains = data.sensitiveDomains.filter((domain) => domain !== hostname);
  await saveStoredData(data);
  return data.sensitiveDomains;
}

async function updateSensitiveContextMenuForTab(tab) {
  const hostname = hostnameFromUrl(tab && tab.url);
  const data = await getStoredData();
  const marked = hostname && isSensitiveHostname(hostname, data.sensitiveDomains);
  await chrome.contextMenus.update("alia-toggle-sensitive-domain", {
    title: marked ? "Unmark as sensitive" : "Mark tab as sensitive",
  });
}

async function updateActionState(tabId, stage, idleMs, secure = false) {
  if (stage === "dimmed") {
    const minutes = Math.max(1, Math.floor(idleMs / 60000));
    await chrome.action.setBadgeText({ tabId, text: minutes > 99 ? "99+" : `${minutes}m` });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#9b6b16" });
    await chrome.action.setTitle({ tabId, title: `Alia - idle ${formatIdle(idleMs)}` });
    return;
  }
  if (stage === "suspended") {
    await chrome.action.setBadgeText({ tabId, text: "ZZ" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#5d3b8c" });
    await chrome.action.setTitle({ tabId, title: secure ? "Alia - Suspended Secure Site" : "Alia - Suspended tab" });
    return;
  }
  await chrome.action.setBadgeText({ tabId, text: "" });
  await chrome.action.setTitle({ tabId, title: "Alia" });
}

function isSensitiveHostname(hostname, userDomains) {
  return userDomains.some((domain) => hostnameMatches(hostname, domain));
}

function hostnameMatches(hostname, pattern) {
  const normalizedHost = normalizeHostname(hostname);
  const normalizedPattern = normalizeHostname(pattern);
  return Boolean(normalizedHost && normalizedPattern && (normalizedHost === normalizedPattern || normalizedHost.endsWith(`.${normalizedPattern}`)));
}

function hostnameFromUrl(url) {
  try { return normalizeHostname(new URL(url).hostname); } catch { return ""; }
}

function normalizeHostname(hostname) {
  return String(hostname || "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
}

function isWebUrl(url) { return /^https?:\/\//i.test(url || ""); }
function isSuspendedPlaceholder(url) { return Boolean(url && url.startsWith(chrome.runtime.getURL("suspended.html"))); }

function getOriginalUrlFromPlaceholder(url) {
  try {
    const candidate = new URL(url).searchParams.get("url");
    return isWebUrl(candidate) ? candidate : "";
  } catch { return ""; }
}

function formatIdle(idleMs) {
  const minutes = Math.floor(idleMs / 60000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function releaseMemoryEstimate(record, stats) {
  const estimate = Number(record.estimatedMemoryMb) || 0;
  if (!estimate) return;
  stats.estimatedMemoryFreedMb = Math.max(0, stats.estimatedMemoryFreedMb - estimate);
  stats.lastUpdatedAt = Date.now();
  record.estimatedMemoryMb = 0;
}

async function getStoredData() {
  const stored = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  return {
    tabState: stored[STORAGE_KEYS.tabState] || {},
    domainHistory: stored[STORAGE_KEYS.domainHistory] || {},
    sensitiveDomains: Array.isArray(stored[STORAGE_KEYS.sensitiveDomains])
      ? stored[STORAGE_KEYS.sensitiveDomains]
      : [...BUILT_IN_SENSITIVE_DOMAINS],
    suspensionStats: { ...DEFAULT_STATS, ...(stored[STORAGE_KEYS.suspensionStats] || {}) },
  };
}

// Seed bundled defaults once. Existing installations keep prior custom entries during migration.
async function initializeSensitiveDomains() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.sensitiveDomains, "aliaSensitiveDomains"]);
  if (Array.isArray(stored[STORAGE_KEYS.sensitiveDomains])) return;
  const legacyDomains = Array.isArray(stored.aliaSensitiveDomains) ? stored.aliaSensitiveDomains : [];
  const sensitiveDomains = [...new Set([...BUILT_IN_SENSITIVE_DOMAINS, ...legacyDomains])].sort();
  await chrome.storage.local.set({ [STORAGE_KEYS.sensitiveDomains]: sensitiveDomains });
}

function saveStoredData(data) {
  return chrome.storage.local.set({
    [STORAGE_KEYS.tabState]: data.tabState,
    [STORAGE_KEYS.domainHistory]: data.domainHistory,
    [STORAGE_KEYS.sensitiveDomains]: data.sensitiveDomains,
    [STORAGE_KEYS.suspensionStats]: data.suspensionStats,
  });
}