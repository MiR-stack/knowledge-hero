"use client";

import type { TrashItem } from "@rag/shared-types";
import type { DriveSelection } from "../../lib/drive-selection";
import { formatDate } from "../../lib/drive-utils";
import { FileTypeIcon, FolderIcon, RestoreIcon, TrashIcon } from "./icons";

interface TrashViewProps {
  items: TrashItem[];
  loading: boolean;
  onRestore: (item: TrashItem) => void;
  onContextMenu: (e: React.MouseEvent, item: DriveSelection) => void;
}

export function TrashView({ items, loading, onRestore, onContextMenu }: TrashViewProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-drive-text-secondary">
        Loading trash…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-drive-text-secondary">
        <TrashIcon size={64} className="mb-4 opacity-30" />
        <p className="text-lg">Trash is empty</p>
        <p className="mt-1 max-w-sm text-center text-sm">
          Items in trash will be permanently deleted after 30 days
        </p>
      </div>
    );
  }

  return (
    <div>
      <p className="mb-4 text-sm text-drive-text-secondary">
        Items in trash will be permanently deleted after 30 days
      </p>
      <div className="overflow-hidden rounded-xl border border-drive-border bg-white">
        <div className="flex items-center border-b border-drive-border bg-drive-bg px-4 py-2 text-xs font-medium text-drive-text-secondary">
          <div className="flex-[2]">Name</div>
          <div className="w-40">Date trashed</div>
          <div className="w-32">Actions</div>
        </div>
        {items.map((item) => {
          const selection: DriveSelection = {
            kind: item.type,
            id: item.id,
            name: item.name,
            accessLevel: "write",
          };

          return (
            <div
              key={`${item.type}-${item.id}`}
              className="drive-list-row"
              onContextMenu={(e) => {
                e.preventDefault();
                onContextMenu(e, selection);
              }}
            >
              <div className="flex flex-[2] items-center gap-3 min-w-0">
                {item.type === "folder" ? (
                  <FolderIcon size={20} />
                ) : (
                  <FileTypeIcon mimeType={null} filename={item.name} size={20} />
                )}
                <span className="truncate text-sm text-drive-text">{item.name}</span>
              </div>
              <div className="w-40 text-sm text-drive-text-secondary">
                {formatDate(item.deletedAt)}
              </div>
              <div className="w-32">
                <button
                  type="button"
                  onClick={() => onRestore(item)}
                  className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm text-drive-blue hover:bg-drive-blue-light"
                >
                  <RestoreIcon size={16} />
                  Restore
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
