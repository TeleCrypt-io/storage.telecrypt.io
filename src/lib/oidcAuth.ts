/**
 * OIDC/MAS login for the web UI: authorization-code + PKCE. Thin browser
 * adapter over the shared `src/core/oidc.ts` protocol calls (discovery, DCR,
 * PKCE URL building, token exchange).
 *
 * PKCE code_verifier + state are persisted by the published storage SDK in
 * window.sessionStorage; the transient state is cleared when a transaction
 * ends. This module persists the
 * non-secret DCR client_id in localStorage keyed by issuer, so repeat logins
 * against the same homeserver don't re-register a new client every time. The
 * Matrix device id is tab-scoped in sessionStorage with the session tokens.
 */
import {
  discoverOidcIssuer,
  registerClient,
  beginAuthorizationCodeFlow,
  completeAuthorizationCodeFlow,
  extractDeviceIdFromScope,
  whoAmI,
} from "./core";
import type { Session } from "./session";
import {
  clearPendingRevocation,
  clearOidcTransientState,
  clearSession,
  assertSessionStorageWritable,
  loadPendingRevocations,
  loadOidcLoginIntent,
  loadSession,
  saveOidcLoginIntent,
  savePendingRevocation,
  isRuntimeMatrixDeviceId,
  isRuntimeMatrixUserId,
  SESSION_CLEANUP_PERSISTENCE_ERROR,
  SESSION_CLEANUP_PENDING_ERROR,
  SESSION_PERSISTENCE_ERROR,
} from "./session";
import { assertRuntimeOidcEndpoint, getRuntimeSettings, runtimeOidcIssuer } from "./buildConfig";
import {
  classifyOidcCallback,
  MAX_OIDC_CALLBACK_FIELD_BYTES,
  MAX_OIDC_CALLBACK_URL_BYTES,
  readOidcCallbackParams,
  scrubOidcCallbackParams,
} from "./oidcCallback";
import { revokeMatrixSession } from "./revokeSession";

const CLIENT_ID_PREFIX = "telecrypt-io-ui:oidc-client:";
const DEVICE_ID_PREFIX = "telecrypt-io-ui:device:";
const MAX_OIDC_METADATA_FIELD_BYTES = 4096;
const MAX_OIDC_CLIENT_ID_BYTES = 512;
const MAX_OIDC_TOKEN_FIELD_BYTES = 8192;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Sign-in is no longer active", "AbortError");
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedString(value: unknown, name: string, max = MAX_OIDC_METADATA_FIELD_BYTES): string {
  if (typeof value !== "string" || value.trim() === "" || utf8ByteLength(value) > max) {
    throw new Error(`${name} is invalid or too large`);
  }
  return value;
}

function boundedClientId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    utf8ByteLength(value) > MAX_OIDC_CLIENT_ID_BYTES ||
    /\s/.test(value)
  ) {
    throw new Error("OIDC client identifier is invalid or too large");
  }
  return value;
}

