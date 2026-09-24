"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  AccessLevel,
  DocumentSummary,
  DriveListResponse,
  FolderTreeNode,
  TrashItem,
} from "@rag/shared-types";
import { useAuth } from "../../lib/auth";
import {
  createFolder,
  copyDocument,
  deleteDocument,
  deleteFolder,
  fetchFolderContents,
  fetchFolderTree,
  fetchTrash,
  moveDocument,
  moveFolder,
  renameDocument,
  renameFolder,
  restoreDocument,
  restoreFolder,
  searchDocuments,
  uploadDocument,
} from "../../lib/api";
import type { DriveClipboard, DriveSelection } from "../../lib/drive-selection";
import {
  canWriteAll,
  canWriteItem,
  toggleSelection,
} from "../../lib/drive-selection";
import {
  type DriveSection,
  type SortField,
  type SortOrder,
  sortDocuments,
  sortFolders,
  type ViewMode,
} from "../../lib/drive-utils";
import { useDriveKeyboard } from "../../lib/useDriveKeyboard";
import { Breadcrumbs } from "./Breadcrumbs";
import { ContextMenu, SelectionBar } from "./ContextMenu";
import { DocumentPreviewModal } from "./DocumentPreviewModal";
import { DriveSidebar } from "./DriveSidebar";
import { DriveTopBar } from "./DriveTopBar";
import { FileGrid } from "./FileGrid";
import { WorkspaceStatusProvider } from "./WorkspaceStatusProvider";
import { FileList, FileListHeader } from "./FileList";
import { ShareModal, type ShareTarget } from "./ShareModal";
import { ToastProvider, useToast } from "./Toast";
import { TrashView } from "./TrashView";
import { UploadPanel } from "./UploadPanel";

