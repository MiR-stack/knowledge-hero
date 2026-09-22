import type { UserRole } from "@rag/shared-types";

const ROLE_RANK: Record<UserRole, number> = {
  workspace_admin: 4,
  senior_reviewer: 3,
  staff_member: 2,
  read_only_client: 1,
};

export function canManageTeam(role: UserRole): boolean {
  return role === "workspace_admin" || role === "senior_reviewer";
}

export function canInviteRole(actorRole: UserRole, targetRole: UserRole): boolean {
  if (actorRole === "workspace_admin") return true;
  if (actorRole === "senior_reviewer") return targetRole === "staff_member";
  return false;
}

export function canChangeMemberRole(
  actorRole: UserRole,
  actorUserId: string,
  targetUserId: string,
  currentTargetRole: UserRole,
  newRole: UserRole,
): boolean {
  if (actorUserId === targetUserId) return false;
  if (actorRole === "workspace_admin") return true;
  if (actorRole === "senior_reviewer") {
    return (
      currentTargetRole === "staff_member" &&
      newRole === "staff_member"
    );
  }
  return false;
}

export function canRemoveMember(
  actorRole: UserRole,
  actorUserId: string,
  targetUserId: string,
  targetRole: UserRole,
): boolean {
  if (actorUserId === targetUserId) return false;
  if (actorRole === "workspace_admin") return true;
  if (actorRole === "senior_reviewer") return targetRole === "staff_member";
  return false;
}

export function roleLabel(role: UserRole): string {
  return role.replace(/_/g, " ");
}

export function assignableRoles(actorRole: UserRole): UserRole[] {
  if (actorRole === "workspace_admin") {
    return ["workspace_admin", "senior_reviewer", "staff_member", "read_only_client"];
  }
  if (actorRole === "senior_reviewer") {
    return ["staff_member"];
  }
  return [];
}

export function isHigherRole(a: UserRole, b: UserRole): boolean {
  return ROLE_RANK[a] > ROLE_RANK[b];
}
