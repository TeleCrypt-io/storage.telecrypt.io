import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useStorage } from "../context/StorageContext";
import * as core from "../lib/core";
import type { Member } from "../lib/core";
import { formatOperationError } from "../lib/formatOperationError";
import { withAccountSignal } from "../lib/accountOperation";
import { isRuntimeMatrixUserId } from "../lib/session";

const POLL_MS = 4000;
const MAX_MEMBER_ID_BYTES = 255;
const MAX_MEMBER_COUNT = 1_000;
const MEMBER_ROLES = new Set(["owner", "editor", "viewer"]);
const MEMBER_MEMBERSHIPS = new Set(["join", "invite"]);

function displayName(userId: string): string {
  const local = userId.split(":")[0]?.replace(/^@/, "") ?? userId;
  return local;
}

function initials(userId: string): string {
  const name = displayName(userId);
  return name.slice(0, 2).toUpperCase();
}

function isCanonicalMemberId(value: unknown): value is string {
  return typeof value === "string" && new TextEncoder().encode(value).byteLength <= MAX_MEMBER_ID_BYTES && isRuntimeMatrixUserId(value);
}

function validateMembers(value: unknown): Member[] {
  if (!Array.isArray(value) || value.length > MAX_MEMBER_COUNT) {
    throw new Error("Member list is invalid");
  }
  if (
    value.some(
      (member) =>
        typeof member !== "object" ||
        member === null ||
        !isCanonicalMemberId((member as Partial<Member>).userId) ||
        !MEMBER_ROLES.has((member as Partial<Member>).role ?? "") ||
        !MEMBER_MEMBERSHIPS.has((member as Partial<Member>).membership ?? ""),
    )
  ) {
    throw new Error("Member list is invalid");
  }
  return value as Member[];
}

function isValidShareResult(
  value: unknown,
  vaultId: string,
  userId: string,
  role: string,
): boolean {
  if (typeof value !== "object" || value === null) return false;
  const result = value as { vaultId?: unknown; userId?: unknown; role?: unknown };
  return result.vaultId === vaultId && result.userId === userId && result.role === role;
}

function isValidUnshareResult(value: unknown, vaultId: string, userId: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const result = value as { vaultId?: unknown; userId?: unknown; removed?: unknown };
  return result.vaultId === vaultId && result.userId === userId && result.removed === true;
}