function DriveViewInner() {
  const auth = useAuth();
  const router = useRouter();
  const { showToast } = useToast();
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const [section, setSection] = useState<DriveSection>("my-drive");
  const [tree, setTree] = useState<FolderTreeNode[]>([]);
  const [contents, setContents] = useState<DriveListResponse | null>(null);
  const [trashItems, setTrashItems] = useState<TrashItem[]>([]);
  const [searchResults, setSearchResults] = useState<DocumentSummary[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [currentFolderAccess, setCurrentFolderAccess] = useState<AccessLevel>("write");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Map from documentId → live status from SSE/WS
  const [liveStatuses, setLiveStatuses] = useState<Map<string, { status: string; progressPct: number }>>(new Map());

  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearch, setActiveSearch] = useState("");

  const [selection, setSelection] = useState<DriveSelection[]>([]);
  const [clipboard, setClipboard] = useState<DriveClipboard | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: DriveSelection;
  } | null>(null);
  const [dragOverMain, setDragOverMain] = useState(false);
  const [previewDocument, setPreviewDocument] = useState<DocumentSummary | null>(null);


  const loadDrive = useCallback(
    async (folderId?: string, keepSelection = false) => {
      if (!auth.token || !auth.workspaceId) return;
      setLoading(true);
      setError(null);
      if (!keepSelection) {
        setSelection([]);
        setIsRenaming(false);
      }
      try {
        const [treeRes, folderRes] = await Promise.all([
          fetchFolderTree(auth.token, auth.workspaceId),
          fetchFolderContents(auth.token, auth.workspaceId, folderId),
        ]);
        setTree(treeRes.tree);
        setContents(folderRes);
        setCurrentFolderId(folderRes.folder?.id ?? null);
        setCurrentFolderAccess(folderRes.folder?.accessLevel ?? "write");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load drive");
      } finally {
        setLoading(false);
      }
    },
    [auth.token, auth.workspaceId],
  );

  const loadTrash = useCallback(async () => {
    if (!auth.token || !auth.workspaceId) return;
    setLoading(true);
    setError(null);
    setSelection([]);
    try {
      const res = await fetchTrash(auth.token, auth.workspaceId);
      setTrashItems(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load trash");
    } finally {
      setLoading(false);
    }
  }, [auth.token, auth.workspaceId]);

  const runSearch = useCallback(
    async (q: string) => {
      if (!auth.token || !auth.workspaceId || !q.trim()) return;
      setLoading(true);
      setError(null);
      setSelection([]);
      setSection("search");
      setActiveSearch(q.trim());
      try {
        const res = await searchDocuments(auth.token, auth.workspaceId, q.trim());
        setSearchResults(res.documents);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Search failed");
      } finally {
        setLoading(false);
      }
    },
    [auth.token, auth.workspaceId],
  );

  useEffect(() => {
    if (!auth.isReady) return;
    if (!auth.token) {
      router.replace("/login");
      return;
    }
    if (section === "trash") void loadTrash();
    else if (section === "search" && activeSearch) void runSearch(activeSearch);
    else void loadDrive();
  }, [auth.isReady, auth.token, router, section]); // eslint-disable-line react-hooks/exhaustive-deps

  async function navigateTo(folderId: string) {
    setSection("my-drive");
    setSelection([]);
    setIsRenaming(false);
    setActiveSearch("");
    await loadDrive(folderId);
  }

  function handleSectionChange(next: DriveSection) {
    setSection(next);
    setSelection([]);
    setContextMenu(null);
    setActiveSearch("");
    setSearchQuery("");
    if (next === "trash") void loadTrash();
    else if (next === "my-drive") void loadDrive(currentFolderId ?? undefined);
  }

  function handleSelect(items: DriveSelection[], multi: boolean) {
    if (items.length === 0) {
      setSelection([]);
      return;
    }
    if (multi && items.length === 1) {
      setSelection((prev) => toggleSelection(items[0], prev, true));
    } else {
      setSelection(items);
    }
  }

  function handleContextMenu(e: React.MouseEvent, item: DriveSelection) {
    if (!isItemInSelection(item)) setSelection([item]);
    setContextMenu({ x: e.clientX, y: e.clientY, item });
  }

  function isItemInSelection(item: DriveSelection) {
    return selection.some((s) => s.kind === item.kind && s.id === item.id);
  }

  const primarySelection = selection.length === 1 ? selection[0] : null;

  async function handleCreateFolder() {
    if (!newFolderName.trim() || !currentFolderId || !auth.token) return;
    if (currentFolderAccess !== "write") {
      showToast("You do not have permission to create folders here", "error");
      return;
    }
    await createFolder(auth.token, auth.workspaceId, newFolderName.trim(), currentFolderId);
    setNewFolderName("");
    setShowNewFolder(false);
    showToast("Folder created", "success");
    await loadDrive(currentFolderId);
  }

  async function handleUpload(
    files: File[],
    options: { isBaseDocument: boolean; baseDocCategory: string },
  ) {
    if (!currentFolderId || !auth.token) return;
    for (const file of files) {
      const result = await uploadDocument(auth.token, auth.workspaceId, currentFolderId, file, options);
      setLiveStatuses(prev => new Map(prev).set(result.documentId, { status: 'queued', progressPct: 0 }));
    }
    showToast(`${files.length} file${files.length > 1 ? "s" : ""} uploaded`, "success");
    await loadDrive(currentFolderId);
  }

  async function handleMove(item: DriveSelection, targetFolderId: string) {
    if (!auth.token || !canWriteItem(item)) {
      showToast("You do not have permission to move this item", "error");
      return;
    }
    if (item.kind === "folder") {
      if (item.id === targetFolderId) return;
      await moveFolder(auth.token, auth.workspaceId, item.id, targetFolderId);
    } else {
      await moveDocument(auth.token, auth.workspaceId, item.id, targetFolderId);
    }
    setSelection((prev) => prev.filter((s) => !(s.kind === item.kind && s.id === item.id)));
    showToast(`Moved "${item.name}"`, "success");
    await loadDrive(currentFolderId ?? undefined, true);
  }

  async function handleDeleteSelected() {
    const writable = selection.filter(canWriteItem);
    if (!writable.length || !auth.token) return;
    const label =
      writable.length === 1
        ? `"${writable[0].name}"`
        : `${writable.length} items`;
    if (!confirm(`Move ${label} to trash?`)) return;

    for (const item of writable) {
      if (item.kind === "folder") {
        await deleteFolder(auth.token, auth.workspaceId, item.id);
      } else {
        await deleteDocument(auth.token, auth.workspaceId, item.id);
      }
    }
    setSelection([]);
    showToast("Moved to trash", "success");
    if (section === "my-drive") await loadDrive(currentFolderId ?? undefined);
  }

  async function handleRenameSubmit() {
    if (!primarySelection || !auth.token || !canWriteItem(primarySelection) || !renameValue.trim())
      return;

    if (primarySelection.kind === "folder") {
      await renameFolder(auth.token, auth.workspaceId, primarySelection.id, renameValue.trim());
    } else {
      await renameDocument(auth.token, auth.workspaceId, primarySelection.id, renameValue.trim());
    }
    setIsRenaming(false);
    setSelection([]);
    showToast("Renamed", "success");
    await loadDrive(currentFolderId ?? undefined);
  }

  function handleCopy() {
    if (!selection.length) return;
    setClipboard({ items: selection, mode: "copy" });
    showToast(`Copied ${selection.length} item${selection.length > 1 ? "s" : ""}`);
  }

  function handleCut() {
    const writable = selection.filter(canWriteItem);
    if (!writable.length) return;
    setClipboard({ items: writable, mode: "cut" });
    showToast(`Cut ${writable.length} item${writable.length > 1 ? "s" : ""} — paste to move`);
  }

  async function handlePaste() {
    if (!clipboard?.items.length || !currentFolderId || !auth.token) return;
    if (currentFolderAccess !== "write") {
      showToast("You do not have permission to paste into this folder", "error");
      return;
    }

    if (clipboard.mode === "copy") {
      showToast("Copy-paste duplication is not yet supported. Use Cut to move items.");
      return;
    }

    for (const item of clipboard.items) {
      if (!canWriteItem(item)) continue;
      if (item.kind === "folder" && item.id === currentFolderId) continue;
      try {
        await handleMove(item, currentFolderId);
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Move failed", "error");
      }
    }
    setClipboard(null);
    showToast("Items moved", "success");
    await loadDrive(currentFolderId);
  }

  async function handleCopyToCurrentFolder(item: DriveSelection) {
    if (!auth.token || !currentFolderId || item.kind !== "document") return;
    if (currentFolderAccess !== "write") {
      showToast("You do not have permission to copy into this folder", "error");
      return;
    }
    try {
      await copyDocument(auth.token, auth.workspaceId, item.id, currentFolderId);
      showToast(`Copy of "${item.name}" is processing`, "success");
      await loadDrive(currentFolderId);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Copy failed", "error");
    }
  }

  function handlePreviewDocument(item: DriveSelection) {
    if (item.kind !== "document") return;
    // Find the full DocumentSummary from the current view
    const doc =
      contents?.documents.find((d) => d.id === item.id) ??
      searchResults.find((d) => d.id === item.id) ??
      null;
    if (doc) setPreviewDocument(doc);
  }


  function openShare(item: DriveSelection) {
    const folderId =
      item.kind === "folder" ? item.id : item.parentId ?? currentFolderId;
    if (!folderId) {
      showToast("Cannot share — no parent folder found", "error");
      return;
    }
    setShareTarget({
      kind: item.kind,
      id: item.id,
      name: item.name,
      folderId,
    });
  }

  async function handleRestore(item: TrashItem) {
    if (!auth.token) return;
    try {
      if (item.type === "folder") {
        await restoreFolder(auth.token, auth.workspaceId, item.id);
      } else {
        await restoreDocument(auth.token, auth.workspaceId, item.id);
      }
      showToast(`Restored "${item.name}"`, "success");
      await loadTrash();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Restore failed", "error");
    }
  }

  useDriveKeyboard({
    hasSelection: selection.length > 0,
    canCut: canWriteAll(selection),
    canPaste: Boolean(clipboard?.items.length && currentFolderAccess === "write"),
    onCopy: handleCopy,
    onCut: handleCut,
    onPaste: () => void handlePaste(),
    onDelete: () => void handleDeleteSelected(),
    onRename: () => {
      if (primarySelection && canWriteItem(primarySelection)) {
        setRenameValue(primarySelection.name);
        setIsRenaming(true);
      }
    },
  });

  if (!auth.token) return null;

  const sortedFolders = sortFolders(contents?.folders ?? [], sortField, sortOrder);
  const sortedDocuments = sortDocuments(contents?.documents ?? [], sortField, sortOrder);
  const canPasteHere = Boolean(
    clipboard?.items.length && currentFolderAccess === "write" && clipboard.mode === "cut",
  );

  const pageTitle =
    section === "trash"
      ? "Trash"
      : section === "search"
        ? `Search results for "${activeSearch}"`
        : (contents?.folder?.name ?? "My Drive");

  return (
    <WorkspaceStatusProvider workspaceId={auth.workspaceId ?? null} token={auth.token ?? null}>
      <div className="flex h-screen flex-col bg-white">
        <DriveTopBar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
        onSearchSubmit={() => void runSearch(searchQuery)}
      />

      {previewDocument && (
        <DocumentPreviewModal
          document={previewDocument}
          onClose={() => setPreviewDocument(null)}
        />
      )}

      {shareTarget && (
        <ShareModal
          token={auth.token}
          workspaceId={auth.workspaceId}
          target={shareTarget}
          onClose={() => setShareTarget(null)}
        />
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          selection={contextMenu.item}
          isTrash={section === "trash"}
          onClose={() => setContextMenu(null)}
          onOpen={() => {
            if (contextMenu.item.kind === "folder") void navigateTo(contextMenu.item.id);
          }}
          onRename={() => {
            setRenameValue(contextMenu.item.name);
            setIsRenaming(true);
          }}
          onDelete={() => {
            if (section === "trash") return;
            void handleDeleteSelected();
          }}
          onRestore={() => {
            const trashItem = trashItems.find(
              (t) => t.id === contextMenu.item.id && t.type === contextMenu.item.kind,
            );
            if (trashItem) void handleRestore(trashItem);
          }}
          onShare={() => openShare(contextMenu.item)}
          onCut={handleCut}
          onCopy={handleCopy}
        />
      )}

      <div className="flex flex-1 overflow-hidden">
        <DriveSidebar
          section={section}
          tree={tree}
          currentFolderId={currentFolderId}
          onSectionChange={handleSectionChange}
          onNavigate={(id) => void navigateTo(id)}
          onDropItem={(targetId, item) => void handleMove(item, targetId)}
          onNewFolder={() => setShowNewFolder(true)}
          onUpload={() => uploadInputRef.current?.click()}
          canWrite={section === "my-drive" && currentFolderAccess === "write"}
        />

        <main
          className={`flex flex-1 flex-col overflow-hidden bg-white ${dragOverMain ? "ring-2 ring-inset ring-drive-blue" : ""}`}
          onDragOver={(e) => {
            if (section === "my-drive" && currentFolderAccess === "write") {
              e.preventDefault();
              setDragOverMain(true);
            }
          }}
          onDragLeave={() => setDragOverMain(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOverMain(false);
            if (section !== "my-drive" || !currentFolderId) return;
            const files = Array.from(e.dataTransfer.files);
            if (files.length) void handleUpload(files, { isBaseDocument: false, baseDocCategory: "" });
          }}
          onClick={() => {
            setSelection([]);
            setContextMenu(null);
          }}
        >
          {selection.length > 0 && section !== "trash" && (
            <SelectionBar
              count={selection.length}
              onClear={() => setSelection([])}
              onRename={() => {
                if (primarySelection) {
                  setRenameValue(primarySelection.name);
                  setIsRenaming(true);
                }
              }}
              onDelete={() => void handleDeleteSelected()}
              onShare={() => {
                if (primarySelection) openShare(primarySelection);
              }}
              onCut={handleCut}
              onCopy={handleCopy}
              canWrite={canWriteAll(selection)}
              isFolder={primarySelection?.kind === "folder"}
            />
          )}

          <div className="flex-1 overflow-y-auto px-6 py-4">
            {error && (
              <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
            )}

            <div className="mb-4 flex items-center justify-between">
              <div>
                {section === "my-drive" && contents?.folder && (
                  <Breadcrumbs
                    items={contents.folder.breadcrumbs}
                    onNavigate={(id) => void navigateTo(id)}
                  />
                )}
                <h1 className="mt-1 text-2xl font-normal text-drive-text">{pageTitle}</h1>
              </div>

              {section === "my-drive" && (
                <FileListHeader
                  viewMode={viewMode}
                  sortField={sortField}
                  sortOrder={sortOrder}
                  onViewModeChange={setViewMode}
                  onSortChange={(field, order) => {
                    setSortField(field);
                    setSortOrder(order);
                  }}
                />
              )}
            </div>

            {isRenaming && primarySelection && (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-drive-border bg-drive-bg p-3">
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleRenameSubmit();
                    if (e.key === "Escape") {
                      setIsRenaming(false);
                      setRenameValue("");
                    }
                  }}
                  className="flex-1 rounded-lg border border-drive-border px-3 py-2 text-sm focus:border-drive-blue focus:outline-none focus:ring-1 focus:ring-drive-blue"
                />
                <button
                  type="button"
                  onClick={() => void handleRenameSubmit()}
                  className="drive-btn-primary py-2"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsRenaming(false);
                    setRenameValue("");
                  }}
                  className="drive-btn-secondary py-2"
                >
                  Cancel
                </button>
              </div>
            )}

            {showNewFolder && (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-drive-border bg-drive-bg p-3">
                <input
                  autoFocus
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="Untitled folder"
                  className="flex-1 rounded-lg border border-drive-border px-3 py-2 text-sm focus:border-drive-blue focus:outline-none focus:ring-1 focus:ring-drive-blue"
                  onKeyDown={(e) => e.key === "Enter" && void handleCreateFolder()}
                />
                <button
                  type="button"
                  onClick={() => void handleCreateFolder()}
                  className="drive-btn-primary py-2"
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowNewFolder(false);
                    setNewFolderName("");
                  }}
                  className="drive-btn-secondary py-2"
                >
                  Cancel
                </button>
              </div>
            )}

            {canPasteHere && (
              <div className="mb-4 rounded-lg bg-drive-blue-light px-4 py-2 text-sm text-drive-blue">
                {clipboard!.items.length} item{clipboard!.items.length > 1 ? "s" : ""} ready to paste —{" "}
                <button type="button" className="font-medium underline" onClick={() => void handlePaste()}>
                  Paste here
                </button>{" "}
                or press Ctrl+V
              </div>
            )}

            <UploadPanel
              ref={uploadInputRef}
              role={auth.role}
              onUpload={handleUpload}
              hidden
              disabled={!currentFolderId || loading || currentFolderAccess !== "write"}
            />

            {loading ? (
              <div className="flex items-center justify-center py-24 text-drive-text-secondary">
                Loading…
              </div>
            ) : section === "trash" ? (
              <TrashView
                items={trashItems}
                loading={false}
                onRestore={(item) => void handleRestore(item)}
                onContextMenu={handleContextMenu}
              />
            ) : section === "search" ? (
              searchResults.length === 0 ? (
                <div className="py-24 text-center text-drive-text-secondary">
                  No results for &ldquo;{activeSearch}&rdquo;
                </div>
              ) : (
                <FileGrid
                  liveStatuses={liveStatuses}
                  folders={[]}
                  documents={searchResults}
                  selection={selection}
                  onSelect={handleSelect}
                  onOpenFolder={(id) => void navigateTo(id)}
                  onMoveItem={(item, targetId) => void handleMove(item, targetId)}
                  onContextMenu={handleContextMenu}
                  onPreview={handlePreviewDocument}
                />
              )
            ) : viewMode === "list" ? (
              <FileList
                liveStatuses={liveStatuses}
                folders={sortedFolders}
                documents={sortedDocuments}
                selection={selection}
                sortField={sortField}
                sortOrder={sortOrder}
                onSelect={handleSelect}
                onOpenFolder={(id) => void navigateTo(id)}
                onMoveItem={(item, targetId) => void handleMove(item, targetId)}
                onContextMenu={handleContextMenu}
              />
            ) : (
              <FileGrid
                liveStatuses={liveStatuses}
                folders={sortedFolders}
                documents={sortedDocuments}
                selection={selection}
                onSelect={handleSelect}
                onOpenFolder={(id) => void navigateTo(id)}
                onMoveItem={(item, targetId) => void handleMove(item, targetId)}
                onContextMenu={handleContextMenu}
                onPreview={handlePreviewDocument}
              />
            )}
          </div>
        </main>
      </div>
    </div>
    </WorkspaceStatusProvider>
  );
}

export function DriveView() {
  return (
    <ToastProvider>
      <DriveViewInner />
    </ToastProvider>
  );
}
