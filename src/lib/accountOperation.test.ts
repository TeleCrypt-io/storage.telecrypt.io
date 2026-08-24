import { describe, expect, it, vi } from "vitest";
import { isAbortError, withAccountSignal } from "./accountOperation";

describe("account operation cancellation", () => {
  it("rejects a pending UI operation when the account scope is aborted", async () => {
    const controller = new AbortController();
    const pending = new Promise<string>(() => undefined);
    const result = withAccountSignal(controller.signal, () => pending);
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(isAbortError(new DOMException("cancelled", "AbortError"))).toBe(true);
  });

  it("does not start an operation when the account is already inactive", async () => {
    const controller = new AbortController();
    const operation = vi.fn(() => Promise.resolve("never"));
    controller.abort();

    await expect(withAccountSignal(controller.signal, operation)).rejects.toMatchObject({ name: "AbortError" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("runs an operation when no account signal is supplied", async () => {
    await expect(withAccountSignal(null, () => Promise.resolve("ok"))).resolves.toBe("ok");
  });
});
