import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import type { AccessLevel, UserRole } from "@rag/shared-types";
import { folderPermissions, folders, users } from "@rag/db";
import { assertFolderWriteAccess, FolderAccessError } from "../lib/folders.js";

interface SetPermissionBody {
  userId?: string | null;
  role?: UserRole | null;
  accessLevel: AccessLevel;
}

export async function folderPermissionRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { folderId: string } }>(
    "/api/v1/folders/:folderId/permissions",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;

      const [folder] = await db
        .select()
        .from(folders)
        .where(and(eq(folders.id, request.params.folderId), isNull(folders.deletedAt)))
        .limit(1);

      if (!folder) {
        return reply.code(404).send({ error: "not_found", message: "Folder not found" });
      }

      if (role !== "workspace_admin") {
        try {
          await assertFolderWriteAccess(db, folder.path, userId, role);
        } catch (err) {
          if (err instanceof FolderAccessError) {
            return reply.code(403).send({ error: "forbidden", message: err.message });
          }
          throw err;
        }
      }

      const perms = await db
        .select({
          id: folderPermissions.id,
          folderId: folderPermissions.folderId,
          userId: folderPermissions.userId,
          role: folderPermissions.role,
          accessLevel: folderPermissions.accessLevel,
          grantedBy: folderPermissions.grantedBy,
          createdAt: folderPermissions.createdAt,
          userEmail: users.email,
          userFullName: users.fullName,
        })
        .from(folderPermissions)
        .leftJoin(users, eq(users.id, folderPermissions.userId))
        .where(eq(folderPermissions.folderId, folder.id));

      return reply.send({
        permissions: perms.map((p) => ({
          id: p.id,
          folderId: p.folderId,
          userId: p.userId,
          userEmail: p.userEmail,
          userFullName: p.userFullName,
          role: p.role,
          accessLevel: p.accessLevel,
          grantedBy: p.grantedBy,
          createdAt: p.createdAt.toISOString(),
        })),
      });
    },
  );

  fastify.put<{ Params: { folderId: string }; Body: SetPermissionBody }>(
    "/api/v1/folders/:folderId/permissions",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;
      const { userId: targetUserId, role: targetRole, accessLevel } = request.body ?? {};

      if (!accessLevel || !["none", "read", "write"].includes(accessLevel)) {
        return reply.code(400).send({
          error: "validation_error",
          message: "accessLevel must be none, read, or write",
        });
      }

      const hasUser = Boolean(targetUserId);
      const hasRole = Boolean(targetRole);
      if (hasUser === hasRole) {
        return reply.code(400).send({
          error: "validation_error",
          message: "Exactly one of userId or role must be provided",
        });
      }

      const [folder] = await db
        .select()
        .from(folders)
        .where(and(eq(folders.id, request.params.folderId), isNull(folders.deletedAt)))
        .limit(1);

      if (!folder) {
        return reply.code(404).send({ error: "not_found", message: "Folder not found" });
      }

      if (role !== "workspace_admin") {
        try {
          await assertFolderWriteAccess(db, folder.path, userId, role);
        } catch (err) {
          if (err instanceof FolderAccessError) {
            return reply.code(403).send({ error: "forbidden", message: err.message });
          }
          throw err;
        }
      }

      const existing = await db
        .select()
        .from(folderPermissions)
        .where(
          and(
            eq(folderPermissions.folderId, folder.id),
            targetUserId
              ? eq(folderPermissions.userId, targetUserId)
              : eq(folderPermissions.role, targetRole!),
          ),
        )
        .limit(1);

      if (existing[0]) {
        const [updated] = await db
          .update(folderPermissions)
          .set({ accessLevel })
          .where(eq(folderPermissions.id, existing[0].id))
          .returning();

        return reply.send({
          permission: {
            id: updated.id,
            folderId: updated.folderId,
            userId: updated.userId,
            role: updated.role,
            accessLevel: updated.accessLevel,
            grantedBy: updated.grantedBy,
            createdAt: updated.createdAt.toISOString(),
          },
        });
      }

      const [created] = await db
        .insert(folderPermissions)
        .values({
          folderId: folder.id,
          userId: targetUserId ?? null,
          role: targetRole ?? null,
          accessLevel,
          grantedBy: userId,
        })
        .returning();

      return reply.code(201).send({
        permission: {
          id: created.id,
          folderId: created.folderId,
          userId: created.userId,
          role: created.role,
          accessLevel: created.accessLevel,
          grantedBy: created.grantedBy,
          createdAt: created.createdAt.toISOString(),
        },
      });
    },
  );

  fastify.delete<{ Params: { folderId: string; permissionId: string } }>(
    "/api/v1/folders/:folderId/permissions/:permissionId",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;

      const [folder] = await db
        .select()
        .from(folders)
        .where(and(eq(folders.id, request.params.folderId), isNull(folders.deletedAt)))
        .limit(1);

      if (!folder) {
        return reply.code(404).send({ error: "not_found", message: "Folder not found" });
      }

      if (role !== "workspace_admin") {
        try {
          await assertFolderWriteAccess(db, folder.path, userId, role);
        } catch (err) {
          if (err instanceof FolderAccessError) {
            return reply.code(403).send({ error: "forbidden", message: err.message });
          }
          throw err;
        }
      }

      await db
        .delete(folderPermissions)
        .where(
          and(
            eq(folderPermissions.id, request.params.permissionId),
            eq(folderPermissions.folderId, folder.id),
          ),
        );

      return reply.code(204).send();
    },
  );
}
