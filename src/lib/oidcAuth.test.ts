// Unit tests for the stable device-id persistence in the OIDC login flow.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { beginOidcLogin } from "./oidcAuth";
import * as core from "./core";

vi.mock("./core", async () => {
  const actual = await vi.importActual<typeof import("./core")>("./core");
  return {
    ...actual,
    discoverOidcIssuer: vi.fn(),
    registerClient: vi.fn(),
    beginAuthorizationCodeFlow: vi.fn(),
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
    value: { location: { origin: "https://storage.test", href: "https://storage.test/" } },
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
    await beginOidcLogin("https://backend.test");
    const opts = vi.mocked(core.beginAuthorizationCodeFlow).mock.calls[0][0];
    expect(opts.deviceId).toMatch(/^[0-9A-F]{10}$/);

    // Second login reuses the SAME device id (persisted in localStorage).
    await beginOidcLogin("https://backend.test");
    const second = vi.mocked(core.beginAuthorizationCodeFlow).mock.calls[1][0];
    expect(second.deviceId).toBe(opts.deviceId);
  });

  it("uses a different device id per issuer", async () => {
    await beginOidcLogin("https://backend.test");
    vi.mocked(core.discoverOidcIssuer).mockResolvedValue({ issuer: "https://other.example.test/" } as never);
    await beginOidcLogin("https://other.test");
    const first = vi.mocked(core.beginAuthorizationCodeFlow).mock.calls[0][0];
    const second = vi.mocked(core.beginAuthorizationCodeFlow).mock.calls[1][0];
    expect(second.deviceId).not.toBe(first.deviceId);
  });
});
