import { BrowserApi } from "../../platform/browser/browser-api";

export interface TabCipherSession {
  cipherId: string;
  uri: string;
  hostname: string;
  timestamp: number;
  loginStepIndex: number;
}

const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 Minuten

/**
 * Normalisiert einen Hostnamen: entfernt "www." Prefix für konsistentes Matching.
 * So matchen "www.example.com" und "example.com" korrekt.
 */
function normalizeHostname(hostname: string): string {
  return hostname.replace(/^www\./, "");
}

function extractHostname(uri: string): string | null {
  try {
    return normalizeHostname(new URL(uri).hostname);
  } catch {
    return null;
  }
}

export class TabSessionCipherService {
  private static _instance: TabSessionCipherService;
  private sessions = new Map<number, TabCipherSession>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  /**
   * Singleton-Instanz holen (wird von overlay.background.ts und autofill.service.ts geteilt)
   */
  static getInstance(): TabSessionCipherService {
    if (!TabSessionCipherService._instance) {
      TabSessionCipherService._instance = new TabSessionCipherService();
    }
    return TabSessionCipherService._instance;
  }

  init(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    // Tab-Close → Session löschen
    BrowserApi.addListener(chrome.tabs.onRemoved, (tabId: number) => {
      this.clearSession(tabId);
    });

    // Regelmäßig abgelaufene Sessions bereinigen
    this.cleanupInterval = setInterval(() => this.clearExpired(), 60_000);
  }

  /**
   * Bereinigt alle Ressourcen. Wird beim Extension-Unload aufgerufen.
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.sessions.clear();
    this.initialized = false;
  }

  setSession(tabId: number, cipherId: string, uri: string): void {
    // Automatisch initialisieren falls noch nicht geschehen
    this.init();

    const hostname = extractHostname(uri);
    if (!hostname) {
      return;
    }

    const existing = this.sessions.get(tabId);
    this.sessions.set(tabId, {
      cipherId,
      uri,
      hostname,
      timestamp: Date.now(),
      loginStepIndex: existing?.cipherId === cipherId ? existing.loginStepIndex + 1 : 0,
    });
  }

  getSession(tabId: number, currentUri: string): TabCipherSession | null {
    const session = this.sessions.get(tabId);
    if (!session) {
      return null;
    }

    // Abgelaufene Sessions verwerfen
    if (Date.now() - session.timestamp > SESSION_TIMEOUT_MS) {
      this.sessions.delete(tabId);
      return null;
    }

    // Host-Matching mit Subdomain-Normalisierung
    const currentHost = extractHostname(currentUri);
    if (!currentHost || session.hostname !== currentHost) {
      this.sessions.delete(tabId);
      return null;
    }

    return session;
  }

  clearSession(tabId: number): void {
    this.sessions.delete(tabId);
  }

  clearExpired(): void {
    const now = Date.now();
    for (const [tabId, session] of this.sessions.entries()) {
      if (now - session.timestamp > SESSION_TIMEOUT_MS) {
        this.sessions.delete(tabId);
      }
    }
  }
}
