"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { UserRole, WorkspaceSummary } from "@rag/shared-types";
import { useAuth } from "../../lib/auth";
import { fetchWorkspaces, roleLabel } from "../../lib/api";
import { SearchIcon } from "./icons";

interface DriveTopBarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onSearchSubmit: () => void;
}

export function DriveTopBar({ searchQuery, onSearchChange, onSearchSubmit }: DriveTopBarProps) {
  const auth = useAuth();
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!auth.token) return;
    fetchWorkspaces(auth.token)
      .then((res) => setWorkspaces(res.workspaces))
      .catch(() => {});
  }, [auth.token, auth.workspaceId]);

  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-drive-border bg-white px-4">
      <div className="relative mx-auto max-w-2xl flex-1">
        <SearchIcon
          size={20}
          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-drive-text-secondary"
        />
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSearchSubmit()}
          placeholder="Search in Drive"
          className="drive-search"
        />
      </div>

      <div className="relative ml-auto flex items-center gap-2">
        {workspaces.length > 1 && (
          <select
            value={auth.workspaceId}
            onChange={(e) => {
              auth.switchWorkspace(e.target.value);
              router.refresh();
            }}
            className="rounded-lg border border-drive-border px-2 py-1.5 text-sm text-drive-text"
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        )}

        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-drive-blue text-sm font-medium text-white"
        >
          {auth.fullName?.charAt(0)?.toUpperCase() ?? "U"}
        </button>

        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div className="drive-dropdown right-0 top-full z-50 mt-1 w-56">
              <div className="border-b border-drive-border px-4 py-3">
                <div className="text-sm font-medium text-drive-text">{auth.fullName}</div>
                <div className="text-xs text-drive-text-secondary">
                  {roleLabel(auth.role as UserRole)}
                </div>
              </div>
              <button
                type="button"
                className="drive-dropdown-item text-red-600"
                onClick={() => {
                  auth.logout();
                  router.replace("/login");
                }}
              >
                Sign out
              </button>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
