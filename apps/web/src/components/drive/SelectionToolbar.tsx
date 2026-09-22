"use client";

import type { DriveSelection } from "../../lib/drive-selection";
import { canWriteItem } from "../../lib/drive-selection";

interface SelectionToolbarProps {
  selection: DriveSelection | null;
  clipboardCount: number;
  clipboardMode: "copy" | "cut" | null;
  isRenaming: boolean;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  onStartRename: () => void;
  onDelete: () => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  canPasteHere: boolean;
}

export function SelectionToolbar({
  selection,
  clipboardCount,
  clipboardMode,
  isRenaming,
  renameValue,
  onRenameValueChange,
  onRenameSubmit,
  onRenameCancel,
  onStartRename,
  onDelete,
  onCut,
  onCopy,
  onPaste,
  canPasteHere,
}: SelectionToolbarProps) {
  const canWrite = canWriteItem(selection);
  const hasClipboard = clipboardCount > 0;

  if (!selection && !hasClipboard) {
    return (
      <div className="mb-4 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-500">
        Select a file or folder to see actions. Shortcuts: Ctrl+C copy, Ctrl+X cut, Ctrl+V paste, F2
        rename, Delete to trash.
      </div>
    );
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-3">
      {selection && (
        <span className="mr-2 text-sm font-medium text-gray-900">
          {selection.kind === "folder" ? "📁" : "📄"} {selection.name}
        </span>
      )}

      {isRenaming && selection ? (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => onRenameValueChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onRenameSubmit();
              if (e.key === "Escape") onRenameCancel();
            }}
            className="rounded-md border border-gray-300 px-2 py-1 text-sm"
          />
          <button
            type="button"
            onClick={onRenameSubmit}
            disabled={!canWrite}
            className="rounded-md bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={onRenameCancel}
            className="rounded-md px-3 py-1 text-sm text-gray-600 hover:bg-gray-100"
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          {selection && canWrite && (
            <>
              <ToolbarButton label="Rename" shortcut="F2" onClick={onStartRename} />
              <ToolbarButton label="Delete" shortcut="Del" onClick={onDelete} variant="danger" />
              <span className="mx-1 h-5 w-px bg-gray-200" />
              <ToolbarButton label="Cut" shortcut="Ctrl+X" onClick={onCut} />
            </>
          )}
          {selection && (
            <ToolbarButton label="Copy" shortcut="Ctrl+C" onClick={onCopy} />
          )}
          {selection && !canWrite && (
            <span className="text-sm text-amber-700">Read-only — rename, delete, and cut are disabled</span>
          )}
        </>
      )}

      {hasClipboard && (
        <>
          <span className="mx-1 h-5 w-px bg-gray-200" />
          <span className="text-xs text-gray-500">
            {clipboardCount} item{clipboardCount > 1 ? "s" : ""} ({clipboardMode})
          </span>
          <ToolbarButton
            label="Paste"
            shortcut="Ctrl+V"
            onClick={onPaste}
            disabled={!canPasteHere}
          />
        </>
      )}
    </div>
  );
}

function ToolbarButton({
  label,
  shortcut,
  onClick,
  disabled,
  variant = "default",
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "danger";
}) {
  const base =
    variant === "danger"
      ? "text-red-700 hover:bg-red-50 border-red-200"
      : "text-gray-700 hover:bg-gray-100 border-gray-200";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${base}`}
    >
      {label}
      {shortcut && <span className="ml-1 text-xs text-gray-400">({shortcut})</span>}
    </button>
  );
}
