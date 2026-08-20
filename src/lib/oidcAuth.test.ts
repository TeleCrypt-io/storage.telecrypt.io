// Unit tests for the stable device-id persistence in the OIDC login flow.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { beginOidcLogin, completeOidcLoginFromCallback } from "./oidcAuth";
import { BUILD_HOMESERVER } from "./buildConfig";
import * as core from "./core";

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

const METADATA = { issuer: "https://auth.example.test/" };

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
  vi.mocked(core.beginAuthorizationCodeFlow).mockResolvedValue("https://auth.example.test/authorize?x=1");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: { origin: "https://storage.test", href: "https://storage.test/", search: "" },
      history: { replaceState: vi.fn() },
    },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: memoryStorage(),
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
});

let callCounter = 0;

afterEach(() => {
  vi.clearAllMocks();
});

describe("beginOidcLogin stable device id", () => {
  it("passes a persisted device id to beginAuthorizationCodeFlow", async () => {
    await beginOidcLogin();
    const opts = vi.mocked(core.beginAuthorizationCodeFlow).mock.calls[0][0];
    expect(opts.deviceId).toMatch(/^[0-9A-F]{10}$/);

    // Second login reuses the SAME device id (persisted in localStorage).
    await beginOidcLogin();
    const second = vi.mocked(core.beginAuthorizationCodeFlow).mock.calls[1][0];
    expect(second.deviceId).toBe(opts.deviceId);
  });

  it("rejects discovery from an issuer other than the build-configured issuer", async () => {
    vi.mocked(core.discoverOidcIssuer).mockResolvedValue({ issuer: "https://unexpected.example.test/" } as never);

    await expect(beginOidcLogin()).rejects.toThrow(
      "OIDC issuer does not match this build",
    );
    expect(core.registerClient).not.toHaveBeenCalled();
  });

  it("rejects a callback for a different homeserver", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { origin: "https://storage.test", search: "?code=one&state=two", pathname: "/" },
    });
    vi.mocked(core.completeAuthorizationCodeFlow).mockResolvedValue({
      homeserverUrl: "https://unexpected.example.test",
      oidcClientSettings: { issuer: METADATA.issuer, clientId: "client-123" },
      tokenResponse: { access_token: "access", refresh_token: "refresh", scope: "scope" },
    } as never);

    await expect(completeOidcLoginFromCallback()).rejects.toThrow(
      "OIDC callback homeserver does not match this build",
    );
    expect(core.whoAmI).not.toHaveBeenCalled();
  });

  it("rejects a callback for a different issuer", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { origin: "https://storage.test", search: "?code=one&state=two", pathname: "/" },
    });
    vi.mocked(core.completeAuthorizationCodeFlow).mockResolvedValue({
      homeserverUrl: BUILD_HOMESERVER,
      oidcClientSettings: { issuer: "https://unexpected.example.test/", clientId: "client-123" },
      tokenResponse: { access_token: "access", refresh_token: "refresh", scope: "scope" },
    } as never);

    await expect(completeOidcLoginFromCallback()).rejects.toThrow(
      "OIDC callback issuer does not match this build",
    );
    expect(core.whoAmI).not.toHaveBeenCalled();
  });
});
