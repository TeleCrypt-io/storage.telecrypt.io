import { getRuntimeSettings } from "./buildConfig";

/**
 * Session persistence: homeserver/user/device/tokens in tab-scoped sessionStorage.
 * The crypto store persists on its own via the browser's native IndexedDB (see
 * TeleCryptIOStorage.create, called with its default persistentCryptoStore: true).
 */
export interface Session {
  homeserver: string;
  userId: string;
  deviceId: string;
  accessToken: string;
  /** OIDC/MAS authorization-code + PKCE session fields. */
  refreshToken: string;
  oidcClientId: string;
}

function sessionsEqual(a: Session, b: Session): boolean {
  return (
    a.homeserver === b.homeserver &&
    a.userId === b.userId &&
    a.deviceId === b.deviceId &&
    a.accessToken === b.accessToken &&
    a.refreshToken === b.refreshToken &&
    a.oidcClientId === b.oidcClientId
  );
}

export const SESSION_STORAGE_KEY = "telecrypt-io-ui:session";
export const PENDING_REVOCATION_STORAGE_KEY = "telecrypt-io-ui:pending-revocation";
export const SESSION_PERSISTENCE_ERROR = "Session persistence failed";
export const SESSION_CLEANUP_PENDING_ERROR = "Session cleanup is pending";
export const SESSION_CLEANUP_PERSISTENCE_ERROR = "Session cleanup could not be persisted";
export const OIDC_LOGIN_INTENT_STORAGE_KEY = "telecrypt-io-ui:oidc-login-intent";
export const MAX_SESSION_TOKEN_BYTES = 8192;
export const MAX_SESSION_IDENTITY_BYTES = 4096;
const MAX_MATRIX_ID_BYTES = 255;
const OIDC_STATE_STORAGE_PREFIXES = ["mx_oidc_", "telecrypt:oauth2:pkce:v1:"];
export const MAX_OIDC_LOGIN_INTENT_AGE_MS = 10 * 60 * 1000;

export interface OidcLoginIntent {
  state: string;
  createdAt: number;
}

export interface PendingRevocation {
  homeserver: string;
  accessToken: string;
}

