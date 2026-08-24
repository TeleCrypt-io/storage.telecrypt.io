import { beforeEach, describe, expect, it } from "vitest";
import {
  PENDING_REVOCATION_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  clearPendingRevocation,
  clearSession,
  clearOidcTransientState,
  loadOidcLoginIntent,
  loadPendingRevocation,
  loadSession,
  savePendingRevocation,
  saveSessionIfCurrent,
  isRuntimeMatrixDeviceId,
  isRuntimeMatrixUserId,
  MAX_OIDC_LOGIN_INTENT_AGE_MS,
  type Session,
} from "./session";

const SESSION: Session = {
  homeserver: "http://localhost:8008",
  userId: "@alice:localhost",
  deviceId: "DEVICE1",
  accessToken: "access-a",
  refreshToken: "refresh-a",
  oidcClientId: "client-a",
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearPendingRevocation();
});

describe("tab-scoped session persistence", () => {
  it("stores and reloads the session from sessionStorage only", () => {
    expect(saveSessionIfCurrent(SESSION, null)).toBe(true);
    expect(JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY)!)).toEqual(SESSION);
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(loadSession()).toEqual(SESSION);
  });

  it("rejects a saved session without a device identity before connecting", () => {
    const incomplete = { ...SESSION } as Record<string, unknown>;
    delete incomplete.deviceId;
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(incomplete));

    expect(loadSession()).toBeNull();
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it("fails closed when sessionStorage cannot be written", () => {
    const original = window.sessionStorage;
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get: () => {
        throw new Error("blocked");
      },
    });
    try {
      expect(saveSessionIfCurrent(SESSION, null)).toBe(false);
      expect(loadSession()).toBeNull();
    } finally {
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        value: original,
      });
    }
  });

  it("reports an unwriteable pending-revocation record without exposing or throwing its token", () => {
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
        throw new Error("provider token should not escape");
      },
    } as unknown as Storage;
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: blocked,
    });
    try {
      expect(
        savePendingRevocation({
          homeserver: SESSION.homeserver,
          accessToken: "secret-token",
        }),
      ).toBe(false);
    } finally {
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        value: original,
      });
    }
  });

  it("retains a volatile same-tab cleanup retry when storage becomes unavailable", () => {
    const original = window.sessionStorage;
    const blocked = {
      get length() {
        return 0;
      },
      getItem: () => null,
      key: () => null,
      removeItem: () => undefined,
      setItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: blocked });
    expect(savePendingRevocation({ homeserver: SESSION.homeserver, accessToken: "volatile-token" })).toBe(false);
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: original });
    expect(loadPendingRevocation()).toEqual({
      homeserver: SESSION.homeserver,
      accessToken: "volatile-token",
    });
    expect(clearPendingRevocation()).toBe(true);
  });

  it("retains the volatile cleanup token when persistent removal is denied", () => {
    const pending = { homeserver: SESSION.homeserver, accessToken: "volatile-retry" };
    expect(savePendingRevocation(pending)).toBe(true);
    const original = window.sessionStorage;
    const blocked = {
      get length() {
        return 0;
      },
      getItem: () => pending.accessToken,
      key: () => null,
      removeItem: () => {
        throw new Error("blocked");
      },
      setItem: () => undefined,
    } as unknown as Storage;
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: blocked });
    try {
      expect(clearPendingRevocation()).toBe(false);
    } finally {
      Object.defineProperty(window, "sessionStorage", { configurable: true, value: original });
    }
    expect(loadPendingRevocation()).toEqual(pending);
  });

  it("rejects whitespace and non-canonical Matrix identities", () => {
    for (const invalid of [
      { ...SESSION, userId: "@alice smith:localhost" },
      { ...SESSION, userId: "alice:localhost" },
      { ...SESSION, userId: "@alice:other.example" },
      { ...SESSION, deviceId: "DEVICE 1" },
      { ...SESSION, accessToken: "token\nwith-control" },
    ]) {
      expect(saveSessionIfCurrent(invalid, null)).toBe(false);
      expect(loadSession()).toBeNull();
    }
  });

  it("accepts canonical Matrix plus localparts while binding the server", () => {
    const withPlus = { ...SESSION, userId: "@alice+device:localhost" };
    expect(saveSessionIfCurrent(withPlus, null)).toBe(true);
    expect(loadSession()?.userId).toBe("@alice+device:localhost");
  });

  it("matches the SDK Matrix identifier grammar", () => {
    expect(isRuntimeMatrixUserId("@Alice+device/1:LOCALHOST")).toBe(true);
    expect(isRuntimeMatrixDeviceId("DEVICE~1")).toBe(true);
    expect(isRuntimeMatrixDeviceId("DEVICE=1")).toBe(false);
    expect(isRuntimeMatrixDeviceId("D".repeat(129))).toBe(false);
  });

  it("clears only this tab's session", () => {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(SESSION));
    sessionStorage.setItem("mx_oidc_state", "transient-state");
    sessionStorage.setItem("telecrypt:oauth2:pkce:v1:state", "transient-state");
    sessionStorage.setItem("telecrypt-io-ui:device:https://backend.telecrypt.io/auth/", "DEVICE1");
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(SESSION));
    localStorage.setItem(
      "telecrypt-io-ui:oidc-client:https://backend.telecrypt.io/auth/",
      "client-a",
    );
    clearSession();
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem("mx_oidc_state")).toBeNull();
    expect(sessionStorage.getItem("telecrypt:oauth2:pkce:v1:state")).toBeNull();
    expect(sessionStorage.getItem("telecrypt-io-ui:device:https://backend.telecrypt.io/auth/")).toBe(
      "DEVICE1",
    );
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toEqual(JSON.stringify(SESSION));
    expect(
      localStorage.getItem("telecrypt-io-ui:oidc-client:https://backend.telecrypt.io/auth/"),
    ).toBe("client-a");
  });

  it("expires login intent and clears one-time state without clearing a live session", () => {
    sessionStorage.setItem(
      "telecrypt-io-ui:oidc-login-intent",
      JSON.stringify({ state: "state", createdAt: Date.now() - MAX_OIDC_LOGIN_INTENT_AGE_MS - 1 }),
    );
    sessionStorage.setItem("mx_oidc_state", "transient-state");
    sessionStorage.setItem("telecrypt:oauth2:pkce:v1:state", "transient-state");
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(SESSION));

    expect(loadOidcLoginIntent()).toBeNull();
    expect(clearOidcTransientState()).toBe(true);
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toEqual(JSON.stringify(SESSION));
    expect(sessionStorage.getItem("mx_oidc_state")).toBeNull();
    expect(sessionStorage.getItem("telecrypt:oauth2:pkce:v1:state")).toBeNull();
  });

  it("stores a pending token revocation only in this tab", () => {
    const pending = { homeserver: SESSION.homeserver, accessToken: SESSION.accessToken };

    expect(savePendingRevocation(pending)).toBe(true);
    expect(loadPendingRevocation()).toEqual(pending);
    expect(sessionStorage.getItem(PENDING_REVOCATION_STORAGE_KEY)).toContain(SESSION.accessToken);
    expect(localStorage.getItem(PENDING_REVOCATION_STORAGE_KEY)).toBeNull();
  });
});
