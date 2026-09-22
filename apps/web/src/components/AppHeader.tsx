"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { UserRole, WorkspaceSummary } from "@rag/shared-types";
import { useAuth } from "../lib/auth";
import { fetchWorkspaces, roleLabel } from "../lib/api";

interface AppHeaderProps {
  title: string;
  subtitle?: string;
}

export function AppHeader({ title, subtitle }: AppHeaderProps) {
  const auth = useAuth();
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);

  useEffect(() => {
    if (!auth.token) return;
    fetchWorkspaces(auth.token)
      .then((res: { workspaces: WorkspaceSummary[] }) => setWorkspaces(res.workspaces))
      .catch(() => {});
  }, [auth.token, auth.workspaceId]);

  const currentWorkspace = workspaces.find((w) => w.id === auth.workspaceId);

  return (
    <header className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-3">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">{title}</h1>
        <p className="text-xs text-gray-500">
          {subtitle ?? `${auth.fullName} · ${roleLabel(auth.role as UserRole)}`}
          {currentWorkspace && ` · ${currentWorkspace.name}`}
        </p>
      </div>

      <div className="flex items-center gap-3">
        {workspaces.length > 1 && (
          <select
            value={auth.workspaceId}
            onChange={(e) => {
              auth.switchWorkspace(e.target.value);
              router.refresh();
            }}
            className="rounded-md border border-gray-300 px-2 py-1 text-sm"
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        )}

        <Link href="/drive" className="text-sm text-gray-600 hover:text-gray-900">
          Drive
        </Link>
        <Link href="/team" className="text-sm text-gray-600 hover:text-gray-900">
          Team
        </Link>
        <button
          type="button"
          onClick={() => {
            auth.logout();
            router.replace("/login");
          }}
          className="text-sm text-gray-600 hover:text-gray-900"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