const MAX_PENDING_REVOCATIONS = 8;
// A storage denial must not make an issued bearer token disappear without a retry path. This
// volatile fallback is tab-scoped and is cleared as soon as remote revocation is confirmed.
let volatilePendingRevocations: PendingRevocation[] = [];

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function sessionStore(): Storage | null {
  try {
    const store = window.sessionStorage;
    // Probe access as browsers can expose the object while denying reads/writes.
    const probe = "telecrypt-io-ui:session-probe";
    store.setItem(probe, "1");
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

export function assertSessionStorageWritable(): void {
  if (!sessionStore()) throw new Error(SESSION_PERSISTENCE_ERROR);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isBoundedString(value: unknown, max: number): value is string {
  return (
    isNonEmptyString(value) &&
    utf8ByteLength(value) <= max &&
    ![...value].some(
      (character) =>
        /\s/u.test(character) || character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
    )
  );
}

function isMatrixUserId(value: string, expectedServerName: string): boolean {
  if (utf8ByteLength(value) > MAX_MATRIX_ID_BYTES || !value.startsWith("@")) return false;
  const separator = value.indexOf(":", 1);
  const serverNamePattern = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?$/u;
  return (
    separator > 1 &&
    separator < value.length - 1 &&
    /^[A-Za-z0-9._=+\-/]+$/u.test(value.slice(1, separator)) &&
    serverNamePattern.test(value.slice(separator + 1)) &&
    value.slice(separator + 1).toLowerCase() === expectedServerName.toLowerCase()
  );
}

export function isRuntimeMatrixUserId(value: unknown): value is string {
  try {
    const { serverName } = getRuntimeSettings();
    return (
      isBoundedString(value, MAX_SESSION_IDENTITY_BYTES) &&
      isMatrixUserId(value, serverName)
    );
  } catch {
    return false;
  }
}

export function isRuntimeMatrixDeviceId(value: unknown): value is string {
  return (
    isBoundedString(value, MAX_SESSION_IDENTITY_BYTES) &&
    value.length <= 128 &&
    /^[A-Za-z0-9._~-]{1,128}$/u.test(value)
  );
}

function matchesRuntimeHomeserver(value: string): boolean {
  try {
    return new URL(value).toString() === new URL(getRuntimeSettings().homeserver).toString();
  } catch {
    return false;
  }
}

function parseSession(raw: string | null, clearInvalid: boolean): Session | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Session>;
    const { homeserver, serverName } = getRuntimeSettings();
    if (
      isNonEmptyString(parsed.homeserver) &&
      isBoundedString(parsed.userId, MAX_SESSION_IDENTITY_BYTES) &&
      isMatrixUserId(parsed.userId, serverName) &&
      isBoundedString(parsed.deviceId, MAX_SESSION_IDENTITY_BYTES) &&
      isRuntimeMatrixDeviceId(parsed.deviceId) &&
      isBoundedString(parsed.accessToken, MAX_SESSION_TOKEN_BYTES) &&
      isBoundedString(parsed.refreshToken, MAX_SESSION_TOKEN_BYTES) &&
      isBoundedString(parsed.oidcClientId, MAX_SESSION_IDENTITY_BYTES) &&
      parsed.homeserver === homeserver
    ) {
      return parsed as Session;
    }
    if (clearInvalid) {
      try {
        sessionStore()?.removeItem(SESSION_STORAGE_KEY);
      } catch {
        // A denied storage operation is handled as an absent session by the caller.
      }
    }
    return null;
  } catch {
    if (clearInvalid) {
      try {
        sessionStore()?.removeItem(SESSION_STORAGE_KEY);
      } catch {
        // A denied storage operation is handled as an absent session by the caller.
      }
    }
    return null;
  }
}

export function loadSession(): Session | null {
  try {
    const store = sessionStore();
    return store ? parseSession(store.getItem(SESSION_STORAGE_KEY), true) : null;
  } catch {
    return null;
  }
}

/**
 * Persists only if this tab still holds the expected session. A null expected
 * value means the caller requires there to be no session yet.
 */
export function saveSessionIfCurrent(session: Session, expected: Session | null): boolean {
  try {
    const store = sessionStore();
    if (!store) return false;
    const current = parseSession(store.getItem(SESSION_STORAGE_KEY), false);
    if (expected === null ? current !== null : !current || !sessionsEqual(current, expected)) {
      return false;
    }
    const { homeserver } = getRuntimeSettings();
    if (
      session.homeserver !== homeserver ||
      !isRuntimeMatrixUserId(session.userId) ||
      !isRuntimeMatrixDeviceId(session.deviceId) ||
      !isBoundedString(session.accessToken, MAX_SESSION_TOKEN_BYTES) ||
      !isBoundedString(session.refreshToken, MAX_SESSION_TOKEN_BYTES) ||
      !isBoundedString(session.oidcClientId, MAX_SESSION_IDENTITY_BYTES)
    ) {
      return false;
    }
    store.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    const persisted = parseSession(store.getItem(SESSION_STORAGE_KEY), false);
    return Boolean(persisted && sessionsEqual(persisted, session));
  } catch {
    return false;
  }
}

export function clearSession(): boolean {
  try {
    const store = sessionStore();
    if (!store) return false;
    store.removeItem(SESSION_STORAGE_KEY);
    return store.getItem(SESSION_STORAGE_KEY) === null && clearOidcTransientStateFromStore(store);
  } catch {
    return false;
  }
}

function clearOidcTransientStateFromStore(store: Storage): boolean {
  for (let index = store.length - 1; index >= 0; index -= 1) {
    const key = store.key(index);
    if (key && OIDC_STATE_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      store.removeItem(key);
    }
  }
  store.removeItem(OIDC_LOGIN_INTENT_STORAGE_KEY);
  if (store.getItem(OIDC_LOGIN_INTENT_STORAGE_KEY) !== null) return false;
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key && OIDC_STATE_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) return false;
  }
  return true;
}

/** Clear only one-time OIDC state, preserving any live authenticated session. */
export function clearOidcTransientState(): boolean {
  try {
    const store = sessionStore();
    return store ? clearOidcTransientStateFromStore(store) : false;
  } catch {
    return false;
  }
}

function isPendingRevocation(value: unknown): value is PendingRevocation {
  if (typeof value !== "object" || value === null) return false;
  const parsed = value as Partial<PendingRevocation>;
  return (
    isNonEmptyString(parsed.homeserver) &&
    isBoundedString(parsed.accessToken, MAX_SESSION_TOKEN_BYTES) &&
    matchesRuntimeHomeserver(parsed.homeserver)
  );
}

function sameRevocation(a: PendingRevocation, b: PendingRevocation): boolean {
  return a.homeserver === b.homeserver && a.accessToken === b.accessToken;
}

