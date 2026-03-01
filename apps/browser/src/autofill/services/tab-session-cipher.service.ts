import { BrowserApi } from "../../platform/browser/browser-api";

interface TabCipherSession {
  cipherId: string;
  uri: string;
  timestamp: number;
  loginStepIndex: number;
}

const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 Minuten

export class TabSessionCipherService {
  private sessions = new Map<number, TabCipherSession>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  init(): void {
    // Tab-Close → Session löschen
    BrowserApi.addListener(chrome.tabs.onRemoved, (tabId: number) => {
      this.clearSession(tabId);
    });

    // Regelmäßig abgelaufene Sessions bereinigen
    this.cleanupInterval = setInterval(() => this.clearExpired(), 60_000);
  }

  setSession(tabId: number, cipherId: string, uri: string): void {
    const existing = this.sessions.get(tabId);
    this.sessions.set(tabId, {
      cipherId,
      uri,
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

    // Host-Matching: nur wenn der Hostname übereinstimmt
    try {
      const storedHost = new URL(session.uri).hostname;
      const currentHost = new URL(currentUri).hostname;
      if (storedHost !== currentHost) {
        this.sessions.delete(tabId);
        return null;
      }
    } catch {
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
