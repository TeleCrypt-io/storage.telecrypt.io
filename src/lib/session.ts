/**
 * Session persistence: homeserver/userId/deviceId/accessToken in localStorage.
 * This is the ONLY thing the UI persists itself — the crypto store persists
 * on its own via the browser's native IndexedDB (see TeleCryptIOStorage.create,
 * called with its default persistentCryptoStore: true).
 */
export interface Session {
  homeserver: string;
  userId: string;
  deviceId: string;
  accessToken: string;
  /** OAuth/MAS authorization-code + PKCE metadata (see src/lib/oidcAuth.ts). */
  refreshToken: string;
  oidcIssuer: string;
  oidcClientId: string;
}

const STORAGE_KEY = "telecrypt-io-ui:session";

export function loadSession(): Session | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (
      typeof parsed.homeserver === "string" &&
      typeof parsed.userId === "string" &&
      typeof parsed.deviceId === "string" &&
      typeof parsed.accessToken === "string" &&
      typeof parsed.refreshToken === "string" &&
      typeof parsed.oidcIssuer === "string" &&
      typeof parsed.oidcClientId === "string"
    ) {
      return parsed as Session;
    }
    localStorage.removeItem(STORAGE_KEY);
    return null;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function saveSession(session: Session): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}
