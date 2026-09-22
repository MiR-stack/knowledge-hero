import type { FastifyInstance } from "fastify";
import argon2 from "argon2";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { UserRole } from "@rag/shared-types";
import { users, workspaceMembers, workspaces } from "@rag/db";
import {
  assignableRoles,
  canInviteRole,
  canManageTeam,
  canRemoveMember,
} from "../lib/team-rbac.js";

interface InviteBody {
  email: string;
  fullName: string;
  role: UserRole;
  password?: string;
}

interface UpdateMemberBody {
  role: UserRole;
}

export async function teamRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/api/v1/team/members",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const role = request.workspaceRole!;

      if (!canManageTeam(role)) {
        return reply.code(403).send({
          error: "forbidden",
          message: "You do not have permission to view team members",
        });
      }

      const rows = await db
        .select({
          userId: workspaceMembers.userId,
          role: workspaceMembers.role,
          joinedAt: workspaceMembers.joinedAt,
          invitedBy: workspaceMembers.invitedBy,
          email: users.email,
          fullName: users.fullName,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(eq(workspaceMembers.workspaceId, request.workspaceId!));

      return reply.send({
        members: rows.map((m) => ({
          userId: m.userId,
          email: m.email,
          fullName: m.fullName,
          role: m.role,
          joinedAt: m.joinedAt.toISOString(),
          invitedBy: m.invitedBy,
        })),
        assignableRoles: assignableRoles(role),
      });
    },
  );

  fastify.post<{ Body: InviteBody }>(
    "/api/v1/team/invite",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const actorId = request.userId!;
      const actorRole = request.workspaceRole!;
      const { email, fullName, role: targetRole, password } = request.body ?? {};

      if (!canManageTeam(actorRole)) {
        return reply.code(403).send({ error: "forbidden", message: "Cannot invite members" });
      }

      if (!email?.trim() || !fullName?.trim() || !targetRole) {
        return reply.code(400).send({
          error: "validation_error",
          message: "email, fullName, and role are required",
        });
      }

      if (!canInviteRole(actorRole, targetRole)) {
        return reply.code(403).send({
          error: "forbidden",
          message: `You cannot invite users with role ${targetRole}`,
        });
      }

      let temporaryPassword: string | undefined;
      let userId: string;

      const [existingUser] = await fastify.adminDb
        .select({ id: users.id, email: users.email, fullName: users.fullName })
        .from(users)
        .where(eq(users.email, email.trim().toLowerCase()))
        .limit(1);

      if (existingUser) {
        userId = existingUser.id;

        const [existingMember] = await db
          .select()
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, request.workspaceId!),
              eq(workspaceMembers.userId, userId),
            ),
          )
          .limit(1);

        if (existingMember) {
          return reply.code(409).send({
            error: "conflict",
            message: "User is already a member of this workspace",
          });
        }
      } else {
        temporaryPassword = password ?? randomBytes(9).toString("base64url");
        if (temporaryPassword.length < 8) {
          return reply.code(400).send({
            error: "validation_error",
            message: "Password must be at least 8 characters for new users",
          });
        }

        const passwordHash = await argon2.hash(temporaryPassword);
        const [created] = await fastify.adminDb
          .insert(users)
          .values({
            email: email.trim().toLowerCase(),
            fullName: fullName.trim(),
            passwordHash,
          })
          .returning({ id: users.id });

        userId = created.id;
      }

      const [member] = await db
        .insert(workspaceMembers)
        .values({
          workspaceId: request.workspaceId!,
          userId,
          role: targetRole,
          invitedBy: actorId,
        })
        .returning();

      return reply.code(201).send({
        member: {
          userId: member.userId,
          role: member.role,
          joinedAt: member.joinedAt.toISOString(),
        },
        temporaryPassword: temporaryPassword ?? null,
        message: temporaryPassword
          ? "User created — share the temporary password securely"
          : "Existing user added to workspace",
      });
    },
  );

  fastify.patch<{ Params: { userId: string }; Body: UpdateMemberBody }>(
    "/api/v1/team/members/:userId",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const actorId = request.userId!;
      const actorRole = request.workspaceRole!;
      const { role: newRole } = request.body ?? {};

      if (!newRole) {
        return reply.code(400).send({ error: "validation_error", message: "role is required" });
      }

      if (actorRole !== "workspace_admin") {
        return reply.code(403).send({
          error: "forbidden",
          message: "Only workspace admins can change member roles",
        });
      }

      const [target] = await db
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, request.workspaceId!),
            eq(workspaceMembers.userId, request.params.userId),
          ),
        )
        .limit(1);

      if (!target) {
        return reply.code(404).send({ error: "not_found", message: "Member not found" });
      }

      if (actorId === target.userId) {
        return reply.code(400).send({
          error: "validation_error",
          message: "You cannot change your own role",
        });
      }

      const [updated] = await db
        .update(workspaceMembers)
        .set({ role: newRole })
        .where(
          and(
            eq(workspaceMembers.workspaceId, request.workspaceId!),
            eq(workspaceMembers.userId, request.params.userId),
          ),
        )
        .returning();

      return reply.send({
        member: {
          userId: updated.userId,
          role: updated.role,
        },
      });
    },
  );

  fastify.delete<{ Params: { userId: string } }>(
    "/api/v1/team/members/:userId",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const actorId = request.userId!;
      const actorRole = request.workspaceRole!;

      if (!canManageTeam(actorRole)) {
        return reply.code(403).send({ error: "forbidden", message: "Cannot remove members" });
      }

      const [target] = await db
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, request.workspaceId!),
            eq(workspaceMembers.userId, request.params.userId),
          ),
        )
        .limit(1);

      if (!target) {
        return reply.code(404).send({ error: "not_found", message: "Member not found" });
      }

      if (!canRemoveMember(actorRole, actorId, target.userId, target.role)) {
        return reply.code(403).send({
          error: "forbidden",
          message: "You cannot remove this member",
        });
      }

      await db
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, request.workspaceId!),
            eq(workspaceMembers.userId, request.params.userId),
          ),
        );

      return reply.code(204).send();
    },
  );
}

export async function workspaceRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/api/v1/workspaces",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const userId = request.userId!;

      const rows = await fastify.adminDb
        .select({
          workspaceId: workspaceMembers.workspaceId,
          role: workspaceMembers.role,
          name: workspaces.name,
          slug: workspaces.slug,
        })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .where(eq(workspaceMembers.userId, userId));

      return reply.send({
        workspaces: rows.map((w) => ({
          id: w.workspaceId,
          name: w.name,
          slug: w.slug,
          role: w.role,
        })),
      });
    },
  );
}
