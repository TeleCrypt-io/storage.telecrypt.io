import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { FileManager } from "./FileManager";
import { useStorage } from "../context/StorageContext";
import * as core from "../lib/core";
import type { TeleCryptIOStorage } from "../lib/core";

vi.mock("../context/StorageContext", () => ({
  useStorage: vi.fn(),
}));

vi.mock("../lib/core", async () => {
  const actual = await vi.importActual<typeof import("../lib/core")>("../lib/core");
  return {
    ...actual,
    listVaults: vi.fn(),
    listPendingInvites: vi.fn(),
    getMyVaultRole: vi.fn(),
    createVault: vi.fn(),
    listFiles: vi.fn(),
    listSubfolders: vi.fn(),
    getVaultDetails: vi.fn(),
    getFolderDetails: vi.fn(),
    listMembers: vi.fn(),
    renameVault: vi.fn(),
    deleteVault: vi.fn(),
  };
});

const POLL_MS = 2500;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fakeStorage(name: string) {
  return {
    name,
    keys: { isRecoverySetup: vi.fn().mockResolvedValue(true) },
  } as unknown as TeleCryptIOStorage;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const useStorageMock = vi.mocked(useStorage);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(core.listPendingInvites).mockResolvedValue([]);
  vi.mocked(core.getMyVaultRole).mockReturnValue("owner");
  vi.mocked(core.listFiles).mockResolvedValue([]);
  vi.mocked(core.listSubfolders).mockResolvedValue([]);
  vi.mocked(core.listMembers).mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FileManager refresh identity", () => {
  it("leaves recovery status and setup controls to the Recovery view", async () => {
    const storage = fakeStorage("configured");
    vi.mocked(core.listVaults).mockResolvedValue([]);
    useStorageMock.mockReturnValue({ storage } as never);

    render(<FileManager />);
    await flush();

    expect(storage.keys.isRecoverySetup).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /set up account recovery/i })).not.toBeInTheDocument();
  });

  it("discards a previous account refresh after storage changes", async () => {
    const storageA = fakeStorage("A");
    const storageB = fakeStorage("B");
    const stale = deferred<Array<{ id: string; name: string }>>();

    vi.mocked(core.listVaults).mockImplementation(async (storage) =>
      storage === storageA
        ? stale.promise
        : [{ id: "!b:localhost", name: "Account B vault" }],
    );

    useStorageMock.mockReturnValue({ storage: storageA } as never);
    const view = render(<FileManager />);
    await flush();

    useStorageMock.mockReturnValue({ storage: storageB } as never);
    view.rerender(<FileManager />);
    await flush();

    expect(screen.getByText("Account B vault")).toBeInTheDocument();
    stale.resolve([{ id: "!a:localhost", name: "Account A vault" }]);
    await flush();

    expect(screen.queryByText("Account A vault")).not.toBeInTheDocument();
    expect(screen.getByText("Account B vault")).toBeInTheDocument();
    expect(screen.queryByTestId("vault-detail")).not.toBeInTheDocument();
  });

  it("keeps the newest overlapping refresh result", async () => {
    const storage = fakeStorage("shared");
    const stale = deferred<Array<{ id: string; name: string }>>();
    let call = 0;
    vi.mocked(core.listVaults).mockImplementation(async () => {
      call += 1;
      if (call === 2) return stale.promise;
      return call >= 3
        ? [{ id: "!fresh:localhost", name: "Fresh vault" }]
        : [{ id: "!initial:localhost", name: "Initial vault" }];
    });

    vi.mocked(core.renameVault).mockResolvedValue({ id: "!initial:localhost", name: "Renamed" });
    vi.mocked(core.createVault).mockResolvedValue({ id: "!created:localhost", name: "Created" });
    useStorageMock.mockReturnValue({ storage } as never);
    const user = userEvent.setup();
    render(<FileManager />);
    await screen.findByText("Initial vault");

    await user.click(screen.getByTestId("rename-vault"));
    fireEvent.change(screen.getByTestId("rename-vault-input"), { target: { value: "Renamed" } });
    fireEvent.keyDown(screen.getByTestId("rename-vault-input"), { key: "Enter" });
    await waitFor(() => expect(core.listVaults).toHaveBeenCalledTimes(2));

    await user.click(screen.getByTestId("create-vault"));
    await waitFor(() => expect(core.listVaults).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("Fresh vault")).toBeInTheDocument();
    stale.resolve([{ id: "!stale:localhost", name: "Stale vault" }]);
    await flush();

    expect(screen.queryByText("Stale vault")).not.toBeInTheDocument();
    expect(screen.getByText("Fresh vault")).toBeInTheDocument();
  });

  it("removes stale owner controls when the role snapshot becomes unavailable", async () => {
    vi.useFakeTimers();
    const storage = fakeStorage("shared");
    vi.mocked(core.listVaults).mockResolvedValue([{ id: "!vault:localhost", name: "Shared" }]);
    useStorageMock.mockReturnValue({ storage } as never);
    render(<FileManager />);
    await flush();

    expect(screen.getByTestId("rename-vault")).toBeInTheDocument();
    vi.mocked(core.getMyVaultRole).mockImplementation(() => {
      throw new Error("role unavailable");
    });

    await act(async () => {
      vi.advanceTimersByTime(POLL_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId("rename-vault")).not.toBeInTheDocument();
    expect(screen.queryByTestId("delete-vault")).not.toBeInTheDocument();
  });

  it("does not delete a vault after an owner role is revoked while its control is open", async () => {
    const storage = fakeStorage("shared");
    let role = "owner";
    vi.mocked(core.getMyVaultRole).mockImplementation(() => role);
    vi.mocked(core.listVaults).mockResolvedValue([{ id: "!vault:localhost", name: "Shared" }]);
    vi.mocked(core.deleteVault).mockResolvedValue({ id: "!vault:localhost", deleted: true });
    useStorageMock.mockReturnValue({ storage } as never);
    const user = userEvent.setup();
    render(<FileManager />);
    await waitFor(() => expect(screen.getByTestId("delete-vault")).toBeInTheDocument());

    const deleteButton = screen.getByTestId("delete-vault");
    role = "viewer";
    vi.stubGlobal("confirm", () => true);
    await user.click(deleteButton);

    expect(core.deleteVault).not.toHaveBeenCalled();
  });

  it("does not apply a pending delete completion after ownership is revoked", async () => {
    const storage = fakeStorage("shared");
    const deletion = deferred<{ id: string; deleted: true }>();
    let role = "owner";
    vi.mocked(core.getMyVaultRole).mockImplementation(() => role);
    vi.mocked(core.listVaults).mockResolvedValue([{ id: "!vault:localhost", name: "Shared" }]);
    vi.mocked(core.deleteVault).mockReturnValue(deletion.promise);
    useStorageMock.mockReturnValue({ storage } as never);
    const user = userEvent.setup();
    render(<FileManager />);
    await waitFor(() => expect(screen.getByTestId("delete-vault")).toBeInTheDocument());

    vi.stubGlobal("confirm", () => true);
    const deleteTask = user.click(screen.getByTestId("delete-vault"));
    await waitFor(() => expect(core.deleteVault).toHaveBeenCalled());
    role = "viewer";
    deletion.resolve({ id: "!vault:localhost", deleted: true });
    await deleteTask;

    expect(screen.getByText("Shared")).toBeInTheDocument();
    expect(core.listVaults).toHaveBeenCalledTimes(1);
  });

  it("clears owner controls when the vault refresh fails", async () => {
    vi.useFakeTimers();
    const storage = fakeStorage("shared");
    let refreshCount = 0;
    vi.mocked(core.listVaults).mockImplementation(async () => {
      refreshCount += 1;
      if (refreshCount > 1) throw new Error("vault list unavailable");
      return [{ id: "!vault:localhost", name: "Shared" }];
    });
    useStorageMock.mockReturnValue({ storage } as never);
    render(<FileManager />);
    await flush();
    expect(screen.getByTestId("delete-vault")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(POLL_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId("delete-vault")).not.toBeInTheDocument();
    expect(screen.getByTestId("vault-list-error")).toHaveTextContent(
      "The operation could not be completed. Please try again.",
    );
  });

  it("rejects malformed remote vault names and vault rename input", async () => {
    const storage = fakeStorage("shared");
    vi.mocked(core.listVaults).mockResolvedValue([{ id: "!vault:localhost", name: "Shared" }]);
    useStorageMock.mockReturnValue({ storage } as never);
    const user = userEvent.setup();
    render(<FileManager />);
    await waitFor(() => expect(screen.getByTestId("rename-vault")).toBeInTheDocument());

    await user.click(screen.getByTestId("rename-vault"));
    fireEvent.change(screen.getByTestId("rename-vault-input"), {
      target: { value: "not/a-name" },
    });
    fireEvent.keyDown(screen.getByTestId("rename-vault-input"), { key: "Enter" });

    expect(core.renameVault).not.toHaveBeenCalled();
    expect(screen.getByTestId("vault-list-error")).toHaveTextContent(
      "The vault name is invalid or too long.",
    );
  });

  it("does not render a vault name that exceeds the remote name bound", async () => {
    const storage = fakeStorage("shared");
    vi.mocked(core.listVaults).mockResolvedValue([
      { id: "!vault:localhost", name: "x".repeat(256) },
    ]);
    useStorageMock.mockReturnValue({ storage } as never);
    render(<FileManager />);

    expect(await screen.findByTestId("vault-list-error")).toHaveTextContent(
      "The operation could not be completed. Please try again.",
    );
    expect(screen.queryByText("x".repeat(256))).not.toBeInTheDocument();
  });

  it("clears a selected vault when the account no longer lists it", async () => {
    vi.useFakeTimers();
    const storage = fakeStorage("shared");
    let refreshCount = 0;
    vi.mocked(core.listVaults).mockImplementation(async () => {
      refreshCount += 1;
      return refreshCount === 1 ? [{ id: "!vault:localhost", name: "Shared" }] : [];
    });
    useStorageMock.mockReturnValue({ storage } as never);
    render(<FileManager />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Shared" }));
    expect(screen.getByTestId("vault-detail")).toHaveAttribute("data-vault-id", "!vault:localhost");

    await act(async () => {
      vi.advanceTimersByTime(POLL_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("select-vault-prompt")).toBeInTheDocument();
  });

  it("does not auto-navigate after a pending vault creation if the user navigated away", async () => {
    const storage = fakeStorage("shared");
    const creation = deferred<{ id: string; name: string }>();
    vi.mocked(core.listVaults).mockResolvedValue([
      { id: "!a:localhost", name: "A" },
      { id: "!b:localhost", name: "B" },
    ]);
    vi.mocked(core.createVault).mockReturnValue(creation.promise as never);

    useStorageMock.mockReturnValue({ storage } as never);
    const user = userEvent.setup();
    render(<FileManager />);
    await waitFor(() => expect(screen.getByText("A")).toBeInTheDocument());

    await user.click(screen.getByTestId("create-vault"));
    await waitFor(() => expect(core.createVault).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "B" }));
    await waitFor(() =>
      expect(screen.getByTestId("vault-detail")).toHaveAttribute("data-vault-id", "!b:localhost"),
    );

    creation.resolve({ id: "!created:localhost", name: "Untitled vault" });
    await flush();

    expect(screen.getByTestId("vault-detail")).toHaveAttribute("data-vault-id", "!b:localhost");
  });
});
