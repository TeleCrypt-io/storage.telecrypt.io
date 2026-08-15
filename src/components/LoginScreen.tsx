import { useStorage } from "../context/StorageContext";

export function LoginScreen() {
  const { loginWithOidc, error, status } = useStorage();
  // The product always uses MAS/OIDC. A local development server can be
  // selected explicitly, but password compatibility authentication is never
  // exposed by this client.
  const homeserver =
    import.meta.env.VITE_HOMESERVER ??
    (import.meta.env.PROD ? "https://backend.telecrypt.io" : undefined);
  const resolvedHomeserver = homeserver ?? "http://localhost:8008";

  const busy = status === "connecting";

  async function handleOidc() {
    await loginWithOidc(resolvedHomeserver);
  }

  const oidcLabel = `Log in with ${new URL(resolvedHomeserver).host}`;

  return (
    <div className="centered">
      <div className="panel">
        <h1>TeleCrypt.io Storage</h1>
        {error && (
          <p className="error" data-testid="auth-error">
            {error}
          </p>
        )}
        <button type="button" disabled={busy} onClick={handleOidc} data-testid="oidc-login">
          {busy ? "Working…" : oidcLabel}
        </button>
      </div>
    </div>
  );
}
