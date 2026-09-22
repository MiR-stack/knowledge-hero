"use client";

import { useEffect, useRef } from "react";
import type { DriveSelection } from "../../lib/drive-selection";
import { canWriteItem } from "../../lib/drive-selection";
import {
  CloseIcon,
  RenameIcon,
  RestoreIcon,
  ShareIcon,
  TrashIcon,
} from "./icons";

export interface ContextMenuAction {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  divider?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  selection: DriveSelection | null;
  isTrash?: boolean;
  onClose: () => void;
  onOpen?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  onRestore?: () => void;
  onShare?: () => void;
  onCut?: () => void;
  onCopy?: () => void;
}

export function ContextMenu({
  x,
  y,
  selection,
  isTrash,
  onClose,
  onOpen,
  onRename,
  onDelete,
  onRestore,
  onShare,
  onCut,
  onCopy,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      el.style.left = `${x - rect.width}px`;
    }
    if (rect.bottom > window.innerHeight) {
      el.style.top = `${y - rect.height}px`;
    }
  }, [x, y]);

  const canWrite = canWriteItem(selection);
  const isFolder = selection?.kind === "folder";

  const actions: ContextMenuAction[] = isTrash
    ? [
        {
          label: "Restore",
          icon: <RestoreIcon size={18} />,
          onClick: () => {
            onRestore?.();
            onClose();
          },
        },
        {
          label: "Delete forever",
          icon: <TrashIcon size={18} />,
          onClick: () => {
            onDelete?.();
            onClose();
          },
          danger: true,
          disabled: true,
        },
      ]
    : [
        ...(isFolder
          ? [
              {
                label: "Open",
                onClick: () => {
                  onOpen?.();
                  onClose();
                },
              },
            ]
          : []),
        {
          label: "Rename",
          icon: <RenameIcon size={18} />,
          onClick: () => {
            onRename?.();
            onClose();
          },
          disabled: !canWrite,
        },
        { label: "", onClick: () => {}, divider: true },
        {
          label: "Share",
          icon: <ShareIcon size={18} />,
          onClick: () => {
            onShare?.();
            onClose();
          },
          disabled: !canWrite,
        },
        { label: "", onClick: () => {}, divider: true },
        {
          label: "Cut",
          onClick: () => {
            onCut?.();
            onClose();
          },
          disabled: !canWrite,
        },
        {
          label: "Copy",
          onClick: () => {
            onCopy?.();
            onClose();
          },
        },
        { label: "", onClick: () => {}, divider: true },
        {
          label: "Move to trash",
          icon: <TrashIcon size={18} />,
          onClick: () => {
            onDelete?.();
            onClose();
          },
          disabled: !canWrite,
          danger: true,
        },
      ];

  return (
    <div
      ref={ref}
      className="drive-context-menu"
      style={{ left: x, top: y }}
      role="menu"
    >
      {selection && (
        <div className="border-b border-drive-border px-4 py-2 text-xs font-medium text-drive-text-secondary truncate max-w-[200px]">
          {selection.name}
        </div>
      )}
      {actions.map((action, i) =>
        action.divider ? (
          <div key={i} className="my-1 border-t border-drive-border" />
        ) : (
          <button
            key={action.label}
            type="button"
            role="menuitem"
            disabled={action.disabled}
            onClick={action.onClick}
            className={`drive-context-item ${action.danger ? "drive-context-item-danger" : ""}`}
          >
            {action.icon}
            {action.label}
          </button>
        ),
      )}
    </div>
  );
}

export function SelectionBar({
  count,
  onClear,
  onRename,
  onDelete,
  onShare,
  onCut,
  onCopy,
  canWrite,
  isFolder,
}: {
  count: number;
  onClear: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  onShare?: () => void;
  onCut?: () => void;
  onCopy?: () => void;
  canWrite: boolean;
  isFolder?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-drive-border bg-drive-blue-light px-4 py-2">
      <button type="button" onClick={onClear} className="drive-icon-btn" aria-label="Clear selection">
        <CloseIcon size={20} />
      </button>
      <span className="text-sm font-medium text-drive-text">
        {count} selected
      </span>
      <div className="ml-4 flex items-center gap-1">
        {count === 1 && canWrite && (
          <button type="button" onClick={onRename} className="drive-icon-btn" title="Rename">
            <RenameIcon size={18} />
          </button>
        )}
        {canWrite && (
          <button type="button" onClick={onCut} className="drive-icon-btn" title="Move">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z" />
            </svg>
          </button>
        )}
        <button type="button" onClick={onCopy} className="drive-icon-btn" title="Copy">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
          </svg>
        </button>
        {count === 1 && canWrite && (
          <button type="button" onClick={onShare} className="drive-icon-btn" title="Share">
            <ShareIcon size={18} />
          </button>
        )}
        {canWrite && (
          <button
            type="button"
            onClick={onDelete}
            className="drive-icon-btn text-red-600 hover:bg-red-50"
            title="Move to trash"
          >
            <TrashIcon size={18} />
          </button>
        )}
      </div>
    </div>
  );
}
