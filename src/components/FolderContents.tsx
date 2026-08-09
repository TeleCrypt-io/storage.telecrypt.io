import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type MouseEvent,
} from "react";
import { useStorage } from "../context/StorageContext";
import * as core from "../lib/core";
import type { FileInfo, FolderInfo, TeleCryptIOStorage } from "../lib/core";
import { formatOperationError } from "../lib/formatOperationError";
import type { Selection } from "./DetailsPanel";

const POLL_MS = 2500;
const UNTITLED_SUBFOLDER = "Untitled folder";

function uniqueUntitledSubfolderName(existing: FolderInfo[]): string {
  const names = new Set(existing.map((f) => f.name.toLowerCase()));
  if (!names.has(UNTITLED_SUBFOLDER.toLowerCase())) return UNTITLED_SUBFOLDER;
  let i = 2;
  while (names.has(`${UNTITLED_SUBFOLDER} ${i}`.toLowerCase())) i++;
  return `${UNTITLED_SUBFOLDER} ${i}`;
}

function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 4.5A1 1 0 0 1 2.5 3.5h3.17l1.33 1.33h6.5a1 1 0 0 1 1 1v7.17a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1V4.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4.5 1.5h4.59L12.5 4.91v9.59a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M9 1.5v3.5h3.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/** Ensure nested path segments exist under folderId; returns leaf folder id. */
async function ensurePath(
  storage: TeleCryptIOStorage,
  rootFolderId: string,
  relativePath: string,
): Promise<string> {
  const parts = relativePath.split("/").filter(Boolean);
  if (parts.length <= 1) return rootFolderId;

  let currentId = rootFolderId;
  for (const segment of parts.slice(0, -1)) {
    const subs = await core.listSubfolders(storage, currentId);
    const existing = subs.find((s) => s.name === segment);
    if (existing) {
      currentId = existing.id;
    } else {
      const created = await core.createSubfolder(storage, currentId, segment);
      currentId = created.id;
    }
  }
  return currentId;
}

