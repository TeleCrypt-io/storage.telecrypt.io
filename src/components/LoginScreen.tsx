import { useState } from "react";
import { useStorage } from "../context/StorageContext";

const DEFAULT_HOMESERVER = "http://localhost:8008";

export function LoginScreen() {
  const { loginWithOidc, error, status } = useStorage();

  // Lock homeserver to production value if configured, otherwise use default
  const lockedHomeserver =
    import.meta.env.VITE_HOMESERVER ??
    (import.meta.env.PROD ? "https://backend.telecrypt.io" : undefined);
  const [homeserver, setHomeserver] = useState(lockedHomeserver || DEFAULT_HOMESERVER);

  const busy = status === "connecting";

  async function handleOidc() {
    await loginWithOidc(homeserver);
  }

  // MAS OAuth is the sole login path in every build. The app never accepts or
  // receives a Matrix password; local integration tests use a disposable MAS.
  const oidcLabel = lockedHomeserver
    ? `Log in with ${new URL(lockedHomeserver).host}`
    : "Log in with MAS/OIDC";

  return (
    <div className="centered">
      <div className="panel">
        <h1>TeleCrypt.io Storage</h1>
        {!lockedHomeserver && (
          <>
            <label>
              Homeserver
              <input
                value={homeserver}
                onChange={(e) => setHomeserver(e.target.value)}
                data-testid="homeserver"
              />
            </label>
          </>
        )}
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
