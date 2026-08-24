const GENERIC_OPERATION_ERROR = "The operation could not be completed. Please try again.";

/**
 * Convert untrusted Matrix/HTTP/library failures into a small, stable UI vocabulary.
 * Upstream error text can contain room IDs, user IDs, URLs, or server internals, so it must
 * never be rendered directly by an authenticated page.
 */
export function formatOperationError(err: unknown): string {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const code =
    typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
      ? err.code
      : "";
  if (
    /\b413\b/.test(msg) ||
    /M_TOO_LARGE/i.test(msg) ||
    /Upload request body is too large/i.test(msg)
  ) {
    return "Server refused to create file";
  }
  if (msg === "Session revocation timed out") {
    return "Sign-out could not be confirmed before the request timed out. Try again.";
  }
  if (msg === "Session revocation failed") {
    return "Sign-out could not be confirmed. Try again.";
  }
  if (msg === "Session persistence failed" || msg === "Browser persistent storage is unavailable") {
    return "Sign-in could not be completed securely. Try again.";
  }
  if (msg === "Session cleanup is pending") {
    return "Previous sign-in cleanup is pending. Try again.";
  }
  if (msg === "Session cleanup could not be persisted") {
    return "Sign-in cleanup could not be saved. Try again.";
  }
  if (code === "FILE_TOO_LARGE" || /file exceeds the 128 MiB limit/i.test(msg)) {
    return "File exceeds the 128 MiB limit.";
  }
  if (msg === "File size could not be verified.") return msg;
  if (/timed out/i.test(msg)) return "Connection timed out";
  if (/cancel(?:led|ed)/i.test(msg)) return "Operation cancelled";
  if (/\b(?:401|403)\b|forbidden|not allowed|permission denied|access denied/i.test(msg)) {
    return "You do not have permission to perform this operation.";
  }
  if (/\b404\b|not found|unknown (?:file|folder|vault|tree)/i.test(msg)) {
    return "The requested item is no longer available.";
  }
  if (
    code === "RECOVERY_RESTORE_FAILED" ||
    (/recovery (?:key|restore)|key backup/i.test(msg) && /invalid|reject|fail|missing|wrong/i.test(msg))
  ) {
    return "The recovery key was rejected.";
  }
  if (msg === "Authentication issuer changed; log in again") return msg;
  if (msg === "Sign-in was cancelled" || msg === "Sign-in failed") return msg;
  if (msg === "Session is no longer active") return msg;
  return GENERIC_OPERATION_ERROR;
}
