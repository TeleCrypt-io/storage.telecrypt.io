/**
 * Browser-facing SDK boundary.
 *
 * The repository is intentionally pinned to storage SDK 0.5.0. The locally
 * installed dependency may remain 0.4.0 until that exact release is published,
 * so these small adapters describe the 0.5 cancellation surface without
 * inventing package-lock integrity or copying SDK implementation into the UI.
 */
import * as sdkCore from "@telecrypt-io/storage/core";
import type { TeleCryptIOStorage as Storage } from "@telecrypt-io/storage";

export * from "@telecrypt-io/storage/core";
export { TeleCryptIOStorage } from "@telecrypt-io/storage";

export interface OperationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

type AdaptedOperation<Args extends unknown[], Result> = (
  storage: Storage,
  ...args: [...Args, options?: OperationOptions]
) => Promise<Result>;

function adaptOperation<Args extends unknown[], Result>(fn: unknown): AdaptedOperation<Args, Result> {
  return fn as AdaptedOperation<Args, Result>;
}

export const createVault = adaptOperation<[string], Awaited<ReturnType<typeof sdkCore.createVault>>>(sdkCore.createVault);
export const joinVault = adaptOperation<[string], Awaited<ReturnType<typeof sdkCore.joinVault>>>(sdkCore.joinVault);
export const declineInvite = adaptOperation<[string], Awaited<ReturnType<typeof sdkCore.declineInvite>>>(sdkCore.declineInvite);
export const shareVault = adaptOperation<[string, string, string], Awaited<ReturnType<typeof sdkCore.shareVault>>>(sdkCore.shareVault);
export const unshareVault = adaptOperation<[string, string], Awaited<ReturnType<typeof sdkCore.unshareVault>>>(sdkCore.unshareVault);
export const createSubfolder = adaptOperation<[string, string], Awaited<ReturnType<typeof sdkCore.createSubfolder>>>(sdkCore.createSubfolder);
export const renameVault = adaptOperation<[string, string], Awaited<ReturnType<typeof sdkCore.renameVault>>>(sdkCore.renameVault);
export const renameFolder = adaptOperation<[string, string], Awaited<ReturnType<typeof sdkCore.renameFolder>>>(sdkCore.renameFolder);
export const deleteVault = adaptOperation<[string], Awaited<ReturnType<typeof sdkCore.deleteVault>>>(sdkCore.deleteVault);
export const deleteFolder = adaptOperation<[string], Awaited<ReturnType<typeof sdkCore.deleteFolder>>>(sdkCore.deleteFolder);
export const renameFile = adaptOperation<[string, string, string], Awaited<ReturnType<typeof sdkCore.renameFile>>>(sdkCore.renameFile);
export const deleteFile = adaptOperation<[string, string], Awaited<ReturnType<typeof sdkCore.deleteFile>>>(sdkCore.deleteFile);
export const uploadFile = adaptOperation<[string, string, Uint8Array, string], Awaited<ReturnType<typeof sdkCore.uploadFile>>>(sdkCore.uploadFile);
export const setupRecovery = adaptOperation<[], Awaited<ReturnType<typeof sdkCore.setupRecovery>>>(sdkCore.setupRecovery);
export const restoreRecovery = adaptOperation<[string], Awaited<ReturnType<typeof sdkCore.restoreRecovery>>>(sdkCore.restoreRecovery);
export const listVaults = adaptOperation<[], Awaited<ReturnType<typeof sdkCore.listVaults>>>(sdkCore.listVaults);
export const listPendingInvites = adaptOperation<[], Awaited<ReturnType<typeof sdkCore.listPendingInvites>>>(sdkCore.listPendingInvites);
export const listMembers = adaptOperation<[string], Awaited<ReturnType<typeof sdkCore.listMembers>>>(sdkCore.listMembers);
export const listFiles = adaptOperation<[string], Awaited<ReturnType<typeof sdkCore.listFiles>>>(sdkCore.listFiles);
export const listSubfolders = adaptOperation<[string], Awaited<ReturnType<typeof sdkCore.listSubfolders>>>(sdkCore.listSubfolders);
export const getFileDetails = adaptOperation<[string, string], Awaited<ReturnType<typeof sdkCore.getFileDetails>>>(sdkCore.getFileDetails);
export const getVaultDetails = adaptOperation<[string], Awaited<ReturnType<typeof sdkCore.getVaultDetails>>>(sdkCore.getVaultDetails);
export const getFolderDetails = adaptOperation<[string], Awaited<ReturnType<typeof sdkCore.getFolderDetails>>>(sdkCore.getFolderDetails);
export const downloadFile = adaptOperation<[string, string], Awaited<ReturnType<typeof sdkCore.downloadFile>>>(sdkCore.downloadFile);

