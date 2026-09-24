"use client";

import { useState } from "react";
import type { DocumentSummary, FolderSummary } from "@rag/shared-types";
import type { DriveSelection } from "../../lib/drive-selection";
import {
  canWriteItem,
  isItemSelected,
  readDragPayload,
  setDragPayload,
} from "../../lib/drive-selection";
import {
  documentToSelection,
  folderToSelection,
  formatBytes,
  formatDate,
  getFileTypeLabel,
  type SortField,
  type SortOrder,
  type ViewMode,
} from "../../lib/drive-utils";
import { FileTypeIcon, FolderIcon, MoreVertIcon } from "./icons";

const STATUS_LABELS = {
  queued: "Queued",
  extracting: "Processing",
  chunking: "Processing",
  embedding: "Processing",
  indexed: "Ready",
  failed: "Failed",
} as const;

interface FileListProps {
  liveStatuses?: Map<string, { status: string; progressPct: number }>;
  folders: FolderSummary[];
  documents: DocumentSummary[];
  selection: DriveSelection[];
  sortField: SortField;
  sortOrder: SortOrder;
  onSelect: (items: DriveSelection[], multi: boolean) => void;
  onOpenFolder: (folderId: string) => void;
  onMoveItem: (item: DriveSelection, targetFolderId: string) => void;
  onContextMenu: (e: React.MouseEvent, item: DriveSelection) => void;
}

