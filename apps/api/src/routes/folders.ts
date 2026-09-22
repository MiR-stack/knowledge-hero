import type { FastifyInstance } from "fastify";
import { and, eq, isNull, sql } from "drizzle-orm";
import { folders } from "@rag/db";
import {
  assertFolderWriteAccess,
  buildChildPath,
  computeTrashPurgeAt,
  ensureRootFolder,
  FolderAccessError,
  FolderDepthError,
  resolveBreadcrumbs,
  validateFolderDepth,
} from "../lib/folders.js";
import { authorizedFoldersCte } from "../lib/folder-permissions.js";
import { config } from "../config.js";
import { pathDepth } from "../lib/ltree.js";
import { listAuthorizedDocumentsInFolder } from "../lib/documents.js";

interface CreateFolderBody {
  name: string;
  parentId?: string | null;
}

interface RenameFolderBody {
  name: string;
}

interface MoveFolderBody {
  targetParentId: string | null;
}

export async function folderRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { parentId?: string; trash?: string } }>(
    "/api/v1/folders",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;
      const showTrash = request.query.trash === "true";

      if (showTrash) {
        const trashed = await db.execute<{
          id: string;
          name: string;
          parent_id: string | null;
          path: string;
          deleted_at: string;
        }>(sql`
          WITH ${authorizedFoldersCte(userId, role, { includeDeleted: true })}
          SELECT f.id, f.name, f.parent_id, f.path::text AS path, f.deleted_at
          FROM folders f
          INNER JOIN authorized_folders af ON af.id = f.id
          WHERE f.deleted_at IS NOT NULL
          ORDER BY f.deleted_at DESC
        `);

        return reply.send({
          folders: trashed.map((f) => ({
            id: f.id,
            name: f.name,
            parentId: f.parent_id,
            path: f.path,
            deletedAt: f.deleted_at,
          })),
        });
      }

      let parentId = request.query.parentId ?? null;

      if (!parentId) {
        const root = await ensureRootFolder(db, request.workspaceId!, userId);
        parentId = root.id;
      }

      const [parent] = await db
        .select()
        .from(folders)
        .where(and(eq(folders.id, parentId), isNull(folders.deletedAt)))
        .limit(1);

      if (!parent) {
        return reply.code(404).send({ error: "not_found", message: "Parent folder not found" });
      }

      const breadcrumbs = await resolveBreadcrumbs(db, parent.path);

      const parentAccess = await db.execute<{ access_level: string }>(sql`
        WITH ${authorizedFoldersCte(userId, role)}
        SELECT af.access_level
        FROM authorized_folders af
        WHERE af.id = ${parentId}::uuid
        LIMIT 1
      `);

      if (!parentAccess[0]) {
        return reply.code(403).send({
          error: "forbidden",
          message: "You do not have access to this folder",
        });
      }

      const childFolders = await db.execute<{
        id: string;
        name: string;
        parent_id: string | null;
        path: string;
        created_at: string;
        updated_at: string;
        access_level: string;
      }>(sql`
        WITH ${authorizedFoldersCte(userId, role)}
        SELECT f.id, f.name, f.parent_id, f.path::text AS path, f.created_at, f.updated_at, af.access_level
        FROM folders f
        INNER JOIN authorized_folders af ON af.id = f.id
        WHERE f.parent_id = ${parentId}::uuid
          AND f.deleted_at IS NULL
        ORDER BY f.name
      `);

      const folderDocuments = await listAuthorizedDocumentsInFolder(
        db,
        userId,
        role,
        parentId,
      );

      return reply.send({
        folder: {
          id: parent.id,
          name: parent.name,
          parentId: parent.parentId,
          path: parent.path,
          createdAt: parent.createdAt.toISOString(),
          updatedAt: parent.updatedAt.toISOString(),
          breadcrumbs: breadcrumbs.map((b) => ({
            id: b.id,
            name: b.name,
            path: b.path,
          })),
          accessLevel: parentAccess[0]?.access_level ?? "write",
        },
        folders: childFolders.map((f) => ({
          id: f.id,
          name: f.name,
          parentId: f.parent_id,
          path: f.path,
          createdAt: f.created_at,
          updatedAt: f.updated_at,
          accessLevel: f.access_level,
        })),
        documents: folderDocuments,
      });
    },
  );

  fastify.get(
    "/api/v1/folders/tree",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;

      await ensureRootFolder(db, request.workspaceId!, userId);

      const rows = await db.execute<{
        id: string;
        name: string;
        parent_id: string | null;
        path: string;
      }>(sql`
        WITH ${authorizedFoldersCte(userId, role)}
        SELECT f.id, f.name, f.parent_id, f.path::text AS path
        FROM folders f
        INNER JOIN authorized_folders af ON af.id = f.id
        WHERE f.deleted_at IS NULL
        ORDER BY nlevel(f.path), f.name
      `);

      type TreeNode = {
        id: string;
        name: string;
        parentId: string | null;
        path: string;
        children: TreeNode[];
      };

      const nodeMap = new Map<string, TreeNode>();
      const roots: TreeNode[] = [];

      for (const row of rows) {
        nodeMap.set(row.id, {
          id: row.id,
          name: row.name,
          parentId: row.parent_id,
          path: row.path,
          children: [],
        });
      }

      for (const node of nodeMap.values()) {
        if (node.parentId && nodeMap.has(node.parentId)) {
          nodeMap.get(node.parentId)!.children.push(node);
        } else {
          roots.push(node);
        }
      }

      return reply.send({ tree: roots });
    },
  );

  fastify.post<{ Body: CreateFolderBody }>(
    "/api/v1/folders",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;
      const { name } = request.body ?? {};

      if (!name?.trim()) {
        return reply.code(400).send({ error: "validation_error", message: "name is required" });
      }

      let parentId = request.body?.parentId ?? null;
      let parentPath: string | null = null;

      if (!parentId) {
        const root = await ensureRootFolder(db, request.workspaceId!, userId);
        parentId = root.id;
        parentPath = root.path;
      } else {
        const [parent] = await db
          .select()
          .from(folders)
          .where(and(eq(folders.id, parentId), isNull(folders.deletedAt)))
          .limit(1);

        if (!parent) {
          return reply.code(404).send({ error: "not_found", message: "Parent folder not found" });
        }
        parentPath = parent.path;
      }

      try {
        await assertFolderWriteAccess(db, parentPath, userId, role);
      } catch (err) {
        if (err instanceof FolderAccessError) {
          return reply.code(403).send({ error: "forbidden", message: err.message });
        }
        throw err;
      }

      try {
        await validateFolderDepth(parentPath);
      } catch (err) {
        if (err instanceof FolderDepthError) {
          return reply.code(400).send({ error: "validation_error", message: err.message });
        }
        throw err;
      }

      const tempId = crypto.randomUUID();
      const path = buildChildPath(parentPath, name.trim(), tempId);

      const [folder] = await db
        .insert(folders)
        .values({
          id: tempId,
          workspaceId: request.workspaceId!,
          parentId,
          name: name.trim(),
          path,
          createdBy: userId,
        })
        .returning();

      return reply.code(201).send({
        folder: {
          id: folder.id,
          name: folder.name,
          parentId: folder.parentId,
          path: folder.path,
          createdAt: folder.createdAt.toISOString(),
          updatedAt: folder.updatedAt.toISOString(),
        },
      });
    },
  );

  fastify.get<{ Params: { folderId: string } }>(
    "/api/v1/folders/:folderId",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;

      const rows = await db.execute<{
        id: string;
        name: string;
        parent_id: string | null;
        path: string;
        created_at: string;
        updated_at: string;
      }>(sql`
        WITH ${authorizedFoldersCte(userId, role)}
        SELECT f.id, f.name, f.parent_id, f.path::text AS path, f.created_at, f.updated_at
        FROM folders f
        INNER JOIN authorized_folders af ON af.id = f.id
        WHERE f.id = ${request.params.folderId}::uuid
          AND f.deleted_at IS NULL
        LIMIT 1
      `);

      const folder = rows[0];
      if (!folder) {
        return reply.code(404).send({ error: "not_found", message: "Folder not found" });
      }

      const breadcrumbs = await resolveBreadcrumbs(db, folder.path);

      return reply.send({
        folder: {
          id: folder.id,
          name: folder.name,
          parentId: folder.parent_id,
          path: folder.path,
          createdAt: folder.created_at,
          updatedAt: folder.updated_at,
          breadcrumbs: breadcrumbs.map((b) => ({
            id: b.id,
            name: b.name,
            path: b.path,
          })),
        },
      });
    },
  );

  fastify.patch<{ Params: { folderId: string }; Body: RenameFolderBody }>(
    "/api/v1/folders/:folderId",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;
      const { name } = request.body ?? {};

      if (!name?.trim()) {
        return reply.code(400).send({ error: "validation_error", message: "name is required" });
      }

      const [folder] = await db
        .select()
        .from(folders)
        .where(and(eq(folders.id, request.params.folderId), isNull(folders.deletedAt)))
        .limit(1);

      if (!folder) {
        return reply.code(404).send({ error: "not_found", message: "Folder not found" });
      }

      try {
        await assertFolderWriteAccess(db, folder.path, userId, role);
      } catch (err) {
        if (err instanceof FolderAccessError) {
          return reply.code(403).send({ error: "forbidden", message: err.message });
        }
        throw err;
      }

      const [updated] = await db
        .update(folders)
        .set({ name: name.trim(), updatedAt: new Date() })
        .where(eq(folders.id, folder.id))
        .returning();

      return reply.send({
        folder: {
          id: updated.id,
          name: updated.name,
          parentId: updated.parentId,
          path: updated.path,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
        },
      });
    },
  );

  fastify.post<{ Params: { folderId: string }; Body: MoveFolderBody }>(
    "/api/v1/folders/:folderId/move",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;
      const { targetParentId: requestedParentId } = request.body ?? {};
      let targetParentId = requestedParentId;

      const [folder] = await db
        .select()
        .from(folders)
        .where(and(eq(folders.id, request.params.folderId), isNull(folders.deletedAt)))
        .limit(1);

      if (!folder) {
        return reply.code(404).send({ error: "not_found", message: "Folder not found" });
      }

      if (folder.parentId === null) {
        return reply.code(400).send({ error: "validation_error", message: "Cannot move root folder" });
      }

      try {
        await assertFolderWriteAccess(db, folder.path, userId, role);
      } catch (err) {
        if (err instanceof FolderAccessError) {
          return reply.code(403).send({ error: "forbidden", message: err.message });
        }
        throw err;
      }

      let targetPath: string | null = null;

      if (targetParentId) {
        const [target] = await db
          .select()
          .from(folders)
          .where(and(eq(folders.id, targetParentId), isNull(folders.deletedAt)))
          .limit(1);

        if (!target) {
          return reply.code(404).send({ error: "not_found", message: "Target folder not found" });
        }

        if (target.path.startsWith(folder.path + ".") || target.path === folder.path) {
          return reply.code(400).send({
            error: "validation_error",
            message: "Cannot move folder into itself or a descendant",
          });
        }

        try {
          await assertFolderWriteAccess(db, target.path, userId, role);
        } catch (err) {
          if (err instanceof FolderAccessError) {
            return reply.code(403).send({ error: "forbidden", message: err.message });
          }
          throw err;
        }

        targetPath = target.path;
      } else {
        const root = await ensureRootFolder(db, request.workspaceId!, userId);
        targetPath = root.path;
        targetParentId = root.id;
      }

      const subtreeDepth = await db.execute<{ max_depth: number }>(sql`
        SELECT COALESCE(MAX(nlevel(path) - nlevel(${folder.path}::ltree)), 0) AS max_depth
        FROM folders
        WHERE path <@ ${folder.path}::ltree AND deleted_at IS NULL
      `);
      const totalDepth = pathDepth(targetPath) + 1 + (subtreeDepth[0]?.max_depth ?? 0);

      if (totalDepth > config.drive.maxFolderDepth) {
        return reply.code(400).send({
          error: "validation_error",
          message: `Move would exceed maximum folder depth`,
        });
      }

      const newPath = buildChildPath(targetPath, folder.name, folder.id);

      await db.execute(sql`
        UPDATE folders
        SET
          path = CASE
            WHEN id = ${folder.id}::uuid THEN ${newPath}::ltree
            ELSE ${newPath}::ltree || subpath(path, nlevel(${folder.path}::ltree))
          END,
          parent_id = CASE WHEN id = ${folder.id}::uuid THEN ${targetParentId}::uuid ELSE parent_id END,
          updated_at = now()
        WHERE path <@ ${folder.path}::ltree
      `);

      const [moved] = await db
        .select()
        .from(folders)
        .where(eq(folders.id, folder.id))
        .limit(1);

      return reply.send({
        folder: {
          id: moved!.id,
          name: moved!.name,
          parentId: moved!.parentId,
          path: moved!.path,
          createdAt: moved!.createdAt.toISOString(),
          updatedAt: moved!.updatedAt.toISOString(),
        },
      });
    },
  );

  fastify.delete<{ Params: { folderId: string } }>(
    "/api/v1/folders/:folderId",
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

      if (folder.parentId === null) {
        return reply.code(400).send({ error: "validation_error", message: "Cannot delete root folder" });
      }

      try {
        await assertFolderWriteAccess(db, folder.path, userId, role);
      } catch (err) {
        if (err instanceof FolderAccessError) {
          return reply.code(403).send({ error: "forbidden", message: err.message });
        }
        throw err;
      }

      const purgeAt = computeTrashPurgeAt();

      await db.execute(sql`
        UPDATE folders SET deleted_at = now(), updated_at = now()
        WHERE path <@ ${folder.path}::ltree AND deleted_at IS NULL
      `);

      await db.execute(sql`
        UPDATE documents SET deleted_at = now(), purge_at = ${purgeAt}, updated_at = now()
        WHERE folder_id IN (
          SELECT id FROM folders WHERE path <@ ${folder.path}::ltree
        ) AND deleted_at IS NULL
      `);

      return reply.code(204).send();
    },
  );

  fastify.post<{ Params: { folderId: string } }>(
    "/api/v1/folders/:folderId/restore",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;

      const [folder] = await db
        .select()
        .from(folders)
        .where(eq(folders.id, request.params.folderId))
        .limit(1);

      if (!folder?.deletedAt) {
        return reply.code(404).send({ error: "not_found", message: "Trashed folder not found" });
      }

      try {
        await assertFolderWriteAccess(db, folder.path, userId, role);
      } catch (err) {
        if (err instanceof FolderAccessError) {
          return reply.code(403).send({ error: "forbidden", message: err.message });
        }
        throw err;
      }

      await db.execute(sql`
        UPDATE folders SET deleted_at = NULL, updated_at = now()
        WHERE path <@ ${folder.path}::ltree
      `);

      await db.execute(sql`
        UPDATE documents SET deleted_at = NULL, purge_at = NULL, updated_at = now()
        WHERE folder_id IN (
          SELECT id FROM folders WHERE path <@ ${folder.path}::ltree
        )
      `);

      return reply.code(204).send();
    },
  );
}
