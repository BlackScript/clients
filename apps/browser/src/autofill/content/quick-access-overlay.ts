/**
 * Quick-Access-Overlay: Schwebendes Such-Overlay
 *
 * Default-Shortcut: Ctrl+Shift+. (konfigurierbar unter chrome://extensions/shortcuts)
 * Wird per Runtime-Message "toggleQuickAccess" vom Background-Script getriggert.
 * Enthält ein iframe das die Popup-Vault-Ansicht der Extension lädt.
 */

let quickAccessContainer: HTMLDivElement | null = null;
let quickAccessShadowRoot: ShadowRoot | null = null;
let activeEscHandler: ((e: KeyboardEvent) => void) | null = null;

function createQuickAccessOverlay() {
  if (quickAccessContainer) {
    removeQuickAccessOverlay();
    return;
  }

  quickAccessContainer = document.createElement("div");
  quickAccessContainer.id = "bitwarden-quick-access-container";
  quickAccessShadowRoot = quickAccessContainer.attachShadow({ mode: "closed" });

  // Backdrop (klick zum Schließen)
  const backdrop = document.createElement("div");
  backdrop.setAttribute(
    "style",
    [
      "position: fixed",
      "top: 0",
      "left: 0",
      "width: 100vw",
      "height: 100vh",
      "background: rgba(0, 0, 0, 0.3)",
      "z-index: 2147483646",
      "display: flex",
      "justify-content: center",
      "padding-top: 80px",
    ].join("; "),
  );
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) {
      removeQuickAccessOverlay();
    }
  });

  // iframe Container
  const iframeWrapper = document.createElement("div");
  iframeWrapper.setAttribute(
    "style",
    [
      "width: 400px",
      "max-width: 90vw",
      "height: 420px",
      "max-height: 60vh",
      "border-radius: 12px",
      "overflow: hidden",
      "box-shadow: 0 16px 48px rgba(0, 0, 0, 0.2)",
      "background: #fff",
    ].join("; "),
  );

  const iframe = document.createElement("iframe");
  iframe.src = chrome.runtime.getURL("popup/index.html#/tabs/current");
  iframe.setAttribute(
    "style",
    ["width: 100%", "height: 100%", "border: none", "border-radius: 12px"].join("; "),
  );
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups");
  iframe.setAttribute("title", "Bitwarden Quick Access");

  iframeWrapper.appendChild(iframe);
  backdrop.appendChild(iframeWrapper);
  quickAccessShadowRoot.appendChild(backdrop);
  document.body.appendChild(quickAccessContainer);

  // ESC zum Schließen — Handler merken für saubere Bereinigung
  activeEscHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      removeQuickAccessOverlay();
    }
  };
  document.addEventListener("keydown", activeEscHandler);
}

function removeQuickAccessOverlay() {
  if (activeEscHandler) {
    document.removeEventListener("keydown", activeEscHandler);
    activeEscHandler = null;
  }
  if (quickAccessContainer) {
    quickAccessContainer.remove();
    quickAccessContainer = null;
    quickAccessShadowRoot = null;
  }
}

// Runtime-Message-Listener (getriggert vom Background-Command-Handler)
chrome.runtime.onMessage.addListener((message: { command: string }) => {
  if (message.command === "toggleQuickAccess") {
    createQuickAccessOverlay();
  }
});
