import { describe, expect, it } from "vitest";
import {
  fetchRuntimeSettings,
  getRuntimeSettings,
  runtimeOidcIssuer,
  validateRuntimeSettings,
} from "./buildConfig";

describe("validateRuntimeSettings", () => {
  it("accepts one canonical backend origin and derives its MAS issuer", () => {
    expect(
      validateRuntimeSettings({
        homeserver: "https://backend.telecrypt.io",
      }),
    ).toEqual({
      homeserver: "https://backend.telecrypt.io",
    });
  });

  it.each([
    [
      "a noncanonical homeserver trailing slash",
      { homeserver: "https://backend.telecrypt.io/" },
    ],
    [
      "an HTTP homeserver",
      { homeserver: "http://backend.telecrypt.io" },
    ],
    [
      "a homeserver path",
      { homeserver: "https://backend.telecrypt.io/matrix" },
    ],
    [
      "a non-TeleCrypt host",
      { homeserver: "https://backend.example.test" },
    ],
    [
      "a URL with a query",
      { homeserver: "https://backend.telecrypt.io?x=1" },
    ],
  ])("rejects %s", (_description, value) => {
    expect(() => validateRuntimeSettings(value)).toThrow();
  });
});

describe("fetchRuntimeSettings", () => {
  it("loads valid settings without cache or cross-origin credentials", async () => {
    const fetchSettings = async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe("https://storage-preproduction.telecrypt.io/runtime-settings.json");
      expect(init).toEqual({ cache: "no-store", credentials: "same-origin" });
      return new Response(JSON.stringify({
        homeserver: "https://backend-preproduction.telecrypt.io",
      }), { status: 200 });
    };
    await expect(fetchRuntimeSettings(fetchSettings, "https://storage-preproduction.telecrypt.io"))
      .resolves.toEqual({
        homeserver: "https://backend-preproduction.telecrypt.io",
      });
  });

  it("fails closed for an unavailable or invalid settings response", async () => {
    const unavailable = async () => new Response("missing", { status: 404 });
    await expect(fetchRuntimeSettings(unavailable, "https://storage.telecrypt.io"))
      .rejects.toThrow("HTTP 404");

    const invalid = async () => new Response(JSON.stringify({
      homeserver: "https://backend.example.test",
    }), { status: 200 });
    await expect(fetchRuntimeSettings(invalid, "https://storage.telecrypt.io"))
      .rejects.toThrow("TeleCrypt");
  });
});

describe("runtimeOidcIssuer", () => {
  it("derives the canonical MAS path from runtime settings", () => {
    expect(runtimeOidcIssuer()).toBe(`${getRuntimeSettings().homeserver}/auth/`);
  });
});
