import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import * as core from "./lib/core";
import { formatElapsed } from "./lib/formatElapsed";
import { formatOperationError } from "./lib/formatOperationError";
import * as oidcAuth from "./lib/oidcAuth";
import { saveSession } from "./lib/session";

vi.mock("./lib/core", async () => {
  const actual = await vi.importActual<typeof import("./lib/core")>("./lib/core");
  return {
    ...actual,
    TeleCryptIOStorage: { create: vi.fn(), createFromOidc: vi.fn() },
    discoverOidcIssuer: vi.fn(),
    buildTokenRefreshFunction: vi.fn(),
    listFolders: vi.fn(),
    listPendingInvites: vi.fn(),
    getMyFolderRole: vi.fn(),
    createFolder: vi.fn(),
    joinFolder: vi.fn(),
    declineInvite: vi.fn(),
    listFiles: vi.fn(),
    listSubfolders: vi.fn(),
    createSubfolder: vi.fn(),
    uploadFile: vi.fn(),
    downloadFile: vi.fn(),
    renameFile: vi.fn(),
    renameFolder: vi.fn(),
    deleteFile: vi.fn(),
    deleteFolder: vi.fn(),
    shareFolder: vi.fn(),
    unshareFolder: vi.fn(),
    listMembers: vi.fn(),
    getFileDetails: vi.fn(),
    getFolderDetails: vi.fn(),
    setupRecovery: vi.fn(),
    restoreRecovery: vi.fn(),
  };
});

vi.mock("./lib/oidcAuth", async () => {
  const actual = await vi.importActual<typeof import("./lib/oidcAuth")>("./lib/oidcAuth");
  return { ...actual, beginOidcLogin: vi.fn(), isOidcCallback: vi.fn(() => false) };
});

const SESSION = {
  homeserver: "http://localhost:8008",
  userId: "@alice:localhost",
  deviceId: "DEVICE1",
  accessToken: "tok-123",
  refreshToken: "refresh-123",
  oidcIssuer: "http://localhost:8082",
  oidcClientId: "telecrypt-ui-client",
};

function fakeStorage() {
  return {
    getClient: () => ({ stopClient: vi.fn() }),
    keys: {
      isRecoverySetup: vi.fn().mockResolvedValue(false),
      setupRecovery: vi.fn(),
      restoreFromRecoveryKey: vi.fn(),
    },
  };
}

async function loginAndReachVaults(initialVaults: Array<{ id: string; name: string }> = []) {
  const storage = fakeStorage();
  vi.mocked(core.discoverOidcIssuer).mockResolvedValue({
    issuer: SESSION.oidcIssuer,
    token_endpoint: `${SESSION.oidcIssuer}/oauth2/token`,
  } as never);
  vi.mocked(core.buildTokenRefreshFunction).mockReturnValue(vi.fn());
  vi.mocked(core.TeleCryptIOStorage.createFromOidc).mockResolvedValue(storage as never);
  vi.mocked(core.listFolders).mockResolvedValue(initialVaults);
  vi.mocked(core.listPendingInvites).mockResolvedValue([]);

  const user = userEvent.setup();
  saveSession(SESSION);
  render(<App />);

  await waitFor(() => expect(screen.getByTestId("current-user")).toHaveTextContent(SESSION.userId));
  if (initialVaults.length === 0) {
    await screen.findByTestId("no-vaults");
  } else {
    await screen.findByText(initialVaults[0].name);
  }
  return { storage, user };
}

async function openVault(
  name = "Docs",
  opts?: {
    files?: Array<{ id: string; name: string }>;
    subfolders?: Array<{ id: string; name: string }>;
    members?: Array<{ userId: string; role: string; membership: string }>;
  },
) {
  vi.mocked(core.listFiles).mockImplementation(async () => opts?.files ?? []);
  vi.mocked(core.listSubfolders).mockImplementation(async () => opts?.subfolders ?? []);
  vi.mocked(core.listMembers).mockImplementation(async () => opts?.members ?? []);
  vi.mocked(core.getFolderDetails).mockResolvedValue({
    name,
    id: "!f:localhost",
    createdAt: null,
    memberCount: opts?.members?.length ?? 1,
  });
  const { user } = await loginAndReachVaults([{ id: "!f:localhost", name }]);
  await user.click(screen.getByRole("button", { name }));
  await screen.findByTestId("folder-detail");
  return user;
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(core.getMyFolderRole).mockReturnValue("owner");
});