export function MembersPanel({ vaultId, embedded }: { vaultId: string; embedded?: boolean }) {
  const { storage, session, accountSignal } = useStorage();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shareUserId, setShareUserId] = useState("");
  const [shareRole, setShareRole] = useState<"viewer" | "editor">("editor");
  const [expanded, setExpanded] = useState(true);
  const identityRef = useRef<{ storage: typeof storage; vaultId: string }>({
    storage: null,
    vaultId: "",
  });
  const identityGenerationRef = useRef(0);
  const refreshRequestRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const mutationInFlightRef = useRef(false);
  // Keep identity current during render so callbacks cannot observe a prior identity between
  // render and effect cleanup.
  // oxlint-disable-next-line react/refs
  identityRef.current = { storage, vaultId };
  const canManage = core.isVaultOwner(storage, vaultId);

  // Clear account-specific member state before the next identity's asynchronous refresh completes.
  // oxlint-disable react/set-state-in-effect
  useEffect(() => {
    identityRef.current = { storage, vaultId };
    identityGenerationRef.current += 1;
    refreshRequestRef.current += 1;
    mutationGenerationRef.current += 1;
    mutationInFlightRef.current = false;
    setMembers(null);
    setError(null);
    setShareUserId("");
    setBusy(false);
    return () => {
      identityGenerationRef.current += 1;
      refreshRequestRef.current += 1;
    };
  }, [storage, vaultId]);
  // oxlint-enable react/set-state-in-effect

  const refresh = useCallback(async () => {
    if (!storage) return;
    const generation = identityGenerationRef.current;
    const request = ++refreshRequestRef.current;
    const isCurrent = () =>
      !(accountSignal?.aborted ?? false) &&
      generation === identityGenerationRef.current &&
      request === refreshRequestRef.current &&
      identityRef.current.storage === storage &&
      identityRef.current.vaultId === vaultId;
    try {
      const nextMembers = await withAccountSignal(accountSignal, () =>
        core.listMembers(storage, vaultId, { signal: accountSignal ?? undefined }),
      );
      if (isCurrent()) {
        setMembers(validateMembers(nextMembers));
        setError(null);
      }
    } catch (err) {
      if (isCurrent()) {
        setMembers(null);
        setError(formatOperationError(err));
      }
    }
  }, [accountSignal, storage, vaultId]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(() => void poll(), POLL_MS);
    };
    // The refresh callback is guarded before every state update.
    // oxlint-disable-next-line react/set-state-in-effect
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [refresh]);

  async function handleShare(e: FormEvent) {
    e.preventDefault();
    const expectedStorage = storage;
    const expectedVaultId = vaultId;
    const expectedGeneration = identityGenerationRef.current;
    if (!expectedStorage || !core.isVaultOwner(expectedStorage, expectedVaultId)) return;
    const targetUserId = shareUserId.trim();
    if (!isCanonicalMemberId(targetUserId)) {
      setError("Enter a valid Matrix user ID.");
      return;
    }
    if (mutationInFlightRef.current) return;
    const mutationGeneration = ++mutationGenerationRef.current;
    mutationInFlightRef.current = true;
    const isCurrent = () =>
      !(accountSignal?.aborted ?? false) &&
      identityGenerationRef.current === expectedGeneration &&
      mutationGenerationRef.current === mutationGeneration &&
      identityRef.current.storage === expectedStorage &&
      identityRef.current.vaultId === expectedVaultId;
    const isCurrentOwner = () => isCurrent() && core.isVaultOwner(expectedStorage, expectedVaultId);
    setBusy(true);
    setError(null);
    try {
      const result = await withAccountSignal(
        accountSignal,
        () => core.shareVault(expectedStorage, expectedVaultId, targetUserId, shareRole, {
          signal: accountSignal ?? undefined,
        }),
      );
      if (!isValidShareResult(result, expectedVaultId, targetUserId, shareRole)) {
        throw new Error("Share response is invalid");
      }
      if (isCurrentOwner()) {
        setShareUserId("");
        await refresh();
      }
    } catch (err) {
      if (isCurrentOwner()) setError(formatOperationError(err));
    } finally {
      if (mutationGenerationRef.current === mutationGeneration) {
        mutationInFlightRef.current = false;
        if (isCurrent()) setBusy(false);
      }
    }
  }

  async function handleUnshare(userId: string) {
    const expectedStorage = storage;
    const expectedVaultId = vaultId;
    const expectedGeneration = identityGenerationRef.current;
    if (!expectedStorage || !core.isVaultOwner(expectedStorage, expectedVaultId)) return;
    if (!isCanonicalMemberId(userId)) return;
    if (mutationInFlightRef.current) return;
    const mutationGeneration = ++mutationGenerationRef.current;
    mutationInFlightRef.current = true;
    const isCurrent = () =>
      !(accountSignal?.aborted ?? false) &&
      identityGenerationRef.current === expectedGeneration &&
      mutationGenerationRef.current === mutationGeneration &&
      identityRef.current.storage === expectedStorage &&
      identityRef.current.vaultId === expectedVaultId;
    const isCurrentOwner = () => isCurrent() && core.isVaultOwner(expectedStorage, expectedVaultId);
    setBusy(true);
    setError(null);
    try {
      const result = await withAccountSignal(
        accountSignal,
        () => core.unshareVault(expectedStorage, expectedVaultId, userId, {
          signal: accountSignal ?? undefined,
        }),
      );
      if (!isValidUnshareResult(result, expectedVaultId, userId)) {
        throw new Error("Unshare response is invalid");
      }
      if (isCurrentOwner()) await refresh();
    } catch (err) {
      if (isCurrentOwner()) setError(formatOperationError(err));
    } finally {
      if (mutationGenerationRef.current === mutationGeneration) {
        mutationInFlightRef.current = false;
        if (isCurrent()) setBusy(false);
      }
    }
  }

  return (
    <aside className={`members-panel${embedded ? " embedded" : ""}`} data-testid="members-panel">
      {embedded ? (
        <h3 className="panel-section-title">Access</h3>
      ) : (
        <button
          type="button"
          className="members-panel-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <span>Access</span>
          <span className="muted">{members?.length ?? "…"}</span>
        </button>
      )}

      {(embedded || expanded) && (
        <>
          {!embedded && (
            <p className="members-panel-hint muted">Everyone with access to this vault</p>
          )}

          {error && (
            <p className="error" data-testid="members-error">
              {error}
            </p>
          )}

          <ul className="member-list" data-testid="member-list">
            {members === null ? (
              <li className="muted">Loading…</li>
            ) : members.length === 0 ? (
              <li className="muted">No members</li>
            ) : (
              members.map((m) => (
                <li key={m.userId} className="member-item" data-testid="member-item" data-user-id={m.userId}>
                  <span className="member-avatar" aria-hidden="true">
                    {initials(m.userId)}
                  </span>
                  <span className="member-info">
                    <span className="member-name">{displayName(m.userId)}</span>
                    <span className={`role-pill ${m.role} ${m.membership === "invite" ? "invited" : ""}`}>
                      {m.membership === "invite" ? `${m.role} · invited` : m.role}
                    </span>
                  </span>
                  {canManage && m.role !== "owner" && m.userId !== session?.userId && (
                    <button
                      type="button"
                      className="icon-btn"
                      title="Remove"
                      aria-label={`Remove ${displayName(m.userId)}`}
                      onClick={() => handleUnshare(m.userId)}
                      disabled={busy}
                      data-testid="unshare-member"
                    >
                      ×
                    </button>
                  )}
                </li>
              ))
            )}
          </ul>

          {canManage ? (
            <form onSubmit={handleShare} className="invite-form">
              <label htmlFor="share-user-id">Invite user</label>
              <input
                id="share-user-id"
                placeholder="@user:homeserver"
                value={shareUserId}
                onChange={(e) => setShareUserId(e.target.value)}
                maxLength={MAX_MEMBER_ID_BYTES}
                data-testid="share-user-id"
              />
              <div className="invite-form-row">
                <label htmlFor="share-role">Role</label>
                <select
                  id="share-role"
                  value={shareRole}
                  onChange={(e) => setShareRole(e.target.value as "viewer" | "editor")}
                  data-testid="share-role"
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                </select>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={busy || !shareUserId.trim()}
                  data-testid="share-submit"
                >
                  Invite
                </button>
              </div>
            </form>
          ) : (
            <p className="members-panel-hint muted" data-testid="members-readonly">
              Only vault owners can manage access.
            </p>
          )}
        </>
      )}
    </aside>
  );
}
