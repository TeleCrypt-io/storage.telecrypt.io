/**
 * Browser-facing SDK boundary.
 *
 * The repository is intentionally pinned to the exact published storage SDK
 * 0.5.22. The SDK barrel is the sole operation/OIDC authority; this boundary
 * adds only the two UI-specific recovery/ownership helpers without copying
 * SDK implementation into the UI.
 */
import { getMyVaultRole, type TeleCryptIOStorage } from "@telecrypt-io/storage";

export * from "@telecrypt-io/storage";

export function isVaultOwner(storage: TeleCryptIOStorage | null, vaultId: string): boolean {
  try {
    return Boolean(storage && getMyVaultRole(storage, vaultId) === "owner");
  } catch {
    return false;
  }
}

export function isRecoverySetup(storage: TeleCryptIOStorage, signal?: AbortSignal): Promise<boolean> {
  return storage.keys.isRecoverySetup(signal);
}
