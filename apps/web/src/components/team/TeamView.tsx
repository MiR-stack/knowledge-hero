"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { TeamMember, UserRole } from "@rag/shared-types";
import { useAuth } from "../../lib/auth";
import {
  ApiError,
  canManageTeam,
  fetchTeamMembers,
  inviteTeamMember,
  removeTeamMember,
  roleLabel,
  updateTeamMemberRole,
} from "../../lib/api";
import { AppHeader } from "../../components/AppHeader";

const ALL_ROLES: UserRole[] = [
  "workspace_admin",
  "senior_reviewer",
  "staff_member",
  "read_only_client",
];

export function TeamView() {
  const auth = useAuth();
  const router = useRouter();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [assignableRoles, setAssignableRoles] = useState<UserRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<UserRole>("staff_member");
  const [invitePassword, setInvitePassword] = useState("");
  const [inviteResult, setInviteResult] = useState<string | null>(null);

  const canManage = canManageTeam(auth.role);

  const load = useCallback(async () => {
    if (!auth.token || !auth.workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchTeamMembers(auth.token, auth.workspaceId);
      setMembers(res.members);
      setAssignableRoles(res.assignableRoles);
      if (res.assignableRoles.length > 0 && !res.assignableRoles.includes(inviteRole)) {
        setInviteRole(res.assignableRoles[0]);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load team");
    } finally {
      setLoading(false);
    }
  }, [auth.token, auth.workspaceId, inviteRole]);

  useEffect(() => {
    if (!auth.isReady) return;
    if (!auth.token) {
      router.replace("/login");
      return;
    }
    if (!canManage) {
      setError("You do not have permission to manage team members");
      setLoading(false);
      return;
    }
    void load();
  }, [auth.isReady, auth.token, router, canManage, load]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!auth.token) return;
    setInviteResult(null);
    try {
      const res = await inviteTeamMember(auth.token, auth.workspaceId, {
        email: inviteEmail.trim(),
        fullName: inviteName.trim(),
        role: inviteRole,
        password: invitePassword.trim() || undefined,
      });
      setInviteEmail("");
      setInviteName("");
      setInvitePassword("");
      setInviteResult(
        res.temporaryPassword
          ? `${res.message}. Temporary password: ${res.temporaryPassword}`
          : res.message,
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Invite failed");
    }
  }

  async function handleRoleChange(userId: string, role: UserRole) {
    if (!auth.token) return;
    try {
      await updateTeamMemberRole(auth.token, auth.workspaceId, userId, role);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Role update failed");
    }
  }

  async function handleRemove(userId: string, name: string) {
    if (!auth.token || !confirm(`Remove ${name} from this workspace?`)) return;
    try {
      await removeTeamMember(auth.token, auth.workspaceId, userId);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Remove failed");
    }
  }

  if (!auth.token) return null;

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader title="Team" subtitle="Invite collaborators and manage workspace access" />

      <main className="mx-auto w-full max-w-4xl flex-1 p-6">
        {error && (
          <div className="mb-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}
        {inviteResult && (
          <div className="mb-4 rounded-md bg-green-50 px-4 py-3 text-sm text-green-800">
            {inviteResult}
          </div>
        )}

        {!canManage ? (
          <p className="text-gray-600">
            Contact your workspace admin to invite team members or change roles.
          </p>
        ) : (
          <>
            <section className="mb-8 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
              <h2 className="text-base font-semibold text-gray-900">Invite member</h2>
              <p className="mt-1 text-sm text-gray-500">
                Add a colleague to this workspace. New users receive a temporary password to share
                securely.
              </p>

              <form onSubmit={(e) => void handleInvite(e)} className="mt-4 grid gap-3 sm:grid-cols-2">
                <input
                  type="email"
                  required
                  placeholder="Email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
                <input
                  type="text"
                  required
                  placeholder="Full name"
                  value={inviteName}
                  onChange={(e) => setInviteName(e.target.value)}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as UserRole)}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm"
                >
                  {assignableRoles.map((r) => (
                    <option key={r} value={r}>
                      {roleLabel(r)}
                    </option>
                  ))}
                </select>
                <input
                  type="password"
                  placeholder="Password for new user (optional)"
                  value={invitePassword}
                  onChange={(e) => setInvitePassword(e.target.value)}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
                <button
                  type="submit"
                  className="sm:col-span-2 rounded-md bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Send invite
                </button>
              </form>
            </section>

            <section className="rounded-lg border border-gray-200 bg-white shadow-sm">
              <div className="border-b border-gray-200 px-6 py-4">
                <h2 className="text-base font-semibold text-gray-900">Members</h2>
              </div>

              {loading ? (
                <p className="p-6 text-sm text-gray-500">Loading…</p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {members.map((m) => {
                    const isSelf = m.userId === auth.userId;
                    const canChangeRole = auth.role === "workspace_admin" && !isSelf;
                    const canRemove =
                      !isSelf &&
                      (auth.role === "workspace_admin" ||
                        (auth.role === "senior_reviewer" && m.role === "staff_member"));

                    return (
                      <li
                        key={m.userId}
                        className="flex flex-wrap items-center justify-between gap-3 px-6 py-4"
                      >
                        <div>
                          <p className="font-medium text-gray-900">
                            {m.fullName}
                            {isSelf && (
                              <span className="ml-2 text-xs text-gray-400">(you)</span>
                            )}
                          </p>
                          <p className="text-sm text-gray-500">{m.email}</p>
                        </div>

                        <div className="flex items-center gap-2">
                          {canChangeRole ? (
                            <select
                              value={m.role}
                              onChange={(e) =>
                                void handleRoleChange(m.userId, e.target.value as UserRole)
                              }
                              className="rounded-md border border-gray-300 px-2 py-1 text-sm"
                            >
                              {ALL_ROLES.map((r) => (
                                <option key={r} value={r}>
                                  {roleLabel(r)}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="rounded-full bg-gray-100 px-3 py-1 text-sm capitalize">
                              {roleLabel(m.role)}
                            </span>
                          )}

                          {canRemove && (
                            <button
                              type="button"
                              onClick={() => void handleRemove(m.userId, m.fullName)}
                              className="text-sm text-red-600 hover:underline"
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="mt-8 rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm text-blue-900">
              <strong>Folder collaboration:</strong> In Drive, select a folder and click{" "}
              <em>Share</em> to grant read/write access to specific members or roles. Permissions
              inherit down the folder tree per SRS FR-1.10.
            </section>
          </>
        )}
      </main>
    </div>
  );
}
