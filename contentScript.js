(function mountAliaLauncher() {
  if (window.top !== window) return;
  if (document.getElementById("alia-floating-launcher-host")) return;

  const host = document.createElement("div");
  host.id = "alia-floating-launcher-host";
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    :host {
      all: initial;
    }

    .launcher {
      position: fixed;
      right: 18px;
      bottom: 84px;
      z-index: 2147483647;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 44px;
      height: 44px;
      padding: 0 12px 0 10px;
      border: 1px solid rgba(17, 24, 39, 0.12);
      border-radius: 999px;
      background: #ffffff;
      color: #111827;
      box-shadow: 0 14px 35px rgba(15, 23, 42, 0.22);
      font: 700 13px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: pointer;
      user-select: none;
      transition: transform 140ms ease, box-shadow 140ms ease, opacity 140ms ease;
    }

    .launcher:hover {
      transform: translateY(-1px);
      box-shadow: 0 18px 42px rgba(15, 23, 42, 0.28);
    }

    .launcher:active {
      transform: translateY(0) scale(0.98);
    }

    .mark {
      display: grid;
      width: 26px;
      height: 26px;
      place-items: center;
      border-radius: 50%;
      background: linear-gradient(135deg, #159764, #2563eb);
      color: #ffffff;
      font-size: 14px;
      font-weight: 850;
      letter-spacing: 0;
    }

    .label {
      max-width: 74px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .launcher.loading {
      opacity: 0.72;
      pointer-events: none;
    }

    @media (max-width: 520px) {
      .launcher {
        right: 14px;
        bottom: 68px;
        padding-right: 10px;
      }

      .label {
        display: none;
      }
    }
  `;

  const button = document.createElement("button");
  button.className = "launcher";
  button.type = "button";
  button.title = "Open ALIA side panel";
  button.setAttribute("aria-label", "Open ALIA side panel");
  button.innerHTML = '<span class="mark">A</span><span class="label">ALIA</span>';

  button.addEventListener("click", () => {
    button.classList.add("loading");
    chrome.runtime.sendMessage({ type: "ALIA_OPEN_SIDE_PANEL" }, (response) => {
      button.classList.remove("loading");
      if (chrome.runtime.lastError || !response || !response.ok) {
        console.warn("[ALIA] Could not open side panel.", chrome.runtime.lastError || response);
      }
    });
  });

  shadow.appendChild(style);
  shadow.appendChild(button);

  const appendHost = () => {
    if (document.documentElement && !document.getElementById(host.id)) {
      document.documentElement.appendChild(host);
    }
  };

  appendHost();
  if (!host.isConnected) {
    document.addEventListener("DOMContentLoaded", appendHost, { once: true });
  }
}());
