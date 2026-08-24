import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeSettings } from "./buildConfig";
import { revokeMatrixSession } from "./revokeSession";

const target = {
  homeserver: getRuntimeSettings().homeserver,
  accessToken: "access-token-secret",
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("revokeMatrixSession", () => {
  it("uses the same-homeserver logout endpoint without a request body", async () => {
    const response = new Response(null, { status: 204 });
    Object.defineProperty(response, "url", { value: `${target.homeserver}/_matrix/client/v3/logout` });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);

    await revokeMatrixSession(target, fetchMock);

    expect(fetchMock).toHaveBeenCalledWith(
      `${target.homeserver}/_matrix/client/v3/logout`,
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        redirect: "manual",
        headers: { Authorization: `Bearer ${target.accessToken}` },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("body");
  });

  it("turns an HTTP failure into a safe error without reading its body", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("token-body-secret", { status: 503 }));

    const result = revokeMatrixSession(target, fetchMock);

    await expect(result).rejects.toMatchObject({ reason: "failed" });
    await expect(result).rejects.not.toThrow("token-body-secret");
  });

  it("accepts an already-invalid token as confirmed cleanup", async () => {
    const endpoint = `${target.homeserver}/_matrix/client/v3/logout`;
    const response = new Response("unknown token", { status: 401 });
    Object.defineProperty(response, "url", { value: endpoint });
    const cancel = vi.spyOn(response.body!, "cancel");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(revokeMatrixSession(target, fetchMock)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects a redirect instead of following it", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://other.example/logout" } }),
    );

    await expect(revokeMatrixSession(target, fetchMock)).rejects.toMatchObject({ reason: "failed" });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it.each([302, 503, 204] as const)("does not await never-settling body cancellation for %s", async (status) => {
    const endpoint = `${target.homeserver}/_matrix/client/v3/logout`;
    const response = new Response(null, { status });
    Object.defineProperty(response, "url", { value: endpoint });
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    Object.defineProperty(response, "body", { value: { cancel } });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    const result = revokeMatrixSession(target, fetchMock);
    if (status === 204) {
      await expect(result).resolves.toBeUndefined();
    } else {
      await expect(result).rejects.toMatchObject({ reason: "failed" });
    }
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("turns a network failure into a safe error", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("network token-body-secret"));

    await expect(revokeMatrixSession(target, fetchMock)).rejects.toMatchObject({ reason: "failed" });
    await expect(revokeMatrixSession(target, fetchMock)).rejects.not.toThrow("token-body-secret");
  });

  it("bounds a hung request and aborts it", async () => {
    vi.useFakeTimers();
    const pending = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(pending.promise);

    const result = revokeMatrixSession(target, fetchMock);
    const assertion = expect(result).rejects.toMatchObject({ reason: "timed-out" });
    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
    expect(fetchMock.mock.calls[0][1]?.signal).toMatchObject({ aborted: true });
    pending.resolve(new Response(null, { status: 204 }));
  });

  it("cancels a late response after caller abort without awaiting body cleanup", async () => {
    const controller = new AbortController();
    const pending = deferred<Response>();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(pending.promise);
    const result = revokeMatrixSession(target, fetchMock, controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ reason: "failed" });
    const late = new Response(null, { status: 204 });
    Object.defineProperty(late, "url", { value: `${target.homeserver}/_matrix/client/v3/logout` });
    Object.defineProperty(late, "body", { value: { cancel } });
    pending.resolve(late);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  it("rejects a session target that is not the configured homeserver", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      revokeMatrixSession({ ...target, homeserver: "https://attacker.example.test/" }, fetchMock),
    ).rejects.toMatchObject({ reason: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized token before sending an authorization header", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      revokeMatrixSession({ ...target, accessToken: "x".repeat(8193) }, fetchMock),
    ).rejects.toMatchObject({ reason: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["token\nwith-control", "token with-space", "token\u007fwith-delete"])(
    "rejects a token containing whitespace/control characters (%s)",
    async (accessToken) => {
      const fetchMock = vi.fn<typeof fetch>();
      await expect(revokeMatrixSession({ ...target, accessToken }, fetchMock)).rejects.toMatchObject({
        reason: "failed",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
