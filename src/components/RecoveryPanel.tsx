import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useStorage } from "../context/StorageContext";
import { formatOperationError } from "../lib/formatOperationError";
import { withAccountSignal } from "../lib/accountOperation";
import * as core from "../lib/core";

type AccountRecoveryStatus = "configured" | "not-configured" | "unknown";

const MAX_RECOVERY_KEY_BYTES = 256;
const RECOVERY_OPERATION_TIMEOUT_MS = 30_000;
const MAX_RECOVERY_RESULT_KEYS = 1_000_000;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function withRecoveryDeadline<T>(
  accountSignal: AbortSignal | null,
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(accountSignal?.reason);
  if (accountSignal?.aborted) abort();
  else accountSignal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException(`${label} timed out`, "TimeoutError"));
      reject(new Error(`${label} timed out`));
    }, RECOVERY_OPERATION_TIMEOUT_MS);
  });
  return Promise.race([
    withAccountSignal(controller.signal, () => operation(controller.signal)),
    timeout,
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    accountSignal?.removeEventListener("abort", abort);
  });
}

function isRecoverySetupResult(value: unknown): value is { recoveryKey: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "recoveryKey" in value &&
    typeof value.recoveryKey === "string" &&
    value.recoveryKey.trim() !== "" &&
    utf8ByteLength(value.recoveryKey) <= MAX_RECOVERY_KEY_BYTES &&
    ![...value.recoveryKey].some(
      (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
    )
  );
}

function isRecoveryRestoreResult(value: unknown): value is { imported: number; total: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "imported" in value &&
    "total" in value &&
    typeof value.imported === "number" &&
    Number.isSafeInteger(value.imported) &&
    typeof value.total === "number" &&
    Number.isSafeInteger(value.total) &&
    value.imported >= 0 &&
    value.total >= value.imported &&
    value.total <= MAX_RECOVERY_RESULT_KEYS
  );
}

