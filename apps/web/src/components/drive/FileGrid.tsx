"use client";

import type { DocumentSummary, FolderSummary } from "@rag/shared-types";
import type { DriveSelection } from "../../lib/drive-selection";
import {
  canWriteItem,
  isItemSelected,
  readDragPayload,
  setDragPayload,
} from "../../lib/drive-selection";
import { documentToSelection, folderToSelection, formatBytes } from "../../lib/drive-utils";
import { FileTypeIcon, FolderIcon } from "./icons";

const STATUS_LABELS = {
  queued: "Queued",
  extracting: "Processing",
  chunking: "Processing",
  embedding: "Processing",
  indexed: "Ready",
  failed: "Failed",
} as const;

const STATUS_COLORS = {
  queued: "bg-gray-100 text-gray-600",
  extracting: "bg-amber-50 text-amber-700",
  chunking: "bg-amber-50 text-amber-700",
  embedding: "bg-blue-50 text-blue-700",
  indexed: "bg-green-50 text-green-700",
  failed: "bg-red-50 text-red-700",
} as const;

interface FileGridProps {
  liveStatuses?: Map<string, { status: string; progressPct: number }>;
  folders: FolderSummary[];
  documents: DocumentSummary[];
  selection: DriveSelection[];
  onSelect: (items: DriveSelection[], multi: boolean) => void;
  onOpenFolder: (folderId: string) => void;
  onMoveItem: (item: DriveSelection, targetFolderId: string) => void;
  onContextMenu: (e: React.MouseEvent, item: DriveSelection) => void;
  /** Called when a document card is double-clicked — open preview modal */
  onPreview?: (item: DriveSelection) => void;
}

export function FileGrid({
  liveStatuses,
  folders,
  documents,
  selection,
  onSelect,
  onOpenFolder,
  onMoveItem,
  onContextMenu,
  onPreview,
}: FileGridProps) {
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
      <div
        className="flex flex-col items-center justify-center py-24 text-drive-text-secondary"
        onClick={() => onSelect([], false)}
      >
        <FolderIcon size={64} className="mb-4 opacity-40" />
        <p className="text-lg">This folder is empty</p>
        <p className="mt-1 text-sm">Drop files here or use the New button to upload</p>
      </div>
    );
  }

  return (
    <div
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
      onClick={() => onSelect([], false)}
    >
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
            onDoubleClick={(e) => {
              e.stopPropagation();
              onOpenFolder(folder.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onContextMenu(e, item);
            }}
            className={`drive-card group ${selected ? "drive-card-selected" : ""}`}
          >
            <div className="flex flex-col items-center text-center">
              <FolderIcon size={48} className="mb-2" />
              <span className="line-clamp-2 w-full text-sm text-drive-text">{folder.name}</span>
              {folder.accessLevel === "read" && (
                <span className="mt-1 text-xs text-drive-text-secondary">View only</span>
              )}
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
            onDoubleClick={(e) => {
              e.stopPropagation();
              onPreview?.(item);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onContextMenu(e, item);
            }}
            className={`drive-card group ${selected ? "drive-card-selected" : ""}`}
          >
            <div className="flex flex-col items-center text-center">
              <FileTypeIcon
                mimeType={doc.mimeType}
                filename={doc.originalFilename}
                isBaseDocument={doc.isBaseDocument}
                size={48}
                className="mb-2"
              />
              <span className="line-clamp-2 w-full text-sm text-drive-text">{doc.title}</span>
              <span className="mt-0.5 text-xs text-drive-text-secondary">
                {formatBytes(doc.fileSizeBytes)}
              </span>
              {currentStatus !== "indexed" && (
                <span
                  className={`mt-1.5 inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    STATUS_COLORS[currentStatus]
                  } ${
                    currentStatus === "extracting" || currentStatus === "chunking" || currentStatus === "embedding"
                      ? "animate-pulse"
                      : ""
                  }`}
                >
                  {STATUS_LABELS[currentStatus]}
                </span>
              )}
              {(currentStatus === "extracting" || currentStatus === "chunking" || currentStatus === "embedding") && (
                <div className="mt-1 w-full rounded-full bg-gray-200 h-1">
                  <div
                    className="h-1 rounded-full bg-blue-500 transition-all duration-500"
                    style={{ width: `${currentProgress}%` }}
                  />
                </div>
              )}
              {doc.isBaseDocument && (
                <span className="mt-1 text-[10px] font-medium text-purple-600">Base Document</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
