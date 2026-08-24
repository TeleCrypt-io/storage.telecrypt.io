const OIDC_CALLBACK_PARAMETERS = [
  "code",
  "state",
  "error",
  "error_description",
  "error_uri",
  "iss",
  "session_state",
] as const;
const OIDC_CALLBACK_PARAMETER_SET = new Set<string>(OIDC_CALLBACK_PARAMETERS);

export const MAX_OIDC_CALLBACK_URL_BYTES = 16 * 1024;
export const MAX_OIDC_CALLBACK_FIELD_BYTES = 4096;

export type OidcCallbackKind = "none" | "success" | "error" | "malformed";

type OidcCallbackLocation = Pick<Location, "search" | "hash">;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Merge query and fragment response parameters while retaining duplicates for strict validation. */
export function readOidcCallbackParams(location: OidcCallbackLocation): URLSearchParams {
  const params = new URLSearchParams(location.search || "");
  const hash = location.hash || "";
  if (hash.startsWith("#")) {
    const fragmentParams = new URLSearchParams(hash.slice(1));
    for (const [key, value] of fragmentParams) {
      params.append(key, value);
    }
  }
  return params;
}

function hasExactlyOne(params: URLSearchParams, name: string): boolean {
  return params.getAll(name).length === 1;
}

export function scrubOidcCallbackParams(location: Pick<Location, "pathname">): void {
  window.history.replaceState({}, "", location.pathname || "/");
}

export function classifyOidcCallback(location: OidcCallbackLocation): OidcCallbackKind {
  const rawSearch = location.search || "";
  const rawHash = location.hash || "";
  if (utf8ByteLength(rawSearch) + utf8ByteLength(rawHash) > MAX_OIDC_CALLBACK_URL_BYTES) {
    return "malformed";
  }

  const params = readOidcCallbackParams(location);
  const hasRecognized = OIDC_CALLBACK_PARAMETERS.some((name) => params.has(name));
  if (!hasRecognized) return params.toString() ? "malformed" : "none";

  for (const [name, value] of params) {
    if (!OIDC_CALLBACK_PARAMETER_SET.has(name)) return "malformed";
    if (params.getAll(name).length !== 1 || utf8ByteLength(value) > MAX_OIDC_CALLBACK_FIELD_BYTES) {
      return "malformed";
    }
  }

  const code = hasExactlyOne(params, "code");
  const state = hasExactlyOne(params, "state");
  const error = hasExactlyOne(params, "error");
  if (code && state && !error) {
    if (!params.get("code") || !params.get("state") || params.has("error_description") || params.has("error_uri")) {
      return "malformed";
    }
    return "success";
  }
  if (error && state && !code) {
    if (!params.get("error") || !params.get("state")) return "malformed";
    return "error";
  }
  return "malformed";
}

export function hasOidcCallbackParams(location: OidcCallbackLocation): boolean {
  const kind = classifyOidcCallback(location);
  return kind === "success" || kind === "error";
}
