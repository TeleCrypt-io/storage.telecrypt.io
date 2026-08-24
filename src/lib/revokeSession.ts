import { getRuntimeSettings } from "./buildConfig";

const SESSION_REVOKE_TIMEOUT_MS = 10_000;
const MAX_REVOCATION_TOKEN_BYTES = 8192;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export type SessionRevocationTarget = {
  homeserver: string;
  accessToken: string;
};

export type SessionRevocationFailure = "failed" | "timed-out";

export class SessionRevocationError extends Error {
  readonly reason: SessionRevocationFailure;

  constructor(reason: SessionRevocationFailure) {
    super(reason === "timed-out" ? "Session revocation timed out" : "Session revocation failed");
    this.name = "SessionRevocationError";
    this.reason = reason;
  }
}

function logoutEndpoint(homeserver: string): string {
  let runtimeHomeserver: URL;
  let sessionHomeserver: URL;
  try {
    runtimeHomeserver = new URL(getRuntimeSettings().homeserver);
    sessionHomeserver = new URL(homeserver);
  } catch {
    throw new SessionRevocationError("failed");
  }

  // Never send a token to a host selected by session data. The persisted session must
  // still match the immutable runtime binding before this request is made.
  if (sessionHomeserver.toString() !== runtimeHomeserver.toString()) {
    throw new SessionRevocationError("failed");
  }
  return new URL("/_matrix/client/v3/logout", runtimeHomeserver).toString();
}

function cancelResponseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Cleanup is best effort; the revocation result remains user-safe.
  }
}

/**
 * Revokes the Matrix access token without sending a request body or reading an
 * untrusted response body. Failure is intentionally represented by a stable,
 * user-safe error so upstream server text never reaches the UI.
 */
export async function revokeMatrixSession(
  target: SessionRevocationTarget,
  fetchImpl: typeof fetch = fetch,
  externalSignal?: AbortSignal,
): Promise<void> {
  if (
    typeof target.accessToken !== "string" ||
    target.accessToken.trim() === "" ||
    utf8ByteLength(target.accessToken) > MAX_REVOCATION_TOKEN_BYTES ||
    [...target.accessToken].some(
      (character) =>
        /\s/u.test(character) || character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
    )
  ) {
    throw new SessionRevocationError("failed");
  }

  const endpoint = logoutEndpoint(target.homeserver);
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new SessionRevocationError("timed-out"));
    }, SESSION_REVOKE_TIMEOUT_MS);
  });
  let rejectExternal!: (reason: SessionRevocationError) => void;
  const externalAbort = new Promise<never>((_, reject) => {
    rejectExternal = reject;
  });
  const abortFromCaller = (): void => {
    externallyAborted = true;
    controller.abort(externalSignal?.reason);
    rejectExternal(new SessionRevocationError("failed"));
  };
  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const request = Promise.resolve().then(() =>
    fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${target.accessToken}` },
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
    }),
  );
  // A response can arrive after the timeout/caller race has already rejected.
  // Observe that late response and release its body without awaiting it.
  void request.then(
    (response) => {
      if (timedOut || externallyAborted) cancelResponseBody(response);
    },
    () => undefined,
  );

  try {
    const response = await Promise.race([request, timeout, externalAbort]);
    if (response.redirected || response.url !== endpoint) {
      cancelResponseBody(response);
      throw new SessionRevocationError("failed");
    }
    // Matrix returns 401/M_UNKNOWN_TOKEN when this device token was already
    // invalidated (for example, the first logout succeeded but its response was
    // lost). That is a definitive least-privilege outcome, so retry is
    // idempotent without reading or trusting the response body.
    if (response.status !== 200 && response.status !== 204 && response.status !== 401) {
      cancelResponseBody(response);
      throw new SessionRevocationError("failed");
    }
    cancelResponseBody(response);
  } catch (error) {
    if (error instanceof SessionRevocationError) throw error;
    throw new SessionRevocationError(timedOut ? "timed-out" : "failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
}