export function isVaultOwner(storage: Storage | null, vaultId: string): boolean {
  try {
    return Boolean(storage && sdkCore.getMyVaultRole(storage, vaultId) === "owner");
  } catch {
    return false;
  }
}

export function isRecoverySetup(storage: Storage, signal?: AbortSignal): Promise<boolean> {
  const check = storage.keys.isRecoverySetup as unknown as (
    signal?: AbortSignal,
  ) => Promise<boolean>;
  return check.call(storage.keys, signal);
}

export const discoverOidcIssuer = sdkCore.discoverOidcIssuer as unknown as (
  homeserver: string,
  signal?: AbortSignal,
) => Promise<Awaited<ReturnType<typeof sdkCore.discoverOidcIssuer>>>;
export const registerClient = sdkCore.registerClient as unknown as (
  metadata: Parameters<typeof sdkCore.registerClient>[0],
  registration: Parameters<typeof sdkCore.registerClient>[1],
  signal?: AbortSignal,
) => Promise<Awaited<ReturnType<typeof sdkCore.registerClient>>>;
export const beginAuthorizationCodeFlow = sdkCore.beginAuthorizationCodeFlow as unknown as (
  options: Parameters<typeof sdkCore.beginAuthorizationCodeFlow>[0] & {
    signal?: AbortSignal;
  },
) => Promise<Awaited<ReturnType<typeof sdkCore.beginAuthorizationCodeFlow>>>;
export const completeAuthorizationCodeFlow = sdkCore.completeAuthorizationCodeFlow as unknown as (
  code: string,
  state: string,
  signal?: AbortSignal,
) => Promise<Awaited<ReturnType<typeof sdkCore.completeAuthorizationCodeFlow>>>;
export const whoAmI = sdkCore.whoAmI as unknown as (
  homeserver: string,
  accessToken: string,
  signal?: AbortSignal,
) => Promise<Awaited<ReturnType<typeof sdkCore.whoAmI>>>;

// Keep the browser boundary typed against the issuer- and device-bound refresh
// contract while the checked-in node_modules may still expose the older SDK
// signature. This adapter is temporary until the exact declared SDK release is
// present; it does not duplicate the implementation.
export const buildTokenRefreshFunction = sdkCore.buildTokenRefreshFunction as unknown as (
  metadata: {
    issuer: string;
    token_endpoint: string;
    revocation_endpoint?: string;
  },
  clientId: string,
  onPersist: (
    tokens: { accessToken: string; refreshToken?: string },
    signal?: AbortSignal,
  ) => Promise<void>,
  expectedDeviceId: string,
) => (refreshToken: string, signal?: AbortSignal) => Promise<{
  accessToken: string;
  refreshToken?: string;
  expiry?: Date;
}>;

// Reflective lookup keeps the browser bundle from treating the export as a
// statically missing symbol while the local checkout is waiting for SDK 0.5.0.
const sdkFileLimit = Reflect.get(sdkCore, "MAX_MEDIA_FILE_BYTES");
if (typeof sdkFileLimit !== "number" || !Number.isSafeInteger(sdkFileLimit) || sdkFileLimit <= 0) {
  throw new Error("The installed storage SDK does not export its authoritative file limit");
}
export const MAX_MEDIA_FILE_BYTES = sdkFileLimit;
