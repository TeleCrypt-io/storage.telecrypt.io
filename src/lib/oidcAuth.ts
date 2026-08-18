/**
 * OIDC/MAS login for the web UI: authorization-code + PKCE. Thin browser
 * adapter over the shared `src/core/oidc.ts` protocol calls (discovery, DCR,
 * PKCE URL building, token exchange) — mirrors what src/cli/oidc.ts does for
 * the CLI's device-code flow.
 *
 * PKCE code_verifier + state are persisted by matrix-js-sdk/oidc-client-ts
 * itself, in window.sessionStorage (`mx_oidc_`-prefixed keys) — this module
 * does not manage them. The one thing THIS module persists is the DCR
 * client_id, in localStorage keyed by issuer, so repeat logins against the
 * same homeserver don't re-register a new client every time.
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

const CLIENT_ID_PREFIX = "telecrypt-io-ui:oidc-client:";
const DEVICE_ID_PREFIX = "telecrypt-io-ui:device:";

function redirectUri(): string {
  return window.location.origin + "/";
}

function loadCachedClientId(issuer: string): string | null {
  return localStorage.getItem(CLIENT_ID_PREFIX + issuer);
}

function cacheClientId(issuer: string, clientId: string): void {
  localStorage.setItem(CLIENT_ID_PREFIX + issuer, clientId);
}

/**
 * Returns this browser's stable Matrix device id for the given issuer,
 * creating and persisting one on first use. Reusing the same device id on
 * every login makes MAS grant the SAME Matrix device instead of minting a
 * fresh one per login — without this, an account that logs in repeatedly
 * accumulates hundreds of devices, and room-key shares to all of them time
 * out (60s sendToDevice ceiling), breaking uploads.
 */
function loadOrCreateDeviceId(issuer: string): string {
  const key = DEVICE_ID_PREFIX + issuer;
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  const deviceId = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  localStorage.setItem(key, deviceId);
  return deviceId;
}

/**
 * Starts the OIDC login flow: discovery → DCR (cached) → PKCE authorization
 * URL → redirect. Never returns normally on success (navigates away);
 * throws before redirecting if discovery/DCR fail.
 */
export async function beginOidcLogin(homeserver: string): Promise<void> {
  const authMetadata = await discoverOidcIssuer(homeserver);

  let clientId = loadCachedClientId(authMetadata.issuer);
  if (!clientId) {
    clientId = await registerClient(authMetadata, {
      clientName: "TeleCrypt.io Storage (Web)",
      clientUri: redirectUri(),
      applicationType: "web",
      redirectUris: [redirectUri()],
      contacts: undefined,
      tosUri: undefined,
      policyUri: undefined,
    });
    cacheClientId(authMetadata.issuer, clientId);
  }

  const url = await beginAuthorizationCodeFlow({
    authMetadata,
    clientId,
    homeserverUrl: homeserver,
    redirectUri: redirectUri(),
    deviceId: loadOrCreateDeviceId(authMetadata.issuer),
  });
  window.location.href = url;
}

/** True if the current URL looks like an OIDC authorization-code callback
 * (`?code=...&state=...`). Checked on app load before falling back to a
 * previously-saved session. */
export function isOidcCallback(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.has("code") && params.has("state");
}

/**
 * Completes the authorization-code exchange from the current URL's
 * `?code&state`, confirms identity via `/whoami`, and clears the query
 * params from the address bar (so a reload doesn't try to replay the
 * one-time code). Returns a `Session` ready to `saveSession()`.
 */
export async function completeOidcLoginFromCallback(): Promise<Session> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) {
    throw new Error("completeOidcLoginFromCallback: no ?code&state in the current URL");
  }

  const { tokenResponse, oidcClientSettings, homeserverUrl } = await completeAuthorizationCodeFlow(
    code,
    state,
  );

  if (!tokenResponse.refresh_token) {
    throw new Error("completeOidcLoginFromCallback: MAS returned no refresh token");
  }

  // Clear the one-time code/state from the address bar before anything else
  // can observe them (e.g. a refresh replaying a spent code).
  window.history.replaceState({}, "", window.location.pathname);

  const deviceId = extractDeviceIdFromScope(tokenResponse.scope);
  if (!deviceId) {
    throw new Error("completeOidcLoginFromCallback: granted scope did not include a device_id");
  }

  const who = await whoAmI(homeserverUrl, tokenResponse.access_token);
  if (who.deviceId && who.deviceId !== deviceId) {
    throw new Error(
      `device_id mismatch after OIDC login: scope said ${deviceId}, server confirmed ${who.deviceId}`,
    );
  }

  return {
    homeserver: homeserverUrl,
    userId: who.userId,
    deviceId,
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    oidcIssuer: oidcClientSettings.issuer,
    oidcClientId: oidcClientSettings.clientId,
  };
}