export function loadPendingRevocations(): PendingRevocation[] {
  const store = sessionStore();
  if (!store) {
    if (volatilePendingRevocations.length !== 0) return [...volatilePendingRevocations];
    throw new Error(SESSION_CLEANUP_PERSISTENCE_ERROR);
  }
  try {
    const parsed: unknown = JSON.parse(store.getItem(PENDING_REVOCATION_STORAGE_KEY) ?? "null");
    // Accept the former single-record shape so an interrupted local checkout can
    // migrate without ever treating the token as a live session.
    const candidates = Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed];
    if (
      candidates.length <= MAX_PENDING_REVOCATIONS &&
      candidates.every(isPendingRevocation)
    ) {
      const pending = candidates.filter(
        (target, index, all) => all.findIndex((candidate) => sameRevocation(candidate, target)) === index,
      );
      const combined = [...pending, ...volatilePendingRevocations].filter(
        (target, index, all) =>
          all.findIndex((candidate) => sameRevocation(candidate, target)) === index,
      );
      if (combined.length > MAX_PENDING_REVOCATIONS) {
        throw new Error(SESSION_CLEANUP_PERSISTENCE_ERROR);
      }
      volatilePendingRevocations = combined;
      return [...combined];
    }
  } catch {
    // Treat malformed cleanup state as disposable, never as an active session.
  }
  // Unknown cleanup state may represent an issued token that still needs revocation.
  // Preserve it for manual site-data recovery and fail closed instead of silently
  // deleting the only evidence that cleanup is incomplete.
  throw new Error(SESSION_CLEANUP_PERSISTENCE_ERROR);
}

export function loadPendingRevocation(): PendingRevocation | null {
  return loadPendingRevocations()[0] ?? null;
}

export function savePendingRevocation(target: PendingRevocation): boolean {
  if (!isPendingRevocation(target)) return false;
  try {
    const pending = loadPendingRevocations();
    if (!pending.some((candidate) => sameRevocation(candidate, target))) pending.push(target);
    if (pending.length > MAX_PENDING_REVOCATIONS) return false;
    volatilePendingRevocations = pending;
    const store = sessionStore();
    if (!store) return false;
    const serialized = JSON.stringify(pending);
    store.setItem(PENDING_REVOCATION_STORAGE_KEY, serialized);
    return store.getItem(PENDING_REVOCATION_STORAGE_KEY) === serialized;
  } catch {
    if (!volatilePendingRevocations.some((candidate) => sameRevocation(candidate, target))) {
      if (volatilePendingRevocations.length >= MAX_PENDING_REVOCATIONS) return false;
      volatilePendingRevocations = [...volatilePendingRevocations, target];
    }
    return false;
  }
}

export function clearPendingRevocation(target?: PendingRevocation): boolean {
  try {
    const store = sessionStore();
    if (!store) return false;
    const remaining = target
      ? loadPendingRevocations().filter((candidate) => !sameRevocation(candidate, target))
      : [];
    if (remaining.length === 0) {
      store.removeItem(PENDING_REVOCATION_STORAGE_KEY);
      if (store.getItem(PENDING_REVOCATION_STORAGE_KEY) !== null) return false;
    } else {
      const serialized = JSON.stringify(remaining);
      store.setItem(PENDING_REVOCATION_STORAGE_KEY, serialized);
      if (store.getItem(PENDING_REVOCATION_STORAGE_KEY) !== serialized) return false;
    }
    volatilePendingRevocations = remaining;
    return true;
  } catch {
    return false;
  }
}

export function saveOidcLoginIntent(intent: OidcLoginIntent): boolean {
  try {
    const store = sessionStore();
    if (!store || !/^[\x21-\x7e]{1,512}$/.test(intent.state) || !Number.isFinite(intent.createdAt)) {
      return false;
    }
    const serialized = JSON.stringify(intent);
    store.setItem(OIDC_LOGIN_INTENT_STORAGE_KEY, serialized);
    return store.getItem(OIDC_LOGIN_INTENT_STORAGE_KEY) === serialized;
  } catch {
    return false;
  }
}

export function loadOidcLoginIntent(): OidcLoginIntent | null {
  try {
    const store = sessionStore();
    if (!store) return null;
    const parsed = JSON.parse(store.getItem(OIDC_LOGIN_INTENT_STORAGE_KEY) ?? "null") as Partial<OidcLoginIntent>;
    if (
      typeof parsed.state === "string" &&
      /^[\x21-\x7e]{1,512}$/.test(parsed.state) &&
      typeof parsed.createdAt === "number" &&
      Number.isFinite(parsed.createdAt) &&
      parsed.createdAt <= Date.now() &&
      Date.now() - parsed.createdAt <= MAX_OIDC_LOGIN_INTENT_AGE_MS
    ) {
      return { state: parsed.state, createdAt: parsed.createdAt };
    }
  } catch {
    // Treat malformed intent as absent; it must never authorize a callback.
  }
  return null;
}

export function clearOidcLoginIntent(): boolean {
  try {
    const store = sessionStore();
    if (!store) return false;
    store.removeItem(OIDC_LOGIN_INTENT_STORAGE_KEY);
    return store.getItem(OIDC_LOGIN_INTENT_STORAGE_KEY) === null;
  } catch {
    return false;
  }
}
