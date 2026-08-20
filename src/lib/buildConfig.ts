/**
 * The storage site is built for exactly one Matrix homeserver and OIDC issuer.
 * Production builds must provide both values explicitly. The localhost values
 * are only a convenience for the disposable development fixture and unit
 * tests.
 */
const developmentHomeserver = "http://localhost:8008";
const developmentIssuer = "https://auth.example.test/";

function buildValue(name: string, value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (import.meta.env.PROD) {
    throw new Error(`${name} is required for a production storage-web build`);
  }
  return fallback;
}

export const BUILD_HOMESERVER = buildValue(
  "VITE_HOMESERVER",
  import.meta.env.VITE_HOMESERVER,
  developmentHomeserver,
);
export const BUILD_OIDC_ISSUER = buildValue(
  "VITE_OIDC_ISSUER",
  import.meta.env.VITE_OIDC_ISSUER,
  developmentIssuer,
);