export function RecoveryPanel() {
  const { storage, accountSignal } = useStorage();
  const [recoveryStatus, setRecoveryStatus] = useState<AccountRecoveryStatus | null>(null);
  const [setupIndeterminate, setSetupIndeterminate] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoreKeyInput, setRestoreKeyInput] = useState("");
  const [restoreResult, setRestoreResult] = useState<{ imported: number; total: number } | null>(
    null,
  );
  const [confirmedSaved, setConfirmedSaved] = useState(false);
  const [restoreExpanded, setRestoreExpanded] = useState(false);
  const identityRef = useRef<typeof storage>(null);
  const identityGenerationRef = useRef(0);
  const mutationInFlightRef = useRef(false);
  // Keep identity current during render so callbacks cannot observe a prior identity between
  // render and effect cleanup.
  // oxlint-disable-next-line react/refs
  identityRef.current = storage;

  function clearDisplayedRecoveryKey(): void {
    setRecoveryKey(null);
    setConfirmedSaved(false);
  }

  // Clear all account-specific recovery state before the next identity's asynchronous status
  // request can complete.
  // oxlint-disable react/set-state-in-effect
  useEffect(() => {
    identityRef.current = storage;
    identityGenerationRef.current += 1;
    mutationInFlightRef.current = false;
    setRecoveryStatus(null);
    setSetupIndeterminate(false);
    setRecoveryKey(null);
    setError(null);
    setBusy(false);
    setRestoreKeyInput("");
    setRestoreResult(null);
    setConfirmedSaved(false);
    setRestoreExpanded(false);
    return () => {
      identityGenerationRef.current += 1;
    };
  }, [storage]);
  // oxlint-enable react/set-state-in-effect

  function isCurrent(expectedStorage: typeof storage, generation: number): boolean {
    return (
      !(accountSignal?.aborted ?? false) &&
      identityGenerationRef.current === generation &&
      identityRef.current === expectedStorage
    );
  }

  const refreshStatus = useCallback(async (reconcile = false) => {
    const expectedStorage = storage;
    if (!expectedStorage) return;
    const generation = identityGenerationRef.current;
    try {
      const configured = await withRecoveryDeadline(
        accountSignal,
        "Recovery status check",
        (signal) => core.isRecoverySetup(expectedStorage, signal),
      );
      if (typeof configured !== "boolean") throw new Error("invalid recovery status");
      const nextStatus = configured ? "configured" : "not-configured";
      if (!isCurrent(expectedStorage, generation)) return;
      setRecoveryStatus(nextStatus);
      if (reconcile) {
        setSetupIndeterminate(false);
        setError(null);
      }
    } catch {
      if (isCurrent(expectedStorage, generation)) {
        setRecoveryStatus("unknown");
        setError("Account recovery status is unavailable.");
      }
    }
  // isCurrent is intentionally a render-local identity guard.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [accountSignal, storage]);

  useEffect(() => {
    // The status callback is guarded before updating state.
    // oxlint-disable-next-line react/set-state-in-effect
    void refreshStatus();
  }, [refreshStatus]);

  async function handleSetup() {
    const expectedStorage = storage;
    const generation = identityGenerationRef.current;
    if (
      !expectedStorage ||
      !isCurrent(expectedStorage, generation) ||
      mutationInFlightRef.current
    ) return;
    mutationInFlightRef.current = true;
    setBusy(true);
    setError(null);
    setConfirmedSaved(false);
    try {
      const result = await withRecoveryDeadline(
        accountSignal,
        "Recovery setup",
        (signal) => core.setupRecovery(expectedStorage, { signal, timeoutMs: RECOVERY_OPERATION_TIMEOUT_MS }),
      );
      if (!isCurrent(expectedStorage, generation)) return;
      if (!isRecoverySetupResult(result)) throw new Error("Recovery setup returned an invalid key");
      setRecoveryKey(result.recoveryKey);
      setRecoveryStatus("configured");
    } catch {
      if (isCurrent(expectedStorage, generation)) {
        setSetupIndeterminate(true);
        setRecoveryStatus("unknown");
        setError("Recovery setup could not be confirmed. Reconcile recovery status before retrying.");
      }
    } finally {
      if (identityGenerationRef.current === generation) mutationInFlightRef.current = false;
      if (isCurrent(expectedStorage, generation)) {
        setBusy(false);
      }
    }
  }

  async function handleReconcile() {
    const expectedStorage = storage;
    const generation = identityGenerationRef.current;
    if (
      !expectedStorage ||
      !isCurrent(expectedStorage, generation) ||
      mutationInFlightRef.current
    ) return;
    mutationInFlightRef.current = true;
    setBusy(true);
    try {
      await refreshStatus(true);
    } finally {
      if (identityGenerationRef.current === generation) mutationInFlightRef.current = false;
      if (isCurrent(expectedStorage, generation)) setBusy(false);
    }
  }

  async function handleRestore(e: FormEvent) {
    e.preventDefault();
    const expectedStorage = storage;
    const generation = identityGenerationRef.current;
    if (
      !expectedStorage ||
      !isCurrent(expectedStorage, generation) ||
      mutationInFlightRef.current
    ) return;
    mutationInFlightRef.current = true;
    setBusy(true);
    setError(null);
    setRestoreResult(null);
    const recoveryKey = restoreKeyInput.trim();
    if (utf8ByteLength(recoveryKey) > MAX_RECOVERY_KEY_BYTES) {
      setError("The Recovery Key is too large.");
      setBusy(false);
      if (identityGenerationRef.current === generation) mutationInFlightRef.current = false;
      return;
    }
    try {
      const result = await withRecoveryDeadline(
        accountSignal,
        "Recovery restore",
        (signal) => core.restoreRecovery(expectedStorage, recoveryKey, {
          signal,
          timeoutMs: RECOVERY_OPERATION_TIMEOUT_MS,
        }),
      );
      if (!isCurrent(expectedStorage, generation)) return;
      if (!isRecoveryRestoreResult(result)) throw new Error("Recovery restore returned an invalid result");
      setRestoreResult(result);
      setRestoreKeyInput("");
    } catch (err) {
      if (isCurrent(expectedStorage, generation)) setError(formatOperationError(err));
    } finally {
      if (identityGenerationRef.current === generation) mutationInFlightRef.current = false;
      if (isCurrent(expectedStorage, generation)) {
        setRestoreKeyInput("");
        setBusy(false);
      }
    }
  }

  const showRestoreSection = !recoveryKey && recoveryStatus !== null && recoveryStatus !== "unknown";

  async function finishRecoverySetup() {
    const expectedStorage = storage;
    const generation = identityGenerationRef.current;
    if (!isCurrent(expectedStorage, generation)) return;
    clearDisplayedRecoveryKey();
  }

  return (
    <div className="panel">
      <h2>Recovery</h2>

      {recoveryStatus === null && !recoveryKey && (
        <p className="muted" data-testid="recovery-loading">
          Checking account recovery status…
        </p>
      )}

      {recoveryStatus === "unknown" && !recoveryKey && (
        <div data-testid="recovery-status-unknown">
          <p className="error">
            {setupIndeterminate
              ? "Recovery setup could not be confirmed. Do not retry until the account status is reconciled."
              : "Account recovery status is unavailable."}
          </p>
          {setupIndeterminate && (
            <button type="button" onClick={() => void handleReconcile()} disabled={busy} data-testid="reconcile-recovery">
              {busy ? "Checking recovery status…" : "Reconcile recovery status"}
            </button>
          )}
        </div>
      )}

      {recoveryStatus === "not-configured" && !recoveryKey && !setupIndeterminate && (
        <div data-testid="recovery-not-setup">
          <p>Recovery is not configured on this account. Restore with an existing Recovery Key on a new device.</p>
          <p className="muted">Only set up recovery here when this is the first trusted device for the account.</p>
          <button onClick={handleSetup} disabled={busy} data-testid="setup-recovery">
            {busy ? "Setting up recovery…" : "Set up recovery on this device"}
          </button>
        </div>
      )}

      {recoveryKey && (
        <div className="warning" data-testid="recovery-key-display">
          <p>
            <strong>Save this Recovery Key now.</strong> It is the only way to recover your files
            on a new device — it will not be shown again.
          </p>
          <code data-testid="recovery-key-value">{recoveryKey}</code>
          <p className="muted">Select and save this key using your password manager or another trusted method.</p>
          <label className="recovery-confirm-label">
            <input
              type="checkbox"
              checked={confirmedSaved}
              onChange={(e) => setConfirmedSaved(e.target.checked)}
              data-testid="confirm-saved-recovery-key"
            />
            I've saved my recovery key
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!confirmedSaved}
            onClick={() => void finishRecoverySetup()}
            data-testid="recovery-setup-done"
          >
            Done
          </button>
        </div>
      )}

      {showRestoreSection && (
        <section className="restore-section">
          {recoveryStatus === "configured" && (
            <p data-testid="recovery-active">Recovery is configured for this account.</p>
          )}

          <button
            type="button"
            className="link restore-toggle"
            onClick={() => setRestoreExpanded((v) => !v)}
            aria-expanded={restoreExpanded}
            data-testid="restore-expand"
          >
            {restoreExpanded ? "Hide restore" : "Restore with Recovery Key"}
          </button>

          {restoreExpanded && (
            <form onSubmit={handleRestore} className="restore-form">
              <label htmlFor="restore-key-textarea">Recovery Key</label>
              <textarea
                id="restore-key-textarea"
                rows={4}
                value={restoreKeyInput}
                onChange={(e) => setRestoreKeyInput(e.target.value)}
                maxLength={MAX_RECOVERY_KEY_BYTES}
                data-testid="restore-key-input"
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || !restoreKeyInput.trim()}
                data-testid="restore-submit"
              >
                {busy ? "Restoring…" : "Restore"}
              </button>
            </form>
          )}

          {restoreResult && (
            <p data-testid="restore-result">
              Imported {restoreResult.imported} of {restoreResult.total} keys.
            </p>
          )}
        </section>
      )}

      {error && (
        <p className="error" data-testid="recovery-error">
          {error}
        </p>
      )}
    </div>
  );
}
