/**
 * Public, non-secret settings are loaded after the static bundle starts. This
 * keeps the JavaScript identical between environments while allowing each
 * environment to serve its own runtime-settings.json.
 */
export interface RuntimeSettings {
  homeserver: string;
  oidcIssuer: string;
}

const developmentSettings: RuntimeSettings = {
  homeserver: "http://localhost:8008",
  oidcIssuer: "https://auth.example.test/",
};

let runtimeSettings: RuntimeSettings | null = import.meta.env.DEV ? developmentSettings : null;

function canonicalTeleCryptUrl(name: string, value: unknown, expectedPath: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty URL`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.port !== "" ||
    (parsed.hostname !== "telecrypt.io" && !parsed.hostname.endsWith(".telecrypt.io"))
  ) {
    throw new Error(`${name} must be a canonical HTTPS TeleCrypt URL`);
  }

  if (parsed.pathname !== expectedPath) {
    throw new Error(`${name} must use the canonical ${expectedPath} path`);
  }

  const canonical = expectedPath === "/" ? parsed.origin : `${parsed.origin}${expectedPath}`;
  if (value !== canonical) {
    throw new Error(`${name} must use canonical spelling: ${canonical}`);
  }
  return canonical;
}

export function validateRuntimeSettings(value: unknown): RuntimeSettings {
  if (!value || typeof value !== "object") {
    throw new Error("Runtime settings must be a JSON object");
  }
  const raw = value as Partial<RuntimeSettings>;
  const homeserver = canonicalTeleCryptUrl("homeserver", raw.homeserver, "/");
  const oidcIssuer = canonicalTeleCryptUrl("oidcIssuer", raw.oidcIssuer, "/auth/");
  if (new URL(homeserver).origin !== new URL(oidcIssuer).origin) {
    throw new Error("homeserver and oidcIssuer must have the same origin");
  }
  return { homeserver, oidcIssuer };
}

export function getRuntimeSettings(): RuntimeSettings {
  if (!runtimeSettings) throw new Error("Runtime settings have not been loaded");
  return runtimeSettings;
}

export function assertRuntimeOidcEndpoint(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} is missing from OIDC discovery`);
  const issuer = new URL(getRuntimeSettings().oidcIssuer);
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.origin !== issuer.origin ||
    !endpoint.pathname.startsWith(issuer.pathname) ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.port !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.toString() !== value
  ) {
    throw new Error(`${name} must remain on the configured OIDC origin and /auth/ path`);
  }
  return value;
}

export async function fetchRuntimeSettings(
  fetchSettings: typeof fetch = fetch,
  origin: string = window.location.origin,
): Promise<RuntimeSettings> {
  const settingsUrl = new URL("/runtime-settings.json", origin);
  const response = await fetchSettings(settingsUrl, {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(`Runtime settings request failed with HTTP ${response.status}`);
  }
  return validateRuntimeSettings(await response.json());
}

export async function loadRuntimeSettings(): Promise<void> {
  if (import.meta.env.DEV) {
    runtimeSettings = developmentSettings;
    return;
  }
  runtimeSettings = await fetchRuntimeSettings();
}