describe("formatElapsed", () => {
  it("shows milliseconds under 2 seconds", () => {
    expect(formatElapsed(340)).toBe("340ms");
    expect(formatElapsed(1999)).toBe("1999ms");
  });

  it("shows seconds with one decimal under one minute", () => {
    expect(formatElapsed(2500)).toBe("2.5s");
    expect(formatElapsed(45000)).toBe("45.0s");
  });

  it("shows m:ss at one minute and beyond", () => {
    expect(formatElapsed(65000)).toBe("1:05");
    expect(formatElapsed(125000)).toBe("2:05");
  });
});

describe("formatOperationError", () => {
  it("maps 413 / M_TOO_LARGE to user-facing upload message", () => {
    expect(formatOperationError(new Error("HTTP 413"))).toBe("Server refused to create file");
    expect(formatOperationError(new Error("M_TOO_LARGE"))).toBe("Server refused to create file");
    expect(formatOperationError(new Error("Upload request body is too large"))).toBe(
      "Server refused to create file",
    );
  });

  it("passes through other errors unchanged", () => {
    expect(formatOperationError(new Error("network down"))).toBe("network down");
  });
});

describe("authentication", () => {
  it("restores a persisted OAuth session through createFromOidc", async () => {
    await loginAndReachVaults();
    expect(core.TeleCryptIOStorage.createFromOidc).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: SESSION.homeserver,
        userId: SESSION.userId,
        deviceId: SESSION.deviceId,
        accessToken: SESSION.accessToken,
        refreshToken: SESSION.refreshToken,
      }),
    );
    expect(screen.getByTestId("no-vaults")).toBeInTheDocument();
  });

  it("offers only OAuth login and reports a pre-redirect OAuth error", async () => {
    vi.mocked(oidcAuth.beginOidcLogin).mockRejectedValue(new Error("OIDC discovery failed"));
    const user = userEvent.setup();
    render(<App />);

    expect(screen.queryByTestId("username")).not.toBeInTheDocument();
    expect(screen.queryByTestId("password")).not.toBeInTheDocument();
    expect(screen.queryByTestId("submit")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("oidc-login"));

    expect(oidcAuth.beginOidcLogin).toHaveBeenCalledWith(SESSION.homeserver);
    expect(await screen.findByTestId("auth-error")).toHaveTextContent("OIDC discovery failed");
    expect(core.TeleCryptIOStorage.createFromOidc).not.toHaveBeenCalled();
  });
});

