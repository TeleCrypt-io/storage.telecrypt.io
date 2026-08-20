import { useStorage } from "../context/StorageContext";
import { BUILD_HOMESERVER } from "../lib/buildConfig";

export function LoginScreen() {
  const { loginWithOidc, error, status } = useStorage();
  // The product always uses MAS/OIDC. A local development server can be
  // selected explicitly, but password compatibility authentication is never
  // exposed by this client.
  const busy = status === "connecting";

  async function handleOidc() {
    await loginWithOidc();
  }

  const oidcLabel = `Log in with ${new URL(BUILD_HOMESERVER).host}`;

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
