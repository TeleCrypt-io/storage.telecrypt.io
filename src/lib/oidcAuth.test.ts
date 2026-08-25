// Unit tests for the stable device-id persistence in the OIDC login flow.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { beginOidcLogin, completeOidcLoginFromCallback } from "./oidcAuth";
import { getRuntimeSettings } from "./buildConfig";
import { OIDC_LOGIN_INTENT_STORAGE_KEY } from "./session";
import * as core from "./core";
import * as revocation from "./revokeSession";

vi.mock("./core", async () => {
  const actual = await vi.importActual<typeof import("./core")>("./core");
  return {
    ...actual,
    discoverOidcIssuer: vi.fn(),
    registerClient: vi.fn(),
    beginAuthorizationCodeFlow: vi.fn(),
    completeAuthorizationCodeFlow: vi.fn(),
    whoAmI: vi.fn(),
  };
});

vi.mock("./revokeSession", () => ({
  revokeMatrixSession: vi.fn(),
}));

const METADATA = {
  issuer: `${getRuntimeSettings().homeserver}/auth/`,
  authorization_endpoint: `${getRuntimeSettings().homeserver}/auth/authorize`,
  token_endpoint: `${getRuntimeSettings().homeserver}/auth/token`,
  registration_endpoint: `${getRuntimeSettings().homeserver}/auth/register`,
};

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (k: string) => values.get(k) ?? null,
    key: (i: number) => [...values.keys()][i] ?? null,
    removeItem: (k: string) => void values.delete(k),
    setItem: (k: string, v: string) => void values.set(k, v),
  };
}

beforeEach(() => {
  vi.mocked(core.discoverOidcIssuer).mockResolvedValue(METADATA as never);
  vi.mocked(core.registerClient).mockResolvedValue("client-123");
  vi.mocked(core.beginAuthorizationCodeFlow).mockResolvedValue(
    `${METADATA.authorization_endpoint}?x=1&state=two`,
  );
  vi.mocked(revocation.revokeMatrixSession).mockResolvedValue(undefined);
  const tabStorage = memoryStorage();
  const persistentStorage = memoryStorage();
  persistentStorage.setItem(
    "telecrypt-io-ui:oidc-client:" + METADATA.issuer,
    "client-123",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: { origin: "http://localhost:5173", href: "http://localhost:5173/", search: "" },
      history: { replaceState: vi.fn() },
      sessionStorage: tabStorage,
      localStorage: persistentStorage,
    },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: persistentStorage,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    writable: true,
    value: tabStorage,
  });
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    writable: true,
    value: {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = (i + callCounter) % 256;
        callCounter += 1;
        return arr;
      },
    },
  });
  sessionStorage.removeItem(OIDC_LOGIN_INTENT_STORAGE_KEY);
});

let callCounter = 0;