describe("vaults", () => {
  it("creates a vault via core.createFolder with untitled name and inline rename", async () => {
    await loginAndReachVaults();
    vi.mocked(core.listFiles).mockResolvedValue([]);
    vi.mocked(core.listSubfolders).mockResolvedValue([]);
    vi.mocked(core.listMembers).mockResolvedValue([]);
    vi.mocked(core.getFolderDetails).mockResolvedValue({
      name: "Untitled vault",
      id: "!new:localhost",
      createdAt: null,
      memberCount: 1,
    });
    vi.mocked(core.createFolder).mockResolvedValue({ id: "!new:localhost", name: "Untitled vault" });
    vi.mocked(core.renameFolder).mockResolvedValue({ id: "!new:localhost", name: "Docs" });
    vi.mocked(core.listFolders).mockResolvedValue([{ id: "!new:localhost", name: "Docs" }]);

    const user = userEvent.setup();
    await user.click(screen.getByTestId("create-vault"));

    expect(core.createFolder).toHaveBeenCalledWith(expect.anything(), "Untitled vault");

    const renameInput = await screen.findByTestId("rename-vault-input");
    fireEvent.change(renameInput, { target: { value: "Docs" } });
    fireEvent.keyDown(renameInput, { key: "Enter" });
    await waitFor(() =>
      expect(core.renameFolder).toHaveBeenCalledWith(expect.anything(), "!new:localhost", "Docs"),
    );
    expect(await screen.findByTestId("folder-detail")).toHaveAttribute("data-folder-id", "!new:localhost");
  });

  it("lists and selects a vault", async () => {
    vi.mocked(core.listFiles).mockResolvedValue([{ id: "$file1", name: "report.pdf" }]);
    await loginAndReachVaults([{ id: "!f:localhost", name: "Docs" }]);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Docs" }));

    expect(core.listFiles).toHaveBeenCalledWith(expect.anything(), "!f:localhost");
    expect(await screen.findByText("report.pdf")).toBeInTheDocument();
  });

  it("hides destructive vault controls from non-owners", async () => {
    vi.mocked(core.getMyFolderRole).mockReturnValue("viewer");
    await loginAndReachVaults([{ id: "!shared:localhost", name: "Shared" }]);

    const item = screen.getByTestId("vault-item");
    expect(item).not.toContainElement(screen.queryByTestId("rename-vault"));
    expect(item).not.toContainElement(screen.queryByTestId("delete-vault"));
  });

  it("accepts a pending invite via core.joinFolder", async () => {
    const storage = fakeStorage();
    vi.mocked(core.discoverOidcIssuer).mockResolvedValue({
      issuer: SESSION.oidcIssuer,
      token_endpoint: `${SESSION.oidcIssuer}/oauth2/token`,
    } as never);
    vi.mocked(core.buildTokenRefreshFunction).mockReturnValue(vi.fn());
    vi.mocked(core.TeleCryptIOStorage.createFromOidc).mockResolvedValue(storage as never);
    vi.mocked(core.listFolders).mockResolvedValue([]);
    vi.mocked(core.listPendingInvites).mockResolvedValue([
      { id: "!shared:localhost", name: "Shared" },
    ]);

    const user = userEvent.setup();
    saveSession(SESSION);
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("current-user")).toHaveTextContent(SESSION.userId));
    await screen.findByTestId("invite-list");
    await user.click(screen.getByTestId("accept-invite"));

    await waitFor(() =>
      expect(core.joinFolder).toHaveBeenCalledWith(expect.anything(), "!shared:localhost"),
    );
  });

  it("declines a pending invite via core.declineInvite", async () => {
    const storage = fakeStorage();
    vi.mocked(core.discoverOidcIssuer).mockResolvedValue({
      issuer: SESSION.oidcIssuer,
      token_endpoint: `${SESSION.oidcIssuer}/oauth2/token`,
    } as never);
    vi.mocked(core.buildTokenRefreshFunction).mockReturnValue(vi.fn());
    vi.mocked(core.TeleCryptIOStorage.createFromOidc).mockResolvedValue(storage as never);
    vi.mocked(core.listFolders).mockResolvedValue([]);
    vi.mocked(core.listPendingInvites).mockResolvedValue([
      { id: "!shared:localhost", name: "Shared" },
    ]);

    const user = userEvent.setup();
    saveSession(SESSION);
    render(<App />);

    await screen.findByTestId("invite-list");
    await user.click(screen.getByTestId("decline-invite"));

    await waitFor(() =>
      expect(core.declineInvite).toHaveBeenCalledWith(expect.anything(), "!shared:localhost"),
    );
  });

  it("nav up at vault root returns to vault list", async () => {
    const user = await openVault();
    await user.click(screen.getByTestId("nav-up"));
    expect(await screen.findByTestId("select-vault-prompt")).toBeInTheDocument();
  });
});

