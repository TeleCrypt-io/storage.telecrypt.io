import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { TeleCryptIOStorage } from "../lib/core";
import { assertRuntimeOidcEndpoint } from "../lib/buildConfig";
import { clearSession, loadSession, saveSession, type Session } from "../lib/session";
import { prefetchCryptoWasm, watchWasmResourceProgress } from "../lib/wasmProgress";

export type ConnectionStatus = "signed-out" | "connecting" | "ready" | "error";

export interface ConnectLogEntry {
  at: number;
  message: string;
}

/** First-time WASM + IndexedDB init on GitHub Pages can take 30–60s. */
const UI_INIT_TIMEOUT_MS = 90_000;
const UI_SYNC_TIMEOUT_MS = 45_000;
/** Hard ceiling for the whole connect() call — never leave users on infinite Connecting. */
const UI_CONNECT_TIMEOUT_MS = 120_000;

interface StorageContextValue {
  status: ConnectionStatus;
  session: Session | null;
  storage: TeleCryptIOStorage | null;
  error: string | null;
  /** Live status lines while connecting (empty when not connecting). */
  connectLog: ConnectLogEntry[];
  /** Starts the OIDC/MAS login redirect — does not return on success
   * (navigates away). Sets `status`/`error` if discovery/DCR fail before
   * the redirect. */
  loginWithOidc: () => Promise<void>;
  logout: () => void;
}

const StorageContext = createContext<StorageContextValue | null>(null);

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]);
}

