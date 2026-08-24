import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MembersPanel } from "./MembersPanel";
import { useStorage } from "../context/StorageContext";
import * as core from "../lib/core";

vi.mock("../context/StorageContext", () => ({
  useStorage: vi.fn(),
}));

vi.mock("../lib/core", async () => {
  const actual = await vi.importActual<typeof import("../lib/core")>("../lib/core");
  return {
    ...actual,
    getMyVaultRole: vi.fn(),
    getVaultDetails: vi.fn(),
    listMembers: vi.fn(),
    shareVault: vi.fn(),
    unshareVault: vi.fn(),
  };
});

const POLL_MS = 4000;
const useStorageMock = vi.mocked(useStorage);

function fakeStorage() {
  return { keys: {} };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(core.getMyVaultRole).mockReturnValue("owner");
  vi.mocked(core.getVaultDetails).mockResolvedValue({
    name: "Vault",
    id: "!vault:localhost",
    createdAt: null,
    memberCount: 0,
  });
  useStorageMock.mockReturnValue({
    storage: fakeStorage(),
    session: { userId: "@alice:localhost" },
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MembersPanel access state", () => {
  it("clears member identities when a refresh fails", async () => {
    vi.useFakeTimers();
    vi.mocked(core.listMembers)
      .mockResolvedValueOnce([{ userId: "@bob:localhost", role: "viewer", membership: "join" }])
      .mockRejectedValueOnce(new Error("membership unavailable"));
    render(<MembersPanel vaultId="!vault:localhost" embedded />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("member-item")).toHaveAttribute("data-user-id", "@bob:localhost");

    await act(async () => {
      vi.advanceTimersByTime(POLL_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId("member-item")).not.toBeInTheDocument();
    expect(screen.getByTestId("members-error")).toHaveTextContent(
      "The operation could not be completed. Please try again.",
    );
  });

  it("does not refresh or clear an invite after ownership is revoked in flight", async () => {
    const share = deferred<{ vaultId: string; userId: string; role: "editor" }>();
    let role = "owner";
    vi.mocked(core.getMyVaultRole).mockImplementation(() => role);
    vi.mocked(core.listMembers).mockResolvedValue([]);
    vi.mocked(core.shareVault).mockReturnValue(share.promise);
    const user = userEvent.setup();
    render(<MembersPanel vaultId="!vault:localhost" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await user.type(screen.getByTestId("share-user-id"), "@bob:localhost");
    const submit = user.click(screen.getByTestId("share-submit"));
    await waitFor(() => expect(core.shareVault).toHaveBeenCalled());
    role = "viewer";
    share.resolve({ vaultId: "!vault:localhost", userId: "@bob:localhost", role: "editor" });
    await submit;

    expect(core.listMembers).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId("share-submit")).not.toBeInTheDocument());
  });

  it("rejects malformed member responses and does not render their identities", async () => {
    vi.mocked(core.listMembers).mockResolvedValue([
      { userId: "@not valid:localhost", role: "viewer", membership: "join" },
    ]);
    render(<MembersPanel vaultId="!vault:localhost" embedded />);

    expect(await screen.findByTestId("members-error")).toHaveTextContent(
      "The operation could not be completed. Please try again.",
    );
    expect(screen.queryByTestId("member-item")).not.toBeInTheDocument();
  });

  it("accepts canonical plus localparts but rejects oversized Matrix IDs", async () => {
    vi.mocked(core.listMembers).mockResolvedValue([
      { userId: "@bob+device:localhost", role: "viewer", membership: "join" },
    ]);
    const view = render(<MembersPanel vaultId="!vault:localhost" embedded />);
    expect(await screen.findByTestId("member-item")).toHaveAttribute(
      "data-user-id",
      "@bob+device:localhost",
    );

    vi.mocked(core.listMembers).mockResolvedValue([
      { userId: `@${"a".repeat(250)}:localhost`, role: "viewer", membership: "join" },
    ]);
    view.unmount();
    render(<MembersPanel vaultId="!vault:localhost" embedded />);
    expect(await screen.findByTestId("members-error")).toHaveTextContent(
      "The operation could not be completed. Please try again.",
    );
  });

  it("validates mutation results and serializes overlapping invitations", async () => {
    const share = deferred<{ vaultId: string; userId: string; role: "editor" }>();
    vi.mocked(core.listMembers).mockResolvedValue([]);
    vi.mocked(core.shareVault).mockReturnValue(share.promise);
    const user = userEvent.setup();
    render(<MembersPanel vaultId="!vault:localhost" />);
    await waitFor(() => expect(screen.getByText("No members")).toBeInTheDocument());
    await user.type(screen.getByTestId("share-user-id"), "@bob:localhost");

    const first = user.click(screen.getByTestId("share-submit"));
    await waitFor(() => expect(core.shareVault).toHaveBeenCalledTimes(1));
    const second = user.click(screen.getByTestId("share-submit"));
    expect(core.shareVault).toHaveBeenCalledTimes(1);
    share.resolve({ vaultId: "!unexpected:localhost", userId: "@bob:localhost", role: "editor" });
    await first;
    await second;

    expect(await screen.findByTestId("members-error")).toHaveTextContent(
      "The operation could not be completed. Please try again.",
    );
  });
});
