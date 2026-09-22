"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import type { FolderTreeNode } from "@rag/shared-types";
import type { DriveSection } from "../../lib/drive-utils";
import type { DriveSelection } from "../../lib/drive-selection";
import { FolderTree } from "./FolderTree";
import {
  DriveLogo,
  MyDriveIcon,
  NewFolderIcon,
  PlusIcon,
  SharedIcon,
  TrashIcon,
  UploadIcon,
} from "./icons";

interface DriveSidebarProps {
  section: DriveSection;
  tree: FolderTreeNode[];
  currentFolderId: string | null;
  onSectionChange: (section: DriveSection) => void;
  onNavigate: (folderId: string) => void;
  onDropItem: (targetFolderId: string, item: DriveSelection) => void;
  onNewFolder: () => void;
  onUpload: () => void;
  canWrite: boolean;
  storageUsed?: string;
}

export function DriveSidebar({
  section,
  tree,
  currentFolderId,
  onSectionChange,
  onNavigate,
  onDropItem,
  onNewFolder,
  onUpload,
  canWrite,
  storageUsed = "—",
}: DriveSidebarProps) {
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const newBtnRef = useRef<HTMLDivElement>(null);

  return (
    <aside className="flex w-[256px] shrink-0 flex-col bg-drive-sidebar px-3 py-4">
      <div className="mb-6 flex items-center gap-2 px-3">
        <DriveLogo size={28} />
        <span className="text-xl text-drive-text-secondary font-normal">Drive</span>
      </div>

      <div className="relative mb-4" ref={newBtnRef}>
        <button
          type="button"
          disabled={!canWrite}
          onClick={() => setNewMenuOpen((o) => !o)}
          className="drive-btn-primary w-auto shadow-md disabled:opacity-50"
        >
          <PlusIcon size={20} />
          New
        </button>

        {newMenuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setNewMenuOpen(false)} />
            <div className="drive-dropdown left-0 top-full z-50 mt-1">
              <button
                type="button"
                className="drive-dropdown-item"
                onClick={() => {
                  onNewFolder();
                  setNewMenuOpen(false);
                }}
              >
                <NewFolderIcon size={20} className="text-drive-text-secondary" />
                New folder
              </button>
              <button
                type="button"
                className="drive-dropdown-item"
                onClick={() => {
                  onUpload();
                  setNewMenuOpen(false);
                }}
              >
                <UploadIcon size={20} className="text-drive-text-secondary" />
                File upload
              </button>
            </div>
          </>
        )}
      </div>

      <nav className="flex flex-col gap-0.5">
        <SidebarItem
          icon={<MyDriveIcon size={20} />}
          label="My Drive"
          active={section === "my-drive"}
          onClick={() => onSectionChange("my-drive")}
        />
        {section === "my-drive" && tree.length > 0 && (
          <FolderTree
            tree={tree}
            currentFolderId={currentFolderId}
            onNavigate={onNavigate}
            onDropItem={onDropItem}
          />
        )}
        <SidebarItem
          icon={<SharedIcon size={20} />}
          label="Shared with me"
          active={false}
          onClick={() => {}}
          disabled
          badge="Soon"
        />
        <SidebarItem
          icon={<TrashIcon size={20} />}
          label="Trash"
          active={section === "trash"}
          onClick={() => onSectionChange("trash")}
        />
      </nav>

      <div className="mt-auto border-t border-drive-border pt-4">
        <div className="px-4 text-xs text-drive-text-secondary">
          <div className="mb-1">Storage</div>
          <div className="h-1.5 w-full rounded-full bg-drive-border">
            <div className="h-full w-1/4 rounded-full bg-drive-blue" />
          </div>
          <div className="mt-1">{storageUsed} used</div>
        </div>

        <div className="mt-4 flex flex-col gap-1 px-2">
          <Link
            href="/team"
            className="drive-sidebar-item text-drive-text-secondary hover:text-drive-text"
          >
            Team
          </Link>
        </div>
      </div>
    </aside>
  );
}

function SidebarItem({
  icon,
  label,
  active,
  onClick,
  disabled,
  badge,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`drive-sidebar-item ${active ? "drive-sidebar-item-active" : ""} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      <span className={active ? "text-drive-blue" : "text-drive-text-secondary"}>{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {badge && (
        <span className="rounded-full bg-drive-hover px-2 py-0.5 text-[10px] font-medium text-drive-text-secondary">
          {badge}
        </span>
      )}
    </button>
  );
}