export function StorageProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ConnectionStatus>("signed-out");
  const [session, setSession] = useState<Session | null>(null);
  const [storage, setStorage] = useState<TeleCryptIOStorage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectLog, setConnectLog] = useState<ConnectLogEntry[]>([]);
  // Dedupes concurrent connect() calls for the same access token and guards
  // against building a second MatrixClient from a re-render racing auto-connect.
  const connectInflightRef = useRef<{ token: string; promise: Promise<void> } | null>(null);
  const connectGenRef = useRef(0);
  const connectStartedAtRef = useRef<number | null>(null);

  const appendLog = useCallback((message: string) => {
    setConnectLog((prev) => [...prev, { at: Date.now(), message }]);
  }, []);

  const appendOrReplaceDownloadLog = useCallback((message: string) => {
    setConnectLog((prev) => {
      const last = prev[prev.length - 1];
      if (last?.message.startsWith("Downloading encryption engine")) {
        return [...prev.slice(0, -1), { at: Date.now(), message }];
      }
      return [...prev, { at: Date.now(), message }];
    });
  }, []);

  const beginConnecting = useCallback((firstMessage: string) => {
    connectStartedAtRef.current = Date.now();
    setStatus("connecting");
    setError(null);
    setConnectLog([{ at: Date.now(), message: firstMessage }]);
  }, []);

  const connect = useCallback(
    async (s: Session) => {
      const inflight = connectInflightRef.current;
      if (inflight?.token === s.accessToken) {
        return inflight.promise;
      }

      const gen = ++connectGenRef.current;

      const run = (async () => {
        // Keep the latest persisted token set for this client. OAuth providers may rotate the
        // refresh token on one response and omit it on a later response; falling back to the
        // session captured at connect() time would then resurrect an invalid, pre-rotation token.
        let currentSession = s;
        // Keep an existing log (e.g. an OIDC callback already
        // started connecting) instead of wiping it when connect() runs.
        if (connectStartedAtRef.current == null) {
          beginConnecting(`Restoring session for ${s.userId}…`);
        } else {
          appendLog(`Opening encrypted session for ${s.userId}…`);
        }
        try {
          const wasmWatchStop = watchWasmResourceProgress(appendOrReplaceDownloadLog);
          void prefetchCryptoWasm(appendOrReplaceDownloadLog);
          const bootstrapOpts = {
            syncTimeoutMs: UI_SYNC_TIMEOUT_MS,
            initTimeoutMs: UI_INIT_TIMEOUT_MS,
            onProgress: (message: string) => {
              if (gen !== connectGenRef.current) return;
              if (message.startsWith("Downloading encryption engine")) {
                appendOrReplaceDownloadLog(message);
              } else {
                appendLog(message);
              }
            },
          };
          let client!: TeleCryptIOStorage;
          try {
            appendLog("Discovering authentication server…");
            // Crypto and the Matrix SDK are intentionally fetched only when a
            // session is being opened, not on the public sign-in screen.
            const core = await import("../lib/core");
            const authMetadata = await core.discoverOidcIssuer(s.homeserver);
            if (authMetadata.issuer !== s.oidcIssuer) {
              throw new Error("Authentication issuer changed; log in again");
            }
            const tokenEndpoint = assertRuntimeOidcEndpoint(
              authMetadata.token_endpoint,
              "OIDC token endpoint",
            );
            appendLog(`Auth issuer: ${authMetadata.issuer}`);
            const tokenRefreshFunction = core.buildTokenRefreshFunction(
              tokenEndpoint,
              s.oidcClientId,
              async (tokens) => {
                currentSession = {
                  ...currentSession,
                  accessToken: tokens.accessToken,
                  refreshToken: tokens.refreshToken ?? currentSession.refreshToken,
                };
                saveSession(currentSession);
                if (gen === connectGenRef.current) setSession(currentSession);
              },
            );
            appendLog("Building encrypted client (OIDC session)…");
            client = await core.TeleCryptIOStorage.createFromOidc({
              baseUrl: s.homeserver,
              userId: s.userId,
              accessToken: s.accessToken,
              deviceId: s.deviceId,
              refreshToken: s.refreshToken,
              tokenRefreshFunction,
              ...bootstrapOpts,
            });
          } finally {
            wasmWatchStop();
          }
          if (gen !== connectGenRef.current) {
            client.getClient().stopClient();
            return;
          }
          appendLog("Connected.");
          setStorage(client);
          setSession(currentSession);
          setStatus("ready");
        } catch (err) {
          if (gen !== connectGenRef.current) return;
          const msg = (err as Error).message;
          appendLog(`Failed: ${msg}`);
          setError(msg);
          setStatus("error");
        }
      })();

      const timed = withTimeout(run, UI_CONNECT_TIMEOUT_MS, "Connection").catch((err) => {
        if (gen !== connectGenRef.current) return;
        const msg = (err as Error).message;
        appendLog(`Failed: ${msg}`);
        setError(msg);
        setStatus("error");
      });

      connectInflightRef.current = { token: s.accessToken, promise: timed };
      try {
        await timed;
      } finally {
        if (connectInflightRef.current?.promise === timed) {
          connectInflightRef.current = null;
        }
      }
    },
    [appendLog, appendOrReplaceDownloadLog, beginConnecting],
  );

  useEffect(() => {
    const callbackParams = new URLSearchParams(window.location.search);
    if (callbackParams.has("code") && callbackParams.has("state")) {
      beginConnecting("Completing sign-in…");
      void import("../lib/oidcAuth")
        .then(({ completeOidcLoginFromCallback }) => completeOidcLoginFromCallback())
        .then((s) => {
          appendLog(`Signed in as ${s.userId}`);
          saveSession(s);
          return connect(s);
        })
        .catch((err) => {
          const msg = (err as Error).message;
          appendLog(`Failed: ${msg}`);
          setError(msg);
          setStatus("error");
        });
      // Intentionally run once on mount only; loginWithOidc() drives
      // subsequent connections explicitly.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      return;
    }
    const existing = loadSession();
    if (existing) {
      void connect(existing);
    }
    // Intentionally run once on mount only; loginWithOidc() drives
    // subsequent connections explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loginWithOidc = useCallback(
    async () => {
      beginConnecting("Redirecting to sign-in…");
      try {
        const { beginOidcLogin } = await import("../lib/oidcAuth");
        await beginOidcLogin(); // navigates away on success
      } catch (err) {
        const msg = (err as Error).message;
        appendLog(`Failed: ${msg}`);
        setError(msg);
        setStatus("error");
      }
    },
    [appendLog, beginConnecting],
  );

  const logout = useCallback(() => {
    connectGenRef.current += 1;
    storage?.getClient().stopClient();
    clearSession();
    connectInflightRef.current = null;
    connectStartedAtRef.current = null;
    setStorage(null);
    setSession(null);
    setConnectLog([]);
    setStatus("signed-out");
    setError(null);
  }, [storage]);

  return (
    <StorageContext.Provider
      value={{
        status,
        session,
        storage,
        error,
        connectLog,
        loginWithOidc,
        logout,
      }}
    >
      {children}
    </StorageContext.Provider>
  );
}

// The provider and its paired hook intentionally share this module's private context.
// oxlint-disable-next-line react/only-export-components
export function useStorage(): StorageContextValue {
  const ctx = useContext(StorageContext);
  if (!ctx) throw new Error("useStorage() must be used within a StorageProvider");
  return ctx;
}
