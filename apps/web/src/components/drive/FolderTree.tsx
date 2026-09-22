"use client";

import { useState } from "react";
import type { FolderTreeNode } from "@rag/shared-types";
import { readDragPayload, type DriveSelection } from "../../lib/drive-selection";
import { ChevronRightIcon, FolderIcon } from "./icons";

interface FolderTreeProps {
  tree: FolderTreeNode[];
  currentFolderId: string | null;
  onNavigate: (folderId: string) => void;
  onDropItem: (targetFolderId: string, item: DriveSelection) => void;
}

function TreeNode({
  node,
  currentFolderId,
  onNavigate,
  onDropItem,
  depth,
}: {
  node: FolderTreeNode;
  currentFolderId: string | null;
  onNavigate: (folderId: string) => void;
  onDropItem: (targetFolderId: string, item: DriveSelection) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const [dragOver, setDragOver] = useState(false);
  const isActive = node.id === currentFolderId;
  const hasChildren = node.children.length > 0;

  return (
    <li>
      <div
        className="flex items-center"
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="drive-icon-btn h-6 w-6 shrink-0"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            <ChevronRightIcon
              size={16}
              className={`transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          </button>
        ) : (
          <span className="w-6 shrink-0" />
        )}

        <button
          type="button"
          onClick={() => onNavigate(node.id)}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOver(false);
            const item = readDragPayload(e);
            if (!item || item.id === node.id) return;
            onDropItem(node.id, item);
          }}
          className={`flex min-w-0 flex-1 items-center gap-2 rounded-full py-1.5 pr-3 text-left text-sm transition-colors ${
            dragOver
              ? "bg-drive-blue-light ring-1 ring-drive-blue"
              : isActive
                ? "bg-drive-blue-light font-medium text-drive-blue"
                : "text-drive-text hover:bg-drive-hover"
          }`}
        >
          <FolderIcon size={18} />
          <span className="truncate">{node.name}</span>
        </button>
      </div>

      {hasChildren && expanded && (
        <ul>
          {node.children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              currentFolderId={currentFolderId}
              onNavigate={onNavigate}
              onDropItem={onDropItem}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function FolderTree({ tree, currentFolderId, onNavigate, onDropItem }: FolderTreeProps) {
  if (tree.length === 0) return null;

  return (
    <nav aria-label="Folder tree" className="mt-2 max-h-[40vh] overflow-y-auto px-1">
      <ul className="space-y-0.5">
        {tree.map((node) => (
          <TreeNode
            key={node.id}
            node={node}
            currentFolderId={currentFolderId}
            onNavigate={onNavigate}
            onDropItem={onDropItem}
            depth={0}
          />
        ))}
      </ul>
    </nav>
  );
}