export function FolderContents({
  folderId,
  folderName: _folderName,
  breadcrumb,
  isVaultRoot,
  onNavigate,
  onNavUp,
  onOpenSubfolder,
  onFolderRenamed,
  onFolderDeleted: _onFolderDeleted,
  selection,
  onSelect,
}: {
  folderId: string;
  folderName: string;
  breadcrumb: FolderInfo[];
  isVaultRoot: boolean;
  onNavigate: (index: number) => void;
  onNavUp: () => void;
  onOpenSubfolder: (sub: FolderInfo) => void;
  onFolderRenamed: (folderId: string, name: string) => void;
  onFolderDeleted: (folderId: string) => void;
  selection: Selection;
  onSelect: (sel: Selection) => void;
}) {
  const { storage } = useStorage();
  const [files, setFiles] = useState<FileInfo[] | null>(null);
  const [subfolders, setSubfolders] = useState<FolderInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [renaming, setRenaming] = useState<{ kind: "file" | "folder"; id: string; name: string } | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (!storage) return;
    try {
      const [fileList, subList] = await Promise.all([
        core.listFiles(storage, folderId),
        core.listSubfolders(storage, folderId),
      ]);
      setFiles(fileList);
      setSubfolders(subList);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [storage, folderId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  async function uploadBytes(targetFolderId: string, name: string, bytes: Uint8Array, mimetype: string) {
    setBusy(true);
    setError(null);
    try {
      await core.uploadFile(storage!, targetFolderId, name, bytes, mimetype);
      await refresh();
    } catch (err) {
      setError(formatOperationError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (!list?.length) return;
    for (const file of Array.from(list)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mimetype = file.type || "application/octet-stream";
      await uploadBytes(folderId, file.name, bytes, mimetype);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleFolderUpload(e: ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (!list?.length || !storage) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(list)) {
        const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const targetId = await ensurePath(storage, folderId, rel);
        const fileName = rel.includes("/") ? rel.split("/").pop()! : rel;
        const bytes = new Uint8Array(await file.arrayBuffer());
        await core.uploadFile(
          storage,
          targetId,
          fileName,
          bytes,
          file.type || "application/octet-stream",
        );
      }
      await refresh();
    } catch (err) {
      setError(formatOperationError(err));
    } finally {
      setBusy(false);
      if (folderInputRef.current) folderInputRef.current.value = "";
    }
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const list = e.dataTransfer.files;
    if (!list.length) return;
    for (const file of Array.from(list)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await uploadBytes(folderId, file.name, bytes, file.type || "application/octet-stream");
    }
  }

  async function handleDownload(f: FileInfo) {
    setBusy(true);
    setError(null);
    try {
      const result = await core.downloadFile(storage!, folderId, f.id);
      const blob = new Blob([result.bytes as BlobPart], { type: result.mimetype });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.name;
      a.setAttribute("data-testid", "download-anchor");
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(formatOperationError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteFile(fileId: string) {
    if (!confirm("Delete this file?")) return;
    setBusy(true);
    setError(null);
    try {
      await core.deleteFile(storage!, folderId, fileId);
      if (selection?.kind === "file" && selection.id === fileId) onSelect(null);
      await refresh();
    } catch (err) {
      setError(formatOperationError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteSubfolder(subId: string) {
    if (!confirm("Delete this folder and everything inside it?")) return;
    setBusy(true);
    setError(null);
    try {
      await core.deleteFolder(storage!, subId);
      if (selection?.id === subId) onSelect(null);
      await refresh();
    } catch (err) {
      setError(formatOperationError(err));
    } finally {
      setBusy(false);
    }
  }

  async function commitRename() {
    if (!renaming || !renaming.name.trim()) {
      setRenaming(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (renaming.kind === "file") {
        await core.renameFile(storage!, folderId, renaming.id, renaming.name.trim());
      } else {
        await core.renameFolder(storage!, renaming.id, renaming.name.trim());
        if (renaming.id === folderId) {
          onFolderRenamed(folderId, renaming.name.trim());
        }
      }
      await refresh();
    } catch (err) {
      setError(formatOperationError(err));
    } finally {
      setBusy(false);
      setRenaming(null);
    }
  }

  async function handleNewSubfolder() {
    setBusy(true);
    setError(null);
    try {
      const name = uniqueUntitledSubfolderName(subfolders ?? []);
      const created = await core.createSubfolder(storage!, folderId, name);
      await refresh();
      setRenaming({ kind: "folder", id: created.id, name: created.name });
    } catch (err) {
      setError(formatOperationError(err));
    } finally {
      setBusy(false);
    }
  }

  function isFileSelected(fileId: string) {
    return selection?.kind === "file" && selection.id === fileId;
  }

  function isSubfolderSelected(subId: string) {
    return selection?.kind === "folder" && selection.id === subId;
  }

  function handleFileRowClick(f: FileInfo) {
    onSelect({ kind: "file", id: f.id, folderId });
  }

  function handleSubfolderRowClick(sub: FolderInfo, e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest(".row-name-btn")) return;
    onSelect({ kind: "folder", id: sub.id, folderId });
  }

  const loading = files === null || subfolders === null;
  const empty = !loading && files!.length === 0 && subfolders!.length === 0;
  const upLabel = isVaultRoot ? "Back to vaults" : "Up";

  return (
    <div
      className={`folder-contents${dragOver ? " drag-over" : ""}`}
      data-testid="folder-detail"
      data-folder-id={folderId}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <div className="folder-nav-row">
        <button
          type="button"
          className="btn btn-sm nav-up-btn"
          onClick={onNavUp}
          data-testid="nav-up"
        >
          ↑ {upLabel}
        </button>
        <nav className="breadcrumb" aria-label="Folder path">
          {breadcrumb.map((crumb, i) => (
            <span key={crumb.id}>
              {i > 0 && <span className="breadcrumb-sep">/</span>}
              <button
                type="button"
                className="link breadcrumb-item"
                onClick={() => onNavigate(i)}
                data-testid="breadcrumb-item"
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>
      </div>

      <div className="toolbar">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void handleNewSubfolder()}
          disabled={busy}
          data-testid="create-subfolder"
        >
          New folder
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => folderInputRef.current?.click()}
          disabled={busy}
          data-testid="upload-folder-button"
        >
          Upload folder
        </button>
        <input
          type="file"
          ref={folderInputRef}
          onChange={handleFolderUpload}
          disabled={busy}
          multiple
          hidden
          // @ts-expect-error webkitdirectory is non-standard but widely supported
          webkitdirectory=""
          data-testid="folder-input"
        />
        <button
          type="button"
          className="btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          data-testid="upload-button"
        >
          Upload files
        </button>
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleUpload}
          disabled={busy}
          multiple
          hidden
          data-testid="file-input"
        />
      </div>

      <p className="upload-hint muted">
        Files upload into this folder. Use Upload files or drag files here.
      </p>

      {error && (
        <p className="error" data-testid="folder-detail-error">
          {error}
        </p>
      )}

      <div className="file-table-wrap">
        <table className="file-table">
          <thead>
            <tr>
              <th>Name</th>
              <th className="col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={2} className="muted">
                  Loading…
                </td>
              </tr>
            )}
            {!loading &&
              subfolders!.map((sub) => (
                <tr
                  key={sub.id}
                  className={isSubfolderSelected(sub.id) ? "selected-row" : undefined}
                  data-testid="subfolder-item"
                  data-folder-id={sub.id}
                  onClick={(e) => handleSubfolderRowClick(sub, e)}
                >
                  <td>
                    {renaming?.kind === "folder" && renaming.id === sub.id ? (
                      <input
                        className="rename-input"
                        value={renaming.name}
                        autoFocus
                        onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                        onBlur={() => void commitRename()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitRename();
                          if (e.key === "Escape") setRenaming(null);
                        }}
                        data-testid="rename-input"
                      />
                    ) : (
                      <button
                        type="button"
                        className="row-name-btn"
                        onClick={() => onOpenSubfolder(sub)}
                      >
                        <FolderIcon />
                        <span>{sub.name}</span>
                      </button>
                    )}
                  </td>
                  <td className="col-actions">
                    <div className="table-actions">
                      <button
                        type="button"
                        className="btn btn-sm row-action"
                        disabled={busy}
                        onClick={() => onOpenSubfolder(sub)}
                        data-testid="open-subfolder"
                      >
                        Open
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm row-action"
                        disabled={busy}
                        onClick={() => setRenaming({ kind: "folder", id: sub.id, name: sub.name })}
                        data-testid="rename-subfolder"
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm row-action btn-danger"
                        disabled={busy}
                        onClick={() => void handleDeleteSubfolder(sub.id)}
                        data-testid="delete-subfolder"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            {!loading &&
              files!.map((f) => (
                <tr
                  key={f.id}
                  className={isFileSelected(f.id) ? "selected-row" : undefined}
                  data-testid="file-item"
                  data-file-id={f.id}
                  onClick={() => handleFileRowClick(f)}
                >
                  <td>
                    {renaming?.kind === "file" && renaming.id === f.id ? (
                      <input
                        className="rename-input"
                        value={renaming.name}
                        autoFocus
                        onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                        onBlur={() => void commitRename()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitRename();
                          if (e.key === "Escape") setRenaming(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        data-testid="rename-input"
                      />
                    ) : (
                      <span className="row-name">
                        <FileIcon />
                        <span>{f.name}</span>
                      </span>
                    )}
                  </td>
                  <td className="col-actions">
                    <div className="table-actions">
                      <button
                        type="button"
                        className="btn btn-sm row-action"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDownload(f);
                        }}
                        data-testid="download-file"
                      >
                        Download
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm row-action"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenaming({ kind: "file", id: f.id, name: f.name });
                        }}
                        data-testid="rename-file"
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm row-action btn-danger"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDeleteFile(f.id);
                        }}
                        data-testid="delete-file"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        {empty && (
          <p className="empty-state muted" data-testid="no-files">
            This folder is empty. Upload files with the Upload files button above, or drag and
            drop files here.
          </p>
        )}
      </div>
    </div>
  );
}
