let currentTab = null;
let dashboard = null;

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("refresh").addEventListener("click", loadDashboard);
  document.getElementById("sensitive-toggle").addEventListener("change", toggleCurrentDomain);
  document.getElementById("open-side-panel").addEventListener("click", openSidePanel);
  await loadDashboard();
});

async function loadDashboard() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = activeTab || null;
  const response = await chrome.runtime.sendMessage({ type: "alia-get-dashboard" });
  if (!response || !response.ok) return;
  dashboard = response.dashboard;
  renderDashboard();
}

function renderDashboard() {
  const { totals, tabs, sensitiveDomains } = dashboard;
  setText("open-count", totals.open);
  setText("dimmed-count", totals.dimmed);
  setText("suspended-count", totals.suspended);
  setText("memory-count", totals.estimatedMemoryFreedMb);

  const currentDomain = getCurrentDomain();
  setText("current-domain", currentDomain || "No eligible page");
  const toggle = document.getElementById("sensitive-toggle");
  toggle.disabled = !currentDomain;
  toggle.checked = Boolean(currentDomain && sensitiveDomains.some((domain) => hostnameMatches(currentDomain, domain)));
  document.getElementById("sensitive-note").textContent = currentDomain
    ? toggle.checked
      ? "This domain is in your local sensitive list."
      : "Toggle to replace this domain with a secure placeholder on suspension."
    : "Open an http or https page to manage its sensitive setting.";

  renderTabs(tabs);
  renderSensitiveDomains(sensitiveDomains);
}

function renderTabs(tabs) {
  const list = document.getElementById("tab-list");
  list.replaceChildren();
  if (!tabs.length) {
    list.textContent = "No tabs available.";
    return;
  }
  tabs.forEach((tab) => {
    const row = document.createElement("article");
    row.className = `tab-row ${tab.stage}`;
    row.title = tab.stage === "dimmed" ? `idle ${formatIdle(tab.idleMs)}` : tab.title;

    const text = document.createElement("div");
    text.className = "tab-text";
    const title = document.createElement("strong");
    title.textContent = tab.title;
    const detail = document.createElement("span");
    detail.textContent = tab.stage === "dimmed"
      ? `idle ${formatIdle(tab.idleMs)} - suspends at ${formatIdle(tab.suspendAfterMs)}`
      : tab.stage === "discarded" || tab.stage === "secure-placeholder"
        ? "Suspended - select to restore"
        : tab.active
          ? "Active now"
          : tab.audible
            ? "Audio playing - protected"
            : tab.pinned
              ? "Pinned - protected"
              : `idle ${formatIdle(tab.idleMs)}`;
    text.append(title, detail);

    const state = document.createElement("span");
    state.className = "state";
    state.textContent = stateLabel(tab);
    row.append(text, state);
    if (tab.stage === "discarded" || tab.stage === "secure-placeholder") {
      row.addEventListener("click", () => restoreTab(tab.id));
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") restoreTab(tab.id);
      });
    }
    list.appendChild(row);
  });
}

function renderSensitiveDomains(domains) {
  const list = document.getElementById("sensitive-list");
  list.replaceChildren();
  if (!domains.length) {
    list.textContent = "No custom domains yet.";
    list.className = "sensitive-list empty";
    return;
  }
  list.className = "sensitive-list";
  domains.forEach((domain) => {
    const row = document.createElement("div");
    row.className = "domain-row";
    const label = document.createElement("span");
    label.textContent = domain;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "x";
    remove.title = `Remove ${domain}`;
    remove.setAttribute("aria-label", `Remove ${domain}`);
    remove.addEventListener("click", () => removeSensitiveDomain(domain));
    row.append(label, remove);
    list.appendChild(row);
  });
}

async function toggleCurrentDomain() {
  const hostname = getCurrentDomain();
  if (!hostname) return;
  await chrome.runtime.sendMessage({ type: "alia-toggle-sensitive", hostname });
  await loadDashboard();
}

async function removeSensitiveDomain(hostname) {
  await chrome.runtime.sendMessage({ type: "alia-remove-sensitive", hostname });
  await loadDashboard();
}

async function restoreTab(tabId) {
  await chrome.runtime.sendMessage({ type: "alia-restore-tab", tabId });
  window.close();
}

async function openSidePanel() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) await chrome.sidePanel.open({ windowId: tab.windowId });
  window.close();
}

function getCurrentDomain() {
  try {
    const url = new URL(currentTab && currentTab.url);
    return /^https?:$/.test(url.protocol) ? url.hostname.toLowerCase() : "";
  } catch { return ""; }
}

function hostnameMatches(hostname, pattern) {
  return hostname === pattern || hostname.endsWith(`.${pattern}`);
}

function stateLabel(tab) {
  if (tab.stage === "secure-placeholder") return "Secure";
  if (tab.stage === "discarded") return "ZZ";
  if (tab.stage === "dimmed") return "Idle";
  if (tab.active) return "Now";
  return tab.sensitive ? "Sensitive" : "Ready";
}

function formatIdle(milliseconds) {
  const minutes = Math.max(0, Math.floor(milliseconds / 60000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function setText(id, value) {
  document.getElementById(id).textContent = String(value);
}
