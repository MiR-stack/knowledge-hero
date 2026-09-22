"use client";

import { useCallback, useEffect, useState } from "react";
import type { AccessLevel, FolderPermissionRecord, TeamMember, UserRole } from "@rag/shared-types";
import {
  deleteFolderPermission,
  fetchFolderPermissions,
  fetchTeamMembers,
  roleLabel,
  setFolderPermission,
} from "../../lib/api";
import { CloseIcon } from "./icons";

export interface ShareTarget {
  kind: "folder" | "document";
  id: string;
  name: string;
  /** Folder whose permissions are managed (parent folder for documents). */
  folderId: string;
}

interface ShareModalProps {
  token: string;
  workspaceId: string;
  target: ShareTarget;
  onClose: () => void;
}

const ROLES: UserRole[] = [
  "workspace_admin",
  "senior_reviewer",
  "staff_member",
  "read_only_client",
];

export function ShareModal({ token, workspaceId, target, onClose }: ShareModalProps) {
  const [permissions, setPermissions] = useState<FolderPermissionRecord[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [emailInput, setEmailInput] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [accessLevel, setAccessLevel] = useState<AccessLevel>("read");
  const [grantByRole, setGrantByRole] = useState(false);
  const [selectedRole, setSelectedRole] = useState<UserRole>("staff_member");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const folderId = target.folderId;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [permRes, teamRes] = await Promise.all([
        fetchFolderPermissions(token, workspaceId, folderId),
        fetchTeamMembers(token, workspaceId).catch(() => ({ members: [], assignableRoles: [] })),
      ]);
      setPermissions(permRes.permissions);
      setMembers(teamRes.members);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sharing settings");
    } finally {
      setLoading(false);
    }
  }, [folderId, token, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  function resolveUserId(): string | null {
    if (grantByRole) return null;
    if (selectedUserId) return selectedUserId;
    const email = emailInput.trim().toLowerCase();
    if (!email) return null;
    const match = members.find((m) => m.email.toLowerCase() === email);
    return match?.userId ?? null;
  }

  async function handleGrant() {
    setSaving(true);
    setError(null);
    try {
      if (grantByRole) {
        await setFolderPermission(token, workspaceId, folderId, {
          role: selectedRole,
          accessLevel,
        });
      } else {
        const userId = resolveUserId();
        if (!userId) {
          setError("Select a team member or enter a valid email from your workspace");
          setSaving(false);
          return;
        }
        await setFolderPermission(token, workspaceId, folderId, {
          userId,
          accessLevel,
        });
      }
      setEmailInput("");
      setSelectedUserId("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update permission");
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdateAccess(permissionId: string, level: AccessLevel) {
    const perm = permissions.find((p) => p.id === permissionId);
    if (!perm) return;
    try {
      await setFolderPermission(token, workspaceId, folderId, {
        userId: perm.userId ?? undefined,
        role: perm.role ?? undefined,
        accessLevel: level,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update permission");
    }
  }

  async function handleRemove(permissionId: string) {
    try {
      await deleteFolderPermission(token, workspaceId, folderId, permissionId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove permission");
    }
  }

  const filteredMembers = emailInput.trim()
    ? members.filter(
        (m) =>
          m.email.toLowerCase().includes(emailInput.toLowerCase()) ||
          m.fullName.toLowerCase().includes(emailInput.toLowerCase()),
      )
    : members;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        className="flex max-h-[90vh] w-full max-w-[520px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        role="dialog"
        aria-labelledby="share-dialog-title"
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-6 pb-2">
          <div>
            <h2 id="share-dialog-title" className="text-xl font-normal text-drive-text">
              Share &ldquo;{target.name}&rdquo;
            </h2>
            {target.kind === "document" && (
              <p className="mt-1 text-xs text-drive-text-secondary">
                Access is managed through the parent folder
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="drive-icon-btn -mr-1 -mt-1"
            aria-label="Close"
          >
            <CloseIcon size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-4">
          {error && (
            <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}

          {/* Add people input */}
          <div className="mb-5 flex gap-2">
            <div className="relative flex-1">
              {!grantByRole ? (
                <>
                  <input
                    type="text"
                    value={selectedUserId ? (members.find((m) => m.userId === selectedUserId)?.email ?? "") : emailInput}
                    onChange={(e) => {
                      setEmailInput(e.target.value);
                      setSelectedUserId("");
                    }}
                    placeholder="Add people and groups"
                    className="w-full rounded-full border border-drive-border px-4 py-2.5 text-sm text-drive-text placeholder:text-drive-text-secondary focus:border-drive-blue focus:outline-none focus:ring-1 focus:ring-drive-blue"
                  />
                  {emailInput && filteredMembers.length > 0 && !selectedUserId && (
                    <ul className="absolute left-0 right-0 top-full z-10 mt-1 max-h-40 overflow-y-auto rounded-lg border border-drive-border bg-white py-1 shadow-lg">
                      {filteredMembers.map((m) => (
                        <li key={m.userId}>
                          <button
                            type="button"
                            className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-drive-hover"
                            onClick={() => {
                              setSelectedUserId(m.userId);
                              setEmailInput(m.email);
                            }}
                          >
                            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-drive-blue text-xs font-medium text-white">
                              {m.fullName.charAt(0).toUpperCase()}
                            </span>
                            <div>
                              <div className="font-medium text-drive-text">{m.fullName}</div>
                              <div className="text-xs text-drive-text-secondary">{m.email}</div>
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <select
                  value={selectedRole}
                  onChange={(e) => setSelectedRole(e.target.value as UserRole)}
                  className="w-full rounded-full border border-drive-border px-4 py-2.5 text-sm text-drive-text focus:border-drive-blue focus:outline-none focus:ring-1 focus:ring-drive-blue"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {roleLabel(r)}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <select
              value={accessLevel}
              onChange={(e) => setAccessLevel(e.target.value as AccessLevel)}
              className="rounded-full border border-drive-border px-3 py-2.5 text-sm text-drive-text focus:border-drive-blue focus:outline-none"
            >
              <option value="read">Viewer</option>
              <option value="write">Editor</option>
            </select>

            <button
              type="button"
              onClick={() => void handleGrant()}
              disabled={saving || (!grantByRole && !resolveUserId())}
              className="drive-btn-primary shrink-0 px-5 disabled:opacity-50"
            >
              Share
            </button>
          </div>

          <label className="mb-4 flex items-center gap-2 text-xs text-drive-text-secondary">
            <input
              type="checkbox"
              checked={grantByRole}
              onChange={(e) => setGrantByRole(e.target.checked)}
              className="rounded"
            />
            Grant by workspace role
          </label>

          {/* People with access */}
          <div>
            <h3 className="mb-3 text-sm font-medium text-drive-text-secondary">
              People with access
            </h3>
            {loading ? (
              <p className="text-sm text-drive-text-secondary">Loading…</p>
            ) : permissions.length === 0 ? (
              <p className="rounded-lg bg-drive-bg px-4 py-3 text-sm text-drive-text-secondary">
                Only workspace members with default access can view this{" "}
                {target.kind === "folder" ? "folder" : "file"}. Add people above to share.
              </p>
            ) : (
              <ul className="space-y-1">
                {permissions.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between rounded-lg px-2 py-2 hover:bg-drive-hover"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-drive-blue-light text-sm font-medium text-drive-blue">
                        {p.userId
                          ? (p.userFullName ?? p.userEmail ?? "?").charAt(0).toUpperCase()
                          : "R"}
                      </span>
                      <div className="min-w-0">
                        <div className="truncate text-sm text-drive-text">
                          {p.userId
                            ? (p.userFullName ?? p.userEmail ?? p.userId)
                            : `Role: ${p.role ? roleLabel(p.role) : "—"}`}
                        </div>
                        {p.userEmail && (
                          <div className="truncate text-xs text-drive-text-secondary">
                            {p.userEmail}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <select
                        value={p.accessLevel}
                        onChange={(e) =>
                          void handleUpdateAccess(p.id, e.target.value as AccessLevel)
                        }
                        className="rounded-md border-0 bg-transparent py-1 pl-2 pr-6 text-sm text-drive-text-secondary hover:bg-drive-hover focus:outline-none"
                      >
                        <option value="read">Viewer</option>
                        <option value="write">Editor</option>
                        <option value="none">Remove</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => void handleRemove(p.id)}
                        className="drive-icon-btn h-8 w-8 text-drive-text-secondary"
                        title="Remove access"
                        aria-label="Remove access"
                      >
                        <CloseIcon size={16} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end border-t border-drive-border px-6 py-4">
          <button type="button" onClick={onClose} className="drive-btn-primary px-6">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