export function FileList({
  liveStatuses,
  folders,
  documents,
  selection,
  sortField,
  sortOrder,
  onSelect,
  onOpenFolder,
  onMoveItem,
  onContextMenu,
}: FileListProps) {
  function handleDropOnFolder(targetFolderId: string) {
    return (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const item = readDragPayload(e);
      if (!item || item.id === targetFolderId) return;
      onMoveItem(item, targetFolderId);
    };
  }

  if (folders.length === 0 && documents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-drive-text-secondary">
        <FolderIcon size={64} className="mb-4 opacity-40" />
        <p className="text-lg">This folder is empty</p>
        <p className="mt-1 text-sm">Drop files here or use the New button to upload</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-drive-border bg-white">
      <div className="flex items-center border-b border-drive-border bg-drive-bg px-4 py-2 text-xs font-medium text-drive-text-secondary">
        <div className="flex-[2] min-w-0">Name</div>
        <div className="w-28 shrink-0">Owner</div>
        <div className="w-32 shrink-0">
          {sortField === "modified" ? "Last modified" : sortField === "size" ? "Size" : "Modified"}
        </div>
        <div className="w-24 shrink-0">File size</div>
        <div className="w-8 shrink-0" />
      </div>

      {folders.map((folder) => {
        const item = folderToSelection(folder);
        const selected = isItemSelected(item, selection);

        return (
          <div
            key={folder.id}
            draggable={canWriteItem(item)}
            onDragStart={(e) => canWriteItem(item) && setDragPayload(e, item)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDropOnFolder(folder.id)}
            onClick={(e) => {
              e.stopPropagation();
              onSelect([item], e.ctrlKey || e.metaKey || e.shiftKey);
            }}
            onDoubleClick={() => onOpenFolder(folder.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              onContextMenu(e, item);
            }}
            className={`drive-list-row ${selected ? "drive-list-row-selected" : ""}`}
          >
            <div className="flex flex-[2] min-w-0 items-center gap-3">
              <FolderIcon size={20} />
              <span className="truncate text-sm text-drive-text">{folder.name}</span>
            </div>
            <div className="w-28 shrink-0 text-sm text-drive-text-secondary">me</div>
            <div className="w-32 shrink-0 text-sm text-drive-text-secondary">
              {formatDate(folder.updatedAt)}
            </div>
            <div className="w-24 shrink-0 text-sm text-drive-text-secondary">—</div>
            <div className="w-8 shrink-0">
              <button
                type="button"
                className="drive-icon-btn h-8 w-8 opacity-0 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onContextMenu(e, item);
                }}
              >
                <MoreVertIcon size={18} />
              </button>
            </div>
          </div>
        );
      })}

      {documents.map((doc) => {
        const item = documentToSelection(doc);
        const selected = isItemSelected(item, selection);

        const liveStatus = liveStatuses?.get(doc.id);
        const currentStatus = (liveStatus?.status ?? doc.processingStatus) as keyof typeof STATUS_LABELS;
        const currentProgress = liveStatus?.progressPct ?? 0;

        return (
          <div
            key={doc.id}
            draggable={canWriteItem(item)}
            onDragStart={(e) => canWriteItem(item) && setDragPayload(e, item)}
            onClick={(e) => {
              e.stopPropagation();
              onSelect([item], e.ctrlKey || e.metaKey || e.shiftKey);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              onContextMenu(e, item);
            }}
            className={`drive-list-row group ${selected ? "drive-list-row-selected" : ""}`}
          >
            <div className="flex flex-[2] min-w-0 items-center gap-3">
              <FileTypeIcon
                mimeType={doc.mimeType}
                filename={doc.originalFilename}
                isBaseDocument={doc.isBaseDocument}
                size={20}
              />
              <div className="min-w-0 flex items-center gap-2">
                <span className="truncate text-sm text-drive-text">{doc.title}</span>
                {currentStatus !== "indexed" && (
                  <span className={`text-xs ${
                    currentStatus === "extracting" || currentStatus === "chunking" || currentStatus === "embedding"
                      ? "text-blue-600 animate-pulse"
                      : currentStatus === "failed" ? "text-red-600" : "text-drive-text-secondary"
                  }`}>
                    {STATUS_LABELS[currentStatus]}
                  </span>
                )}
                {(currentStatus === "extracting" || currentStatus === "chunking" || currentStatus === "embedding") && (
                  <div className="w-16 rounded-full bg-gray-200 h-1 mt-0.5">
                    <div
                      className="h-1 rounded-full bg-blue-500 transition-all duration-500"
                      style={{ width: `${currentProgress}%` }}
                    />
                  </div>
                )}
              </div>
            </div>
            <div className="w-28 shrink-0 text-sm text-drive-text-secondary">me</div>
            <div className="w-32 shrink-0 text-sm text-drive-text-secondary">
              {formatDate(doc.updatedAt)}
            </div>
            <div className="w-24 shrink-0 text-sm text-drive-text-secondary">
              {formatBytes(doc.fileSizeBytes)}
            </div>
            <div className="w-8 shrink-0">
              <button
                type="button"
                className="drive-icon-btn h-8 w-8 opacity-0 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onContextMenu(e, item);
                }}
              >
                <MoreVertIcon size={18} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function FileListHeader({
  viewMode,
  sortField,
  sortOrder,
  onViewModeChange,
  onSortChange,
}: {
  viewMode: ViewMode;
  sortField: SortField;
  sortOrder: SortOrder;
  onViewModeChange: (mode: ViewMode) => void;
  onSortChange: (field: SortField, order: SortOrder) => void;
}) {
  const [sortOpen, setSortOpen] = useState(false);

  return (
    <div className="flex items-center justify-end gap-1 px-2 py-1">
      <div className="relative">
        <button
          type="button"
          onClick={() => setSortOpen((o) => !o)}
          className="drive-icon-btn gap-1 px-3 w-auto rounded-lg text-sm"
          title="Sort"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z" />
          </svg>
        </button>
        {sortOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setSortOpen(false)} />
            <div className="drive-dropdown right-0 top-full z-50 mt-1">
              {(["name", "modified", "size"] as SortField[]).map((field) => (
                <button
                  key={field}
                  type="button"
                  className={`drive-dropdown-item ${sortField === field ? "bg-drive-blue-light text-drive-blue" : ""}`}
                  onClick={() => {
                    onSortChange(field, sortField === field && sortOrder === "asc" ? "desc" : "asc");
                    setSortOpen(false);
                  }}
                >
                  {field === "name" ? "Name" : field === "modified" ? "Last modified" : "File size"}
                  {sortField === field && (sortOrder === "asc" ? " ↑" : " ↓")}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <button
        type="button"
        onClick={() => onViewModeChange(viewMode === "grid" ? "list" : "grid")}
        className="drive-icon-btn"
        title={viewMode === "grid" ? "List view" : "Grid view"}
      >
        {viewMode === "grid" ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 3v8h8V3H3zm6 6H5V5h4v4zm-6 4v8h8v-8H3zm6 6H5v-4h4v4zm4-16v8h8V3h-8zm6 6h-4V5h4v4zm-6 4v8h8v-8h-8zm6 6h-4v-4h4v4z" />
          </svg>
        )}
      </button>
    </div>
  );
}

export { getFileTypeLabel };
