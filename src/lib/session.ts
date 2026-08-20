import { BUILD_HOMESERVER, BUILD_OIDC_ISSUER } from "./buildConfig";

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
  /** OIDC/MAS authorization-code + PKCE session fields. */
  refreshToken: string;
  oidcIssuer: string;
  oidcClientId: string;
}

const STORAGE_KEY = "telecrypt-io-ui:session";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function loadSession(): Session | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (
      isNonEmptyString(parsed.homeserver) &&
      isNonEmptyString(parsed.userId) &&
      isNonEmptyString(parsed.deviceId) &&
      isNonEmptyString(parsed.accessToken) &&
      isNonEmptyString(parsed.refreshToken) &&
      isNonEmptyString(parsed.oidcIssuer) &&
      isNonEmptyString(parsed.oidcClientId) &&
      parsed.homeserver === BUILD_HOMESERVER &&
      parsed.oidcIssuer === BUILD_OIDC_ISSUER
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
  if (session.homeserver !== BUILD_HOMESERVER || session.oidcIssuer !== BUILD_OIDC_ISSUER) {
    throw new Error("Cannot save a session for a different build");
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}