function boundedToken(value: unknown, name: string): string {
  const token = boundedString(value, name, MAX_OIDC_TOKEN_FIELD_BYTES);
  if ([...token].some((character) => /\s/u.test(character) || character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
    throw new Error(`${name} is invalid or too large`);
  }
  return token;
}

function redirectUri(): string {
  return window.location.origin + "/";
}

function persistentStore(): Storage {
  try {
    const store = window.localStorage;
    const probe = "telecrypt-io-ui:client-storage-probe";
    store.setItem(probe, "1");
    store.removeItem(probe);
    return store;
  } catch {
    throw new Error("Browser persistent storage is unavailable");
  }
}

function loadCachedClientId(issuer: string): string | null {
  const cached = persistentStore().getItem(CLIENT_ID_PREFIX + issuer);
  if (!cached) return null;
  try {
    return boundedClientId(cached);
  } catch {
    return null;
  }
}

function cacheClientId(issuer: string, clientId: string): void {
  boundedClientId(clientId);
  try {
    const store = persistentStore();
    const key = CLIENT_ID_PREFIX + issuer;
    store.setItem(key, clientId);
    if (store.getItem(key) !== clientId) {
      throw new Error("Browser persistent storage is unavailable");
    }
  } catch {
    throw new Error("Browser persistent storage is unavailable");
  }
}

/**
 * Returns this tab's stable Matrix device id for the given issuer, creating
 * and persisting one on first use. Session state is intentionally tab-scoped,
 * so a separate tab also gets a separate device and login transaction.
 */
function loadOrCreateDeviceId(issuer: string): string {
  const key = DEVICE_ID_PREFIX + issuer;
  try {
    const store = window.sessionStorage;
    const probe = "telecrypt-io-ui:device-probe";
    store.setItem(probe, "1");
    store.removeItem(probe);
    const existing = store.getItem(key);
    if (existing && /^[0-9A-F]{10}$/.test(existing)) return existing;
    if (existing) store.removeItem(key);
    const bytes = new Uint8Array(5);
    crypto.getRandomValues(bytes);
    const deviceId = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
    store.setItem(key, deviceId);
    if (store.getItem(key) !== deviceId) throw new Error("device id was not persisted");
    return deviceId;
  } catch {
    throw new Error("Browser session storage is unavailable");
  }
}

async function cleanPendingRevocations(
  clearMatchingSession: boolean,
  signal?: AbortSignal,
): Promise<void> {
  for (const pending of loadPendingRevocations()) {
    throwIfAborted(signal);
    try {
      await revokeMatrixSession(pending, undefined, signal);
    } catch {
      throw new Error(SESSION_CLEANUP_PENDING_ERROR);
    }
    throwIfAborted(signal);
    if (clearMatchingSession && loadSession()?.accessToken === pending.accessToken && !clearSession()) {
      throw new Error(SESSION_CLEANUP_PERSISTENCE_ERROR);
    }
    if (!clearPendingRevocation(pending)) throw new Error(SESSION_CLEANUP_PERSISTENCE_ERROR);
  }
}

function authorizationRedirect(value: unknown, authorizationEndpoint: string): URL {
  const text = boundedString(value, "OIDC authorization URL", MAX_OIDC_CALLBACK_URL_BYTES);
  let redirect: URL;
  try {
    redirect = new URL(text);
  } catch {
    throw new Error("OIDC authorization URL is invalid");
  }
  const expected = new URL(authorizationEndpoint);
  if (
    redirect.origin !== expected.origin ||
    redirect.pathname !== expected.pathname ||
    redirect.username !== "" ||
    redirect.password !== "" ||
    redirect.hash !== ""
  ) {
    throw new Error("OIDC authorization URL does not match the configured endpoint");
  }
  return redirect;
}

/**
 * Starts the OIDC login flow: discovery → DCR (cached) → PKCE authorization
 * URL → redirect. Never returns normally on success (navigates away);
 * throws before redirecting if discovery/DCR fail.
 */
export async function beginOidcLogin(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  assertSessionStorageWritable();
  if (!clearOidcTransientState()) throw new Error(SESSION_PERSISTENCE_ERROR);
  await cleanPendingRevocations(true, signal);
  let existingSession = loadSession();
  for (let attempt = 0; existingSession && attempt < 4; attempt += 1) {
    throwIfAborted(signal);
    try {
      await revokeMatrixSession(existingSession, undefined, signal);
    } catch {
      savePendingRevocation(existingSession);
      throw new Error(SESSION_CLEANUP_PENDING_ERROR);
    }
    throwIfAborted(signal);
    const rotatedSession = loadSession();
    if (
      !rotatedSession ||
      (rotatedSession.accessToken === existingSession.accessToken &&
        rotatedSession.refreshToken === existingSession.refreshToken)
    ) {
      existingSession = null;
    } else {
      existingSession = rotatedSession;
    }
  }
  if (existingSession) {
    savePendingRevocation(existingSession);
    throw new Error(SESSION_CLEANUP_PENDING_ERROR);
  }
  if (!clearSession()) throw new Error(SESSION_PERSISTENCE_ERROR);
  throwIfAborted(signal);
  const { homeserver } = getRuntimeSettings();
  const oidcIssuer = runtimeOidcIssuer();
  const authMetadata = await discoverOidcIssuer(homeserver, signal);
  if (boundedString(authMetadata.issuer, "OIDC issuer") !== oidcIssuer) {
    throw new Error("OIDC issuer does not match the configured environment");
  }
  const authorizationEndpoint = assertRuntimeOidcEndpoint(
    boundedString(authMetadata.authorization_endpoint, "OIDC authorization endpoint"),
    "OIDC authorization endpoint",
  );
  assertRuntimeOidcEndpoint(
    boundedString(authMetadata.token_endpoint, "OIDC token endpoint"),
    "OIDC token endpoint",
  );
  assertRuntimeOidcEndpoint(
    boundedString(authMetadata.registration_endpoint, "OIDC registration endpoint"),
    "OIDC registration endpoint",
  );

  let clientId = loadCachedClientId(authMetadata.issuer);
  if (!clientId || clientId.trim() === "") {
    clientId = boundedClientId(await registerClient(
      authMetadata,
      {
        clientName: "TeleCrypt.io Storage (Web)",
        clientUri: redirectUri(),
        applicationType: "web",
        redirectUris: [redirectUri()],
        contacts: undefined,
        tosUri: undefined,
        policyUri: undefined,
      },
      signal,
    ));
    throwIfAborted(signal);
    cacheClientId(authMetadata.issuer, clientId);
  }

  throwIfAborted(signal);
  const url = await beginAuthorizationCodeFlow({
    authMetadata,
    clientId,
    homeserverUrl: homeserver,
    redirectUri: redirectUri(),
    deviceId: loadOrCreateDeviceId(authMetadata.issuer),
    signal,
  });
  throwIfAborted(signal);
  const redirect = authorizationRedirect(url, authorizationEndpoint);
  const states = redirect.searchParams.getAll("state");
  if (states.length !== 1 || !states[0] || !saveOidcLoginIntent({ state: states[0], createdAt: Date.now() })) {
    clearOidcTransientState();
    throw new Error(SESSION_PERSISTENCE_ERROR);
  }
  throwIfAborted(signal);
  window.location.href = redirect.toString();
}

/**
 * Completes the authorization-code exchange from the current URL's
 * query or fragment response parameters, confirms identity via `/whoami`, and
 * clears the response from the address bar (so a reload doesn't try to replay
 * the one-time code). Returns a validated `Session` for the active tab.
 */
export async function completeOidcLoginFromCallback(signal?: AbortSignal): Promise<Session> {
  throwIfAborted(signal);
  const callbackKind = classifyOidcCallback(window.location);
  const params = readOidcCallbackParams(window.location);
  const code = params.get("code");
  const state = params.get("state");
  const callbackError = params.get("error");
  const callbackIssuer = params.get("iss");

  // Remove all OAuth response fields before any asynchronous exchange. A failed exchange,
  // denial, or reload must never leave a one-time code, state, or provider error in history.
  scrubOidcCallbackParams(window.location);

  if (callbackKind !== "success" && callbackKind !== "error") {
    if (!clearOidcTransientState()) throw new Error(SESSION_PERSISTENCE_ERROR);
    throw new Error("Sign-in callback was malformed");
  }
  assertSessionStorageWritable();
  const intent = loadOidcLoginIntent();
  if (!intent || !state || state !== intent.state) {
    if (!clearOidcTransientState()) throw new Error(SESSION_PERSISTENCE_ERROR);
    throw new Error("Sign-in callback state could not be verified");
  }
  if (callbackIssuer !== null && callbackIssuer !== runtimeOidcIssuer()) {
    if (!clearOidcTransientState()) throw new Error(SESSION_PERSISTENCE_ERROR);
    throw new Error("Sign-in callback issuer could not be verified");
  }

  try {
    await cleanPendingRevocations(false, signal);
  } catch (error) {
    clearOidcTransientState();
    throw error;
  }

  if (callbackError) {
    if (!clearSession()) throw new Error(SESSION_PERSISTENCE_ERROR);
    throw new Error(callbackError === "access_denied" ? "Sign-in was cancelled" : "Sign-in failed");
  }
  if (!code || !state) {
    if (!clearSession()) throw new Error(SESSION_PERSISTENCE_ERROR);
    throw new Error("Sign-in failed");
  }

  let completed: Awaited<ReturnType<typeof completeAuthorizationCodeFlow>>;
  try {
    completed = await completeAuthorizationCodeFlow(
      boundedString(code, "OIDC authorization code", MAX_OIDC_CALLBACK_FIELD_BYTES),
      boundedString(state, "OIDC state", MAX_OIDC_CALLBACK_FIELD_BYTES),
      signal,
    );
  } catch (error) {
    if (!clearSession()) throw new Error(SESSION_PERSISTENCE_ERROR);
    throw error;
  }
  const sessionCleared = clearSession();
  const { tokenResponse, oidcClientSettings, homeserverUrl } = completed;

  try {
    throwIfAborted(signal);
    if (!sessionCleared) throw new Error(SESSION_PERSISTENCE_ERROR);
    const { homeserver } = getRuntimeSettings();
    const oidcIssuer = runtimeOidcIssuer();
    if (homeserverUrl !== homeserver) {
      throw new Error("OIDC callback homeserver does not match the configured environment");
    }
    if (oidcClientSettings.issuer !== oidcIssuer) {
      throw new Error("OIDC callback issuer does not match the configured environment");
    }
    const expectedClientId = loadCachedClientId(oidcIssuer);
    if (!expectedClientId || oidcClientSettings.clientId !== expectedClientId) {
      throw new Error("OIDC callback client identity could not be verified");
    }

    const accessToken = boundedToken(tokenResponse.access_token, "OIDC access token");

    const refreshToken = boundedToken(tokenResponse.refresh_token, "OIDC refresh token");

    const scope = boundedString(tokenResponse.scope, "OIDC scope", MAX_OIDC_CALLBACK_FIELD_BYTES);
    const deviceId = extractDeviceIdFromScope(scope);
    if (!deviceId) {
      throw new Error("completeOidcLoginFromCallback: granted scope did not include a device_id");
    }

    const who = await whoAmI(homeserverUrl, accessToken, signal);
    if (who.deviceId !== deviceId) {
      throw new Error("OIDC device identity could not be verified");
    }
    boundedString(who.userId, "OIDC user identity", MAX_OIDC_CALLBACK_FIELD_BYTES);
    boundedString(who.deviceId, "OIDC device identity", MAX_OIDC_CALLBACK_FIELD_BYTES);
    if (!isRuntimeMatrixUserId(who.userId) || !isRuntimeMatrixDeviceId(who.deviceId)) {
      throw new Error("OIDC Matrix identity could not be verified");
    }

    if (loadPendingRevocations().length !== 0) throw new Error(SESSION_CLEANUP_PENDING_ERROR);
    return {
      homeserver: homeserverUrl,
      userId: who.userId,
      deviceId,
      accessToken,
      refreshToken,
      oidcClientId: oidcClientSettings.clientId,
    };
  } catch (error) {
    // The authorization server has already issued a bearer token. Revoke it before
    // reporting a callback validation failure; if that request is uncertain, retain
    // only a tab-scoped retry record so the next sign-in attempt can retry revocation.
    let accessToken: string | null = null;
    try {
      accessToken = boundedToken(tokenResponse.access_token, "OIDC access token");
    } catch {
      // Do not send an unbounded provider field to the revocation endpoint.
    }
    let cleanupConfirmed = false;
    try {
      const { homeserver } = getRuntimeSettings();
      if (homeserverUrl === homeserver && accessToken) {
        const target = { homeserver: homeserverUrl, accessToken };
        await revokeMatrixSession(target, undefined, signal);
        cleanupConfirmed = clearPendingRevocation(target);
      }
    } catch {
      // The original callback failure remains the user-facing result unless its bearer token
      // cannot be recorded for a same-tab revocation retry.
    }
    const canRetryCleanup =
      homeserverUrl === getRuntimeSettings().homeserver &&
      accessToken !== null;
    if (!cleanupConfirmed && canRetryCleanup && accessToken !== null) {
      cleanupConfirmed = savePendingRevocation({
        homeserver: homeserverUrl,
        accessToken,
      });
    }
    if (!cleanupConfirmed && canRetryCleanup) {
      throw new Error(SESSION_CLEANUP_PERSISTENCE_ERROR);
    }
    throw error;
  }
}