function callback(search: string, hash = "") {
  const state = new URLSearchParams(search || hash.slice(1)).get("state");
  if (state) {
    sessionStorage.setItem(
      OIDC_LOGIN_INTENT_STORAGE_KEY,
      JSON.stringify({ state, createdAt: Date.now() }),
    );
  }
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { origin: "http://localhost:5173", search, hash, pathname: "/" },
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("beginOidcLogin stable device id", () => {
  it("forwards cancellation to authorization URL generation", async () => {
    const controller = new AbortController();
    vi.mocked(core.beginAuthorizationCodeFlow).mockImplementation(async (options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      return `${METADATA.authorization_endpoint}?x=1&state=two`;
    });

    await expect(beginOidcLogin(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(window.location.href).toBe("http://localhost:5173/");
  });

  it("passes a persisted device id to beginAuthorizationCodeFlow", async () => {
    await beginOidcLogin();
    const opts = vi.mocked(core.beginAuthorizationCodeFlow).mock.calls[0][0];
    expect(opts.deviceId).toMatch(/^[0-9A-F]{10}$/);

    // Second login reuses the SAME device id for this browser tab.
    await beginOidcLogin();
    const second = vi.mocked(core.beginAuthorizationCodeFlow).mock.calls[1][0];
    expect(second.deviceId).toBe(opts.deviceId);
  });

  it("does not reuse an oversized cached client identifier", async () => {
    localStorage.setItem(
      "telecrypt-io-ui:oidc-client:" + METADATA.issuer,
      "x".repeat(513),
    );

    await beginOidcLogin();

    expect(core.registerClient).toHaveBeenCalled();
  });

  it("rejects discovery from an issuer other than the runtime-configured issuer", async () => {
    vi.mocked(core.discoverOidcIssuer).mockResolvedValue({ issuer: "https://unexpected.example.test/" } as never);

    await expect(beginOidcLogin()).rejects.toThrow(
      "OIDC issuer does not match the configured environment",
    );
    expect(core.registerClient).not.toHaveBeenCalled();
  });

  it("revokes an existing session before starting a replacement login", async () => {
    sessionStorage.setItem(
      "telecrypt-io-ui:session",
      JSON.stringify({
        homeserver: getRuntimeSettings().homeserver,
        userId: "@alice:localhost",
        deviceId: "DEVICE1",
        accessToken: "old-access",
        refreshToken: "old-refresh",
        oidcClientId: "client-123",
      }),
    );

    await beginOidcLogin();

    expect(revocation.revokeMatrixSession).toHaveBeenCalledWith(
      expect.objectContaining({
        homeserver: getRuntimeSettings().homeserver,
        accessToken: "old-access",
      }),
      undefined,
      undefined,
    );
    expect(sessionStorage.getItem("telecrypt-io-ui:session")).toBeNull();
  });

  it("rejects a token endpoint outside the runtime-configured issuer", async () => {
    vi.mocked(core.discoverOidcIssuer).mockResolvedValue({
      ...METADATA,
      token_endpoint: "https://other.example.test/token",
    } as never);

    await expect(beginOidcLogin()).rejects.toThrow("OIDC token endpoint");
    expect(core.registerClient).not.toHaveBeenCalled();
  });

  it("rejects a callback for a different homeserver", async () => {
    callback("?code=one&state=two");
    vi.mocked(core.completeAuthorizationCodeFlow).mockResolvedValue({
      homeserverUrl: "https://unexpected.example.test",
      oidcClientSettings: { issuer: METADATA.issuer, clientId: "client-123" },
      tokenResponse: { access_token: "access", refresh_token: "refresh", scope: "scope" },
    } as never);

    await expect(completeOidcLoginFromCallback()).rejects.toThrow(
      "OIDC callback homeserver does not match the configured environment",
    );
    expect(window.history.replaceState).toHaveBeenCalledWith({}, "", "/");
    expect(core.whoAmI).not.toHaveBeenCalled();
  });

  it("rejects a callback issuer that is not the runtime issuer before exchange", async () => {
    callback("?code=one&state=two&iss=https%3A%2F%2Funexpected.example.test%2Fauth%2F");

    await expect(completeOidcLoginFromCallback()).rejects.toThrow(
      "Sign-in callback issuer could not be verified",
    );
    expect(core.completeAuthorizationCodeFlow).not.toHaveBeenCalled();
  });

  it("rejects a callback for a different issuer", async () => {
    callback("?code=one&state=two");
    vi.mocked(core.completeAuthorizationCodeFlow).mockResolvedValue({
      homeserverUrl: getRuntimeSettings().homeserver,
      oidcClientSettings: { issuer: "https://unexpected.example.test/", clientId: "client-123" },
      tokenResponse: { access_token: "access", refresh_token: "refresh", scope: "scope" },
    } as never);

    await expect(completeOidcLoginFromCallback()).rejects.toThrow(
      "OIDC callback issuer does not match the configured environment",
    );
    expect(window.history.replaceState).toHaveBeenCalledWith({}, "", "/");
    expect(core.whoAmI).not.toHaveBeenCalled();
  });

  it("rejects a callback for a different registered client", async () => {
    callback("?code=one&state=two");
    vi.mocked(core.completeAuthorizationCodeFlow).mockResolvedValue({
      homeserverUrl: getRuntimeSettings().homeserver,
      oidcClientSettings: { issuer: METADATA.issuer, clientId: "other-client" },
      tokenResponse: { access_token: "access", refresh_token: "refresh", scope: "scope" },
    } as never);

    await expect(completeOidcLoginFromCallback()).rejects.toThrow(
      "OIDC callback client identity could not be verified",
    );
    expect(core.whoAmI).not.toHaveBeenCalled();
  });

  it("scrubs a denied callback without exchanging the provider error", async () => {
    callback("?error=access_denied&state=two&error_description=secret");

    await expect(completeOidcLoginFromCallback()).rejects.toThrow("Sign-in was cancelled");
    expect(window.history.replaceState).toHaveBeenCalledWith({}, "", "/");
    expect(core.completeAuthorizationCodeFlow).not.toHaveBeenCalled();
  });

  it("retries a pending token revocation before accepting a callback", async () => {
    sessionStorage.setItem(
      "telecrypt-io-ui:pending-revocation",
      JSON.stringify({ homeserver: getRuntimeSettings().homeserver, accessToken: "old-access" }),
    );
    callback("?error=access_denied&state=two");

    await expect(completeOidcLoginFromCallback()).rejects.toThrow("Sign-in was cancelled");
    expect(revocation.revokeMatrixSession).toHaveBeenCalledWith({
      homeserver: getRuntimeSettings().homeserver,
      accessToken: "old-access",
    }, undefined, undefined);
    expect(sessionStorage.getItem("telecrypt-io-ui:pending-revocation")).toBeNull();
  });

  it("scrubs an error callback delivered in the URL fragment", async () => {
    callback("", "#error=access_denied&state=two&error_description=secret");

    await expect(completeOidcLoginFromCallback()).rejects.toThrow("Sign-in was cancelled");
    expect(window.history.replaceState).toHaveBeenCalledWith({}, "", "/");
    expect(core.completeAuthorizationCodeFlow).not.toHaveBeenCalled();
  });

  it("scrubs an unexpected provider error without exposing its description", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        origin: "http://localhost:5173",
        search: "?error=server_error&state=two&error_description=provider-secret",
        hash: "",
        pathname: "/",
      },
    });
    sessionStorage.setItem(
      OIDC_LOGIN_INTENT_STORAGE_KEY,
      JSON.stringify({ state: "two", createdAt: Date.now() }),
    );

    await expect(completeOidcLoginFromCallback()).rejects.toThrow("Sign-in failed");
    expect(window.history.replaceState).toHaveBeenCalledWith({}, "", "/");
    expect(core.completeAuthorizationCodeFlow).not.toHaveBeenCalled();
  });

  it("scrubs a successful callback before returning the validated session", async () => {
    callback("?code=one&state=two");
    vi.mocked(core.completeAuthorizationCodeFlow).mockResolvedValue({
      homeserverUrl: getRuntimeSettings().homeserver,
      oidcClientSettings: { issuer: METADATA.issuer, clientId: "client-123" },
      tokenResponse: {
        access_token: "access",
        refresh_token: "refresh",
        scope: "urn:matrix:client:device:DEVICE1234",
      },
    } as never);
    vi.mocked(core.whoAmI).mockResolvedValue({ userId: "@alice:localhost", deviceId: "DEVICE1234" });

    await expect(completeOidcLoginFromCallback()).resolves.toMatchObject({
      userId: "@alice:localhost",
      deviceId: "DEVICE1234",
    });
    expect(core.whoAmI).toHaveBeenCalledWith(
      "http://localhost:8008",
      "access",
      "localhost",
      undefined,
    );
    expect(window.history.replaceState).toHaveBeenCalledWith({}, "", "/");
  });

  it("revokes a callback token when tab session cleanup cannot be persisted", async () => {
    callback("?code=one&state=two");
    vi.mocked(core.completeAuthorizationCodeFlow).mockResolvedValue({
      homeserverUrl: getRuntimeSettings().homeserver,
      oidcClientSettings: { issuer: METADATA.issuer, clientId: "client-123" },
      tokenResponse: {
        access_token: "new-access",
        refresh_token: "new-refresh",
        scope: "urn:matrix:client:device:DEVICE1234",
      },
    } as never);
    vi.mocked(core.whoAmI).mockResolvedValue({ userId: "@alice:localhost", deviceId: "DEVICE1234" });
    const original = window.sessionStorage;
    const blocked = {
      get length() {
        return 0;
      },
      clear: () => undefined,
      getItem: () => null,
      key: () => null,
      removeItem: () => undefined,
      setItem: () => {
        throw new Error("session storage blocked");
      },
    } as unknown as Storage;
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: blocked });
    try {
      await expect(completeOidcLoginFromCallback()).rejects.toThrow("Session persistence failed");
      expect(core.completeAuthorizationCodeFlow).not.toHaveBeenCalled();
      expect(revocation.revokeMatrixSession).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        value: original,
      });
    }
  });

  it("revokes a newly issued token when callback identity validation fails", async () => {
    callback("?code=one&state=two");
    vi.mocked(core.completeAuthorizationCodeFlow).mockResolvedValue({
      homeserverUrl: getRuntimeSettings().homeserver,
      oidcClientSettings: { issuer: METADATA.issuer, clientId: "client-123" },
      tokenResponse: {
        access_token: "new-access",
        refresh_token: "new-refresh",
        scope: "urn:matrix:client:device:DEVICE1234",
      },
    } as never);
    vi.mocked(core.whoAmI).mockRejectedValue(new Error("whoami failed"));

    await expect(completeOidcLoginFromCallback()).rejects.toThrow("whoami failed");
    expect(revocation.revokeMatrixSession).toHaveBeenCalledWith({
      homeserver: getRuntimeSettings().homeserver,
      accessToken: "new-access",
    }, undefined, undefined);
  });

  it("rejects a callback when whoami omits the granted device identity", async () => {
    callback("?code=one&state=two");
    vi.mocked(core.completeAuthorizationCodeFlow).mockResolvedValue({
      homeserverUrl: getRuntimeSettings().homeserver,
      oidcClientSettings: { issuer: METADATA.issuer, clientId: "client-123" },
      tokenResponse: {
        access_token: "new-access",
        refresh_token: "new-refresh",
        scope: "urn:matrix:client:device:DEVICE1234",
      },
    } as never);
    vi.mocked(core.whoAmI).mockResolvedValue({ userId: "@alice:localhost", deviceId: null });

    await expect(completeOidcLoginFromCallback()).rejects.toThrow(
      "OIDC device identity could not be verified",
    );
    expect(revocation.revokeMatrixSession).toHaveBeenCalledWith({
      homeserver: getRuntimeSettings().homeserver,
      accessToken: "new-access",
    }, undefined, undefined);
  });

  it("rejects callback bearer tokens containing whitespace before whoami", async () => {
    callback("?code=one&state=two");
    vi.mocked(core.completeAuthorizationCodeFlow).mockResolvedValue({
      homeserverUrl: getRuntimeSettings().homeserver,
      oidcClientSettings: { issuer: METADATA.issuer, clientId: "client-123" },
      tokenResponse: {
        access_token: "new\naccess",
        refresh_token: "new-refresh",
        scope: "urn:matrix:client:device:DEVICE1234",
      },
    } as never);

    await expect(completeOidcLoginFromCallback()).rejects.toThrow("OIDC access token");
    expect(core.whoAmI).not.toHaveBeenCalled();
    expect(revocation.revokeMatrixSession).not.toHaveBeenCalled();
  });

  it("rejects a whoami identity from another Matrix server", async () => {
    callback("?code=one&state=two");
    vi.mocked(core.completeAuthorizationCodeFlow).mockResolvedValue({
      homeserverUrl: getRuntimeSettings().homeserver,
      oidcClientSettings: { issuer: METADATA.issuer, clientId: "client-123" },
      tokenResponse: {
        access_token: "new-access",
        refresh_token: "new-refresh",
        scope: "urn:matrix:client:device:DEVICE1234",
      },
    } as never);
    vi.mocked(core.whoAmI).mockResolvedValue({ userId: "@alice:other.example", deviceId: "DEVICE1234" });

    await expect(completeOidcLoginFromCallback()).rejects.toThrow(
      "OIDC Matrix identity could not be verified",
    );
    expect(revocation.revokeMatrixSession).toHaveBeenCalledWith({
      homeserver: getRuntimeSettings().homeserver,
      accessToken: "new-access",
    }, undefined, undefined);
  });

  it("retains a tab-scoped revocation retry when callback cleanup is uncertain", async () => {
    callback("?code=one&state=two");
    vi.mocked(core.completeAuthorizationCodeFlow).mockResolvedValue({
      homeserverUrl: getRuntimeSettings().homeserver,
      oidcClientSettings: { issuer: METADATA.issuer, clientId: "client-123" },
      tokenResponse: {
        access_token: "new-access",
        refresh_token: "new-refresh",
        scope: "urn:matrix:client:device:DEVICE1234",
      },
    } as never);
    vi.mocked(core.whoAmI).mockRejectedValue(new Error("whoami failed"));
    vi.mocked(revocation.revokeMatrixSession).mockRejectedValueOnce(new Error("network secret"));

    await expect(completeOidcLoginFromCallback()).rejects.toThrow("whoami failed");
    expect(sessionStorage.getItem("telecrypt-io-ui:pending-revocation")).toContain("new-access");
  });

  it("scrubs the callback before a failed code exchange", async () => {
    callback("?code=one&state=two");
    vi.mocked(core.completeAuthorizationCodeFlow).mockRejectedValue(new Error("provider secret"));

    await expect(completeOidcLoginFromCallback()).rejects.toThrow("provider secret");
    expect(window.history.replaceState).toHaveBeenCalledWith({}, "", "/");
  });

  it("scrubs a spurious OIDC-looking URL without clearing a live session", async () => {
    sessionStorage.setItem(
      "telecrypt-io-ui:session",
      JSON.stringify({
        homeserver: getRuntimeSettings().homeserver,
        userId: "@alice:localhost",
        deviceId: "DEVICE1",
        accessToken: "live-access",
        refreshToken: "live-refresh",
        oidcClientId: "client-123",
      }),
    );
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { origin: "http://localhost:5173", search: "?iss=https%3A%2F%2Fissuer", hash: "", pathname: "/" },
    });

    await expect(completeOidcLoginFromCallback()).rejects.toThrow("Sign-in callback was malformed");
    expect(sessionStorage.getItem("telecrypt-io-ui:session")).toContain("live-access");
    expect(revocation.revokeMatrixSession).not.toHaveBeenCalled();
    expect(window.history.replaceState).toHaveBeenCalledWith({}, "", "/");
  });

  it("revokes a session rotated during replacement login before redirecting", async () => {
    sessionStorage.setItem(
      "telecrypt-io-ui:session",
      JSON.stringify({
        homeserver: getRuntimeSettings().homeserver,
        userId: "@alice:localhost",
        deviceId: "DEVICE1",
        accessToken: "old-access",
        refreshToken: "old-refresh",
        oidcClientId: "client-123",
      }),
    );
    vi.mocked(revocation.revokeMatrixSession).mockImplementationOnce(async () => {
      sessionStorage.setItem(
        "telecrypt-io-ui:session",
        JSON.stringify({
          homeserver: getRuntimeSettings().homeserver,
          userId: "@alice:localhost",
          deviceId: "DEVICE1",
          accessToken: "rotated-access",
          refreshToken: "rotated-refresh",
          oidcClientId: "client-123",
        }),
      );
    });

    await beginOidcLogin();
    expect(revocation.revokeMatrixSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ accessToken: "old-access" }),
      undefined,
      undefined,
    );
    expect(revocation.revokeMatrixSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ accessToken: "rotated-access" }),
      undefined,
      undefined,
    );
  });
});
