let activeHostname = "";

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("refresh").addEventListener("click", refreshPanel);
  document.getElementById("sensitive-toggle").addEventListener("change", toggleActiveDomain);
  refreshPanel();
  setInterval(refreshPanel, 5000);
});

async function refreshPanel() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeHostname = hostnameForTab(activeTab);
  const response = await chrome.runtime.sendMessage({ type: "alia-get-dashboard" });
  if (!response || !response.ok) return;
  renderPanel(response.dashboard);
}

function renderPanel(dashboard) {
  const { totals, sensitiveDomains } = dashboard;
  setText("open-count", totals.open);
  setText("dimmed-count", totals.dimmed);
  setText("suspended-count", totals.suspended);
  setText("memory-count", totals.estimatedMemoryFreedMb);
  renderSensitiveControl(sensitiveDomains);

  const blackmasked = dashboard.tabs.filter((tab) => (
    tab.stage === "dimmed" || tab.stage === "discarded" || tab.stage === "secure-placeholder"
  ));
  setText("list-count", blackmasked.length);
  renderBlackmaskedTabs(blackmasked);
  setText("sensitive-count", sensitiveDomains.length);
  renderSensitiveDomains(sensitiveDomains);
}

function renderSensitiveControl(domains) {
  const toggle = document.getElementById("sensitive-toggle");
  const marked = activeHostname && domains.some((domain) => hostnameMatches(activeHostname, domain));
  setText("current-domain-label", activeHostname || "No eligible page");
  toggle.disabled = !activeHostname;
  toggle.checked = Boolean(marked);
  document.getElementById("sensitive-note").textContent = activeHostname
    ? marked
      ? "This domain uses secure placeholder-page treatment."
      : "Mark this domain to use secure placeholder-page treatment."
    : "Open an http or https page to change its setting.";
}

function renderBlackmaskedTabs(tabs) {
  const list = document.getElementById("blackmasked-list");
  list.replaceChildren();
  if (!tabs.length) {
    list.appendChild(emptyState("No tabs are currently blackmasked."));
    return;
  }

  tabs.forEach((tab) => {
    const row = document.createElement("article");
    row.className = `tab-row ${tab.stage}`;
    row.title = tab.stage === "dimmed" ? `idle ${formatIdle(tab.idleMs)}` : tab.title;

    const text = document.createElement("div");
    text.className = "tab-text";
    const title = document.createElement("strong");
    title.className = "tab-title";
    title.textContent = tab.title;
    const detail = document.createElement("span");
    detail.className = "tab-detail";
    detail.textContent = tab.stage === "dimmed"
      ? `${tab.hostname} - suspends at ${formatIdle(tab.suspendAfterMs)}`
      : "Suspended - select to restore";
    text.append(title, detail);

    const status = document.createElement("div");
    status.className = "tab-status";
    if (tab.sensitive) {
      const lock = document.createElement("span");
      lock.className = "lock-icon";
      lock.title = "Sensitive domain";
      lock.setAttribute("aria-label", "Sensitive domain");
      status.appendChild(lock);
    }
    const badge = document.createElement("span");
    badge.className = "idle-badge";
    badge.textContent = tab.stage === "dimmed" ? `idle ${formatIdle(tab.idleMs)}` : "suspended";
    status.appendChild(badge);
    row.append(text, status);

    if (tab.stage === "discarded" || tab.stage === "secure-placeholder") {
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.addEventListener("click", () => restoreTab(tab.id));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") restoreTab(tab.id);
      });
    }
    list.appendChild(row);
  });
}

function renderSensitiveDomains(domains) {
  const list = document.getElementById("sensitive-domains-list");
  list.replaceChildren();
  if (!domains.length) {
    list.appendChild(emptyState("No sensitive domains are configured."));
    return;
  }
  domains.forEach((domain) => {
    const row = document.createElement("div");
    row.className = "domain-row";
    const label = document.createElement("span");
    label.textContent = domain;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-button";
    remove.textContent = "x";
    remove.title = `Remove ${domain}`;
    remove.setAttribute("aria-label", `Remove ${domain}`);
    remove.addEventListener("click", () => removeSensitiveDomain(domain));
    row.append(label, remove);
    list.appendChild(row);
  });
}

async function toggleActiveDomain() {
  if (!activeHostname) return;
  await chrome.runtime.sendMessage({ type: "alia-toggle-sensitive", hostname: activeHostname });
  await refreshPanel();
}

async function removeSensitiveDomain(hostname) {
  await chrome.runtime.sendMessage({ type: "alia-remove-sensitive", hostname });
  await refreshPanel();
}

async function restoreTab(tabId) {
  await chrome.runtime.sendMessage({ type: "alia-restore-tab", tabId });
  await refreshPanel();
}

function hostnameForTab(tab) {
  try {
    const url = new URL(tab && tab.url);
    if (/^https?:$/.test(url.protocol)) return url.hostname.toLowerCase();
    if (url.pathname.endsWith("suspended.html")) {
      return new URL(url.searchParams.get("url")).hostname.toLowerCase();
    }
  } catch { /* The active tab does not have a web hostname. */ }
  return "";
}

function hostnameMatches(hostname, pattern) {
  return hostname === pattern || hostname.endsWith(`.${pattern}`);
}

function emptyState(message) {
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = message;
  return empty;
}

function formatIdle(milliseconds) {
  const minutes = Math.max(0, Math.floor(milliseconds / 60000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function setText(id, value) {
  document.getElementById(id).textContent = String(value);
}