describe("folder contents", () => {
  it("creates a subfolder via button + inline rename", async () => {
    const user = await openVault();
    vi.mocked(core.createSubfolder).mockResolvedValue({ id: "!sub:localhost", name: "Untitled folder" });
    vi.mocked(core.listSubfolders).mockResolvedValue([{ id: "!sub:localhost", name: "Child" }]);

    await user.click(screen.getByTestId("create-subfolder"));
    expect(core.createSubfolder).toHaveBeenCalledWith(expect.anything(), "!f:localhost", "Untitled folder");

    const renameInput = await screen.findByTestId("rename-input");
    fireEvent.change(renameInput, { target: { value: "Child" } });
    fireEvent.keyDown(renameInput, { key: "Enter" });
    await waitFor(() =>
      expect(core.renameFolder).toHaveBeenCalledWith(expect.anything(), "!sub:localhost", "Child"),
    );
  });

  it("uploads a picked file via core.uploadFile", async () => {
    const user = await openVault();
    vi.mocked(core.uploadFile).mockResolvedValue({ id: "$new", name: "hello.txt" });
    vi.mocked(core.listFiles).mockResolvedValue([{ id: "$new", name: "hello.txt" }]);

    const file = new File(["hello world"], "hello.txt", { type: "text/plain" });
    const input = screen.getByTestId("file-input") as HTMLInputElement;
    await user.upload(input, file);

    await waitFor(() =>
      expect(core.uploadFile).toHaveBeenCalledWith(
        expect.anything(),
        "!f:localhost",
        "hello.txt",
        expect.any(Uint8Array),
        "text/plain",
      ),
    );
    expect(await screen.findByText("hello.txt")).toBeInTheDocument();
  });

  it("shows mapped error when upload fails with 413", async () => {
    const user = await openVault();
    vi.mocked(core.uploadFile).mockRejectedValue(new Error("HTTP 413 M_TOO_LARGE"));

    const file = new File(["x"], "big.bin", { type: "application/octet-stream" });
    await user.upload(screen.getByTestId("file-input"), file);

    expect(await screen.findByTestId("folder-detail-error")).toHaveTextContent(
      "Server refused to create file",
    );
  });

  it("downloads a file via core.downloadFile", async () => {
    vi.mocked(core.downloadFile).mockResolvedValue({
      bytes: new TextEncoder().encode("hello world"),
      mimetype: "text/plain",
      name: "hello.txt",
    });
    const user = await openVault("Docs", { files: [{ id: "$f1", name: "hello.txt" }] });
    await screen.findByText("hello.txt");

    await user.click(screen.getByTestId("download-file"));

    await waitFor(() =>
      expect(core.downloadFile).toHaveBeenCalledWith(expect.anything(), "!f:localhost", "$f1"),
    );
  });

  it("renames and deletes a file", async () => {
    const user = await openVault("Docs", { files: [{ id: "$f1", name: "old.txt" }] });
    await screen.findByText("old.txt");

    await user.click(screen.getByTestId("rename-file"));
    const input = screen.getByTestId("rename-input");
    fireEvent.change(input, { target: { value: "new.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(core.renameFile).toHaveBeenCalledWith(expect.anything(), "!f:localhost", "$f1", "new.txt"),
    );

    vi.stubGlobal("confirm", () => true);
    vi.mocked(core.listFiles).mockResolvedValue([]);
    await user.click(screen.getByTestId("delete-file"));
    await waitFor(() =>
      expect(core.deleteFile).toHaveBeenCalledWith(expect.anything(), "!f:localhost", "$f1"),
    );
    vi.unstubAllGlobals();
  });

  it("renames and deletes a subfolder", async () => {
    const user = await openVault("Docs", { subfolders: [{ id: "!sub:localhost", name: "Child" }] });
    await waitFor(() => expect(screen.getByTestId("subfolder-item")).toHaveTextContent("Child"));

    await user.click(screen.getByTestId("rename-subfolder"));
    const input = screen.getByTestId("rename-input");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(core.renameFolder).toHaveBeenCalledWith(expect.anything(), "!sub:localhost", "Renamed"),
    );

    vi.stubGlobal("confirm", () => true);
    await user.click(screen.getByTestId("delete-subfolder"));
    await waitFor(() =>
      expect(core.deleteFolder).toHaveBeenCalledWith(expect.anything(), "!sub:localhost"),
    );
    vi.unstubAllGlobals();
  });

  it("shows the details panel when a vault is open", async () => {
    await openVault();
    expect(screen.getByTestId("details-panel")).toBeInTheDocument();
  });
});

describe("sharing", () => {
  it("invites a user via core.shareFolder and shows them in the member list", async () => {
    const user = await openVault();
    await screen.findByTestId("no-files");

    vi.mocked(core.shareFolder).mockResolvedValue({
      folderId: "!f:localhost",
      userId: "@bob:localhost",
      role: "editor",
    });
    vi.mocked(core.listMembers).mockResolvedValue([
      { userId: "@bob:localhost", role: "editor", membership: "invite" },
    ]);

    await user.type(screen.getByTestId("share-user-id"), "@bob:localhost");
    await user.click(screen.getByTestId("share-submit"));

    expect(core.shareFolder).toHaveBeenCalledWith(
      expect.anything(),
      "!f:localhost",
      "@bob:localhost",
      "editor",
    );
    expect(await screen.findByTestId("member-item")).toHaveAttribute("data-user-id", "@bob:localhost");
  });

  it("removes a member via core.unshareFolder", async () => {
    const user = await openVault("Docs", {
      members: [{ userId: "@bob:localhost", role: "viewer", membership: "join" }],
    });
    await waitFor(() => expect(screen.getByTestId("member-item")).toBeInTheDocument());

    vi.mocked(core.unshareFolder).mockResolvedValue({
      folderId: "!f:localhost",
      userId: "@bob:localhost",
      removed: true,
    });
    vi.mocked(core.listMembers).mockResolvedValue([]);

    await user.click(screen.getByTestId("unshare-member"));

    expect(core.unshareFolder).toHaveBeenCalledWith(
      expect.anything(),
      "!f:localhost",
      "@bob:localhost",
    );
  });
});

describe("recovery", () => {
  it("sets up recovery, requires confirm saved, then dismisses key display", async () => {
    const { storage } = await loginAndReachVaults();
    vi.mocked(storage.keys.isRecoverySetup).mockResolvedValue(false);
    vi.mocked(core.setupRecovery).mockResolvedValue({ recoveryKey: "EsTx 1234 5678" });

    const user = userEvent.setup();
    await user.click(screen.getByTestId("nav-recovery"));
    await user.click(await screen.findByTestId("setup-recovery"));

    expect(core.setupRecovery).toHaveBeenCalledWith(expect.anything());
    expect(await screen.findByTestId("recovery-key-value")).toHaveTextContent("EsTx 1234 5678");
    expect(screen.queryByTestId("restore-key-input")).not.toBeInTheDocument();

    expect(screen.getByTestId("recovery-setup-done")).toBeDisabled();
    await user.click(screen.getByTestId("confirm-saved-recovery-key"));
    await user.click(screen.getByTestId("recovery-setup-done"));

    await waitFor(() =>
      expect(screen.queryByTestId("recovery-key-display")).not.toBeInTheDocument(),
    );
    expect(await screen.findByTestId("recovery-active")).toBeInTheDocument();
  });

  it("restores from a pasted key when recovery is already set up", async () => {
    const { storage } = await loginAndReachVaults();
    vi.mocked(storage.keys.isRecoverySetup).mockResolvedValue(true);
    vi.mocked(core.restoreRecovery).mockResolvedValue({ imported: 3, total: 3 });

    const user = userEvent.setup();
    await user.click(screen.getByTestId("nav-recovery"));
    await user.click(await screen.findByTestId("restore-expand"));
    await user.type(screen.getByTestId("restore-key-input"), "EsTx recovery key text");
    await user.click(screen.getByTestId("restore-submit"));

    expect(core.restoreRecovery).toHaveBeenCalledWith(expect.anything(), "EsTx recovery key text");
    expect(await screen.findByTestId("restore-result")).toHaveTextContent("Imported 3 of 3");
  });

  it("shows restore expandable on a device without local recovery setup", async () => {
    const { storage } = await loginAndReachVaults();
    vi.mocked(storage.keys.isRecoverySetup).mockResolvedValue(false);

    const user = userEvent.setup();
    await user.click(screen.getByTestId("nav-recovery"));
    expect(await screen.findByTestId("recovery-not-setup")).toBeInTheDocument();
    expect(await screen.findByTestId("restore-expand")).toBeInTheDocument();
    expect(screen.queryByTestId("restore-key-input")).not.toBeInTheDocument();
  });
});
