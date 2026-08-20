import { describe, expect, it } from "vitest";
import { fetchRuntimeSettings, validateRuntimeSettings } from "./buildConfig";

describe("validateRuntimeSettings", () => {
  it("accepts a canonical same-origin homeserver and issuer", () => {
    expect(
      validateRuntimeSettings({
        homeserver: "https://backend.telecrypt.io",
        oidcIssuer: "https://backend.telecrypt.io/auth/",
      }),
    ).toEqual({
      homeserver: "https://backend.telecrypt.io",
      oidcIssuer: "https://backend.telecrypt.io/auth/",
    });
  });

  it.each([
    [
      "a noncanonical homeserver trailing slash",
      { homeserver: "https://backend.telecrypt.io/", oidcIssuer: "https://backend.telecrypt.io/auth/" },
    ],
    [
      "an HTTP homeserver",
      { homeserver: "http://backend.telecrypt.io", oidcIssuer: "https://backend.telecrypt.io/auth/" },
    ],
    [
      "a homeserver path",
      { homeserver: "https://backend.telecrypt.io/matrix", oidcIssuer: "https://backend.telecrypt.io/auth/" },
    ],
    [
      "a non-TeleCrypt host",
      { homeserver: "https://backend.example.test", oidcIssuer: "https://backend.example.test/auth/" },
    ],
    [
      "a different issuer origin",
      { homeserver: "https://backend.telecrypt.io", oidcIssuer: "https://auth.telecrypt.io/auth/" },
    ],
    [
      "an issuer without a trailing slash",
      { homeserver: "https://backend.telecrypt.io", oidcIssuer: "https://backend.telecrypt.io/auth" },
    ],
    [
      "an arbitrary issuer path",
      { homeserver: "https://backend.telecrypt.io", oidcIssuer: "https://backend.telecrypt.io/other/" },
    ],
    [
      "a URL with a query",
      { homeserver: "https://backend.telecrypt.io?x=1", oidcIssuer: "https://backend.telecrypt.io/auth/" },
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
        oidcIssuer: "https://backend-preproduction.telecrypt.io/auth/",
      }), { status: 200 });
    };
    await expect(fetchRuntimeSettings(fetchSettings, "https://storage-preproduction.telecrypt.io"))
      .resolves.toEqual({
        homeserver: "https://backend-preproduction.telecrypt.io",
        oidcIssuer: "https://backend-preproduction.telecrypt.io/auth/",
      });
  });

  it("fails closed for an unavailable or invalid settings response", async () => {
    const unavailable = async () => new Response("missing", { status: 404 });
    await expect(fetchRuntimeSettings(unavailable, "https://storage.telecrypt.io"))
      .rejects.toThrow("HTTP 404");

    const invalid = async () => new Response(JSON.stringify({
      homeserver: "https://backend.example.test",
      oidcIssuer: "https://backend.example.test/auth/",
    }), { status: 200 });
    await expect(fetchRuntimeSettings(invalid, "https://storage.telecrypt.io"))
      .rejects.toThrow("TeleCrypt");
  });
});
