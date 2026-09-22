import type { FastifyInstance } from "fastify";
import { and, eq, isNull, sql } from "drizzle-orm";
import { documents, folders } from "@rag/db";
import {
  assertFolderWriteAccess,
  computeTrashPurgeAt,
  FolderAccessError,
} from "../lib/folders.js";
import {
  canUploadBaseDocument,
  authorizedFoldersCte,
} from "../lib/folder-permissions.js";
import {
  formatDocumentRow,
  listAuthorizedDocumentsInFolder,
  searchAuthorizedDocuments,
} from "../lib/documents.js";
import {
  buildStorageKey,
  inferSourceType,
  uploadObject,
} from "../lib/storage.js";

interface UpdateDocumentBody {
  title?: string;
  tags?: string[];
  isBaseDocument?: boolean;
  baseDocCategory?: string | null;
}

interface MoveDocumentBody {
  targetFolderId: string;
}

export async function documentRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { folderId?: string; q?: string; tags?: string } }>(
    "/api/v1/documents",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;
      const { folderId, q, tags } = request.query;

      if (q?.trim()) {
        const tagList = tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
        const results = await searchAuthorizedDocuments(db, userId, role, q.trim(), {
          tags: tagList,
          folderId,
        });
        return reply.send({ documents: results });
      }

      if (!folderId) {
        return reply.code(400).send({
          error: "validation_error",
          message: "folderId or q query parameter is required",
        });
      }

      const results = await listAuthorizedDocumentsInFolder(db, userId, role, folderId);
      return reply.send({ documents: results });
    },
  );

  fastify.post(
    "/api/v1/documents/upload",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;

      const data = await request.file();
      if (!data) {
        return reply.code(400).send({ error: "validation_error", message: "File is required" });
      }

      const buffer = await data.toBuffer();
      const filename = data.filename;
      const mimeType = data.mimetype || "application/octet-stream";

      const folderIdField = data.fields.folderId;
      const folderId =
        folderIdField && typeof folderIdField === "object" && "value" in folderIdField
          ? String(folderIdField.value)
          : null;

      const isBaseField = data.fields.isBaseDocument;
      const isBaseDocument =
        isBaseField && typeof isBaseField === "object" && "value" in isBaseField
          ? String(isBaseField.value) === "true"
          : false;

      const categoryField = data.fields.baseDocCategory;
      const baseDocCategory =
        categoryField && typeof categoryField === "object" && "value" in categoryField
          ? String(categoryField.value) || null
          : null;

      if (isBaseDocument && !canUploadBaseDocument(role)) {
        return reply.code(403).send({
          error: "forbidden",
          message: "Only workspace admins and senior reviewers can upload base documents",
        });
      }

      if (!folderId) {
        return reply.code(400).send({ error: "validation_error", message: "folderId is required" });
      }

      const [folder] = await db
        .select()
        .from(folders)
        .where(and(eq(folders.id, folderId), isNull(folders.deletedAt)))
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

      const documentId = crypto.randomUUID();
      const storageKey = buildStorageKey(request.workspaceId!, documentId, filename);
      const upload = await uploadObject(storageKey, buffer, mimeType);
      const sourceType = inferSourceType(filename, mimeType);
      const title = filename.replace(/\.[^.]+$/, "") || filename;

      const [document] = await db
        .insert(documents)
        .values({
          id: documentId,
          workspaceId: request.workspaceId!,
          folderId,
          isBaseDocument,
          baseDocCategory: isBaseDocument ? baseDocCategory : null,
          title,
          sourceType,
          originalFilename: filename,
          storageUri: upload.storageUri,
          fileSizeBytes: upload.fileSizeBytes,
          mimeType,
          checksumSha256: upload.checksumSha256,
          processingStatus: "queued",
          uploadedBy: userId,
        })
        .returning();

      return reply.code(202).send({
        documentId: document.id,
        status: document.processingStatus,
        createdAt: document.createdAt.toISOString(),
      });
    },
  );

  fastify.get<{ Params: { documentId: string } }>(
    "/api/v1/documents/:documentId",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;

      const rows = await db.execute<Parameters<typeof formatDocumentRow>[0]>(sql`
        WITH ${authorizedFoldersCte(userId, role)}
        SELECT
          d.id,
          d.workspace_id,
          d.folder_id,
          d.title,
          d.original_filename,
          d.is_base_document,
          d.base_doc_category,
          d.supersedes_doc_id,
          d.source_type::text,
          d.processing_status::text,
          d.processing_error,
          d.tags,
          d.file_size_bytes,
          d.mime_type,
          d.uploaded_by,
          d.published_at,
          d.created_at,
          d.updated_at,
          COALESCE(af.access_level, 'write') AS access_level
        FROM documents d
        LEFT JOIN folders f ON f.id = d.folder_id
        LEFT JOIN authorized_folders af ON af.id = f.id
        WHERE d.id = ${request.params.documentId}::uuid
          AND d.deleted_at IS NULL
          AND (d.folder_id IS NULL OR af.id IS NOT NULL)
        LIMIT 1
      `);

      const row = rows[0];
      if (!row) {
        return reply.code(404).send({ error: "not_found", message: "Document not found" });
      }

      return reply.send({ document: formatDocumentRow(row) });
    },
  );

  fastify.patch<{ Params: { documentId: string }; Body: UpdateDocumentBody }>(
    "/api/v1/documents/:documentId",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;

      const [existing] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, request.params.documentId), isNull(documents.deletedAt)))
        .limit(1);

      if (!existing) {
        return reply.code(404).send({ error: "not_found", message: "Document not found" });
      }

      if (existing.publishedAt && existing.isBaseDocument) {
        return reply.code(403).send({
          error: "forbidden",
          message: "Published base documents are immutable",
        });
      }

      if (existing.folderId) {
        const [folder] = await db
          .select()
          .from(folders)
          .where(eq(folders.id, existing.folderId))
          .limit(1);

        if (folder) {
          try {
            await assertFolderWriteAccess(db, folder.path, userId, role);
          } catch (err) {
            if (err instanceof FolderAccessError) {
              return reply.code(403).send({ error: "forbidden", message: err.message });
            }
            throw err;
          }
        }
      }

      const { title, tags, isBaseDocument, baseDocCategory } = request.body ?? {};

      if (isBaseDocument === true && !canUploadBaseDocument(role)) {
        return reply.code(403).send({
          error: "forbidden",
          message: "Only workspace admins and senior reviewers can mark base documents",
        });
      }

      const updates: Partial<typeof documents.$inferInsert> = { updatedAt: new Date() };
      if (title?.trim()) updates.title = title.trim();
      if (tags !== undefined) updates.tags = tags;
      if (isBaseDocument !== undefined) {
        updates.isBaseDocument = isBaseDocument;
        if (!isBaseDocument) updates.baseDocCategory = null;
      }
      if (baseDocCategory !== undefined && (isBaseDocument ?? existing.isBaseDocument)) {
        updates.baseDocCategory = baseDocCategory;
      }

      const [updated] = await db
        .update(documents)
        .set(updates)
        .where(eq(documents.id, existing.id))
        .returning();

      return reply.send({
        document: {
          id: updated.id,
          folderId: updated.folderId,
          title: updated.title,
          originalFilename: updated.originalFilename,
          isBaseDocument: updated.isBaseDocument,
          baseDocCategory: updated.baseDocCategory,
          supersedesDocId: updated.supersedesDocId,
          sourceType: updated.sourceType,
          processingStatus: updated.processingStatus,
          processingError: updated.processingError,
          tags: updated.tags,
          fileSizeBytes: updated.fileSizeBytes,
          mimeType: updated.mimeType,
          uploadedBy: updated.uploadedBy,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
        },
      });
    },
  );

  fastify.post<{ Params: { documentId: string }; Body: MoveDocumentBody }>(
    "/api/v1/documents/:documentId/move",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;
      const { targetFolderId } = request.body ?? {};

      if (!targetFolderId) {
        return reply.code(400).send({
          error: "validation_error",
          message: "targetFolderId is required",
        });
      }

      const [existing] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, request.params.documentId), isNull(documents.deletedAt)))
        .limit(1);

      if (!existing) {
        return reply.code(404).send({ error: "not_found", message: "Document not found" });
      }

      if (existing.publishedAt && existing.isBaseDocument) {
        return reply.code(403).send({
          error: "forbidden",
          message: "Published base documents cannot be moved",
        });
      }

      const [sourceFolder] = existing.folderId
        ? await db.select().from(folders).where(eq(folders.id, existing.folderId)).limit(1)
        : [null];

      const [targetFolder] = await db
        .select()
        .from(folders)
        .where(and(eq(folders.id, targetFolderId), isNull(folders.deletedAt)))
        .limit(1);

      if (!targetFolder) {
        return reply.code(404).send({ error: "not_found", message: "Target folder not found" });
      }

      if (sourceFolder) {
        try {
          await assertFolderWriteAccess(db, sourceFolder.path, userId, role);
        } catch (err) {
          if (err instanceof FolderAccessError) {
            return reply.code(403).send({ error: "forbidden", message: err.message });
          }
          throw err;
        }
      }

      try {
        await assertFolderWriteAccess(db, targetFolder.path, userId, role);
      } catch (err) {
        if (err instanceof FolderAccessError) {
          return reply.code(403).send({ error: "forbidden", message: err.message });
        }
        throw err;
      }

      const [moved] = await db
        .update(documents)
        .set({ folderId: targetFolderId, updatedAt: new Date() })
        .where(eq(documents.id, existing.id))
        .returning();

      return reply.send({
        document: {
          id: moved.id,
          folderId: moved.folderId,
          title: moved.title,
        },
      });
    },
  );

  fastify.post<{ Params: { documentId: string } }>(
    "/api/v1/documents/:documentId/publish",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;

      if (!canUploadBaseDocument(role)) {
        return reply.code(403).send({
          error: "forbidden",
          message: "Only workspace admins and senior reviewers can publish base documents",
        });
      }

      const [existing] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, request.params.documentId), isNull(documents.deletedAt)))
        .limit(1);

      if (!existing?.isBaseDocument) {
        return reply.code(400).send({
          error: "validation_error",
          message: "Document is not a base document",
        });
      }

      if (existing.publishedAt) {
        return reply.code(400).send({
          error: "validation_error",
          message: "Base document is already published",
        });
      }

      const [updated] = await db
        .update(documents)
        .set({ publishedAt: new Date(), updatedAt: new Date() })
        .where(eq(documents.id, existing.id))
        .returning();

      return reply.send({
        document: {
          id: updated.id,
          publishedAt: updated.publishedAt!.toISOString(),
        },
      });
    },
  );

  fastify.post<{ Params: { documentId: string } }>(
    "/api/v1/documents/:documentId/supersede",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;
      const { documentId } = request.params;

      if (!canUploadBaseDocument(role)) {
        return reply.code(403).send({
          error: "forbidden",
          message: "Only workspace admins and senior reviewers can supersede base documents",
        });
      }

      const data = await request.file();
      if (!data) {
        return reply.code(400).send({ error: "validation_error", message: "File is required" });
      }

      const [prior] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
        .limit(1);

      if (!prior?.isBaseDocument) {
        return reply.code(400).send({
          error: "validation_error",
          message: "Prior document is not a base document",
        });
      }

      if (!prior.publishedAt) {
        await db
          .update(documents)
          .set({ publishedAt: new Date(), updatedAt: new Date() })
          .where(eq(documents.id, prior.id));
      }

      const buffer = await data.toBuffer();
      const filename = data.filename;
      const mimeType = data.mimetype || "application/octet-stream";
      const newDocumentId = crypto.randomUUID();
      const storageKey = buildStorageKey(request.workspaceId!, newDocumentId, filename);
      const upload = await uploadObject(storageKey, buffer, mimeType);

      const [created] = await db
        .insert(documents)
        .values({
          id: newDocumentId,
          workspaceId: request.workspaceId!,
          folderId: prior.folderId,
          isBaseDocument: true,
          baseDocCategory: prior.baseDocCategory,
          supersedesDocId: prior.id,
          title: prior.title,
          sourceType: inferSourceType(filename, mimeType),
          originalFilename: filename,
          storageUri: upload.storageUri,
          fileSizeBytes: upload.fileSizeBytes,
          mimeType,
          checksumSha256: upload.checksumSha256,
          processingStatus: "queued",
          uploadedBy: userId,
        })
        .returning();

      return reply.code(202).send({
        documentId: created.id,
        supersedesDocId: prior.id,
        status: created.processingStatus,
        createdAt: created.createdAt.toISOString(),
      });
    },
  );

  fastify.delete<{ Params: { documentId: string } }>(
    "/api/v1/documents/:documentId",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;

      const [existing] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, request.params.documentId), isNull(documents.deletedAt)))
        .limit(1);

      if (!existing) {
        return reply.code(404).send({ error: "not_found", message: "Document not found" });
      }

      if (existing.publishedAt && existing.isBaseDocument) {
        return reply.code(403).send({
          error: "forbidden",
          message: "Published base documents cannot be deleted",
        });
      }

      if (existing.folderId) {
        const [folder] = await db
          .select()
          .from(folders)
          .where(eq(folders.id, existing.folderId))
          .limit(1);

        if (folder) {
          try {
            await assertFolderWriteAccess(db, folder.path, userId, role);
          } catch (err) {
            if (err instanceof FolderAccessError) {
              return reply.code(403).send({ error: "forbidden", message: err.message });
            }
            throw err;
          }
        }
      }

      const purgeAt = computeTrashPurgeAt();

      await db
        .update(documents)
        .set({ deletedAt: new Date(), purgeAt, updatedAt: new Date() })
        .where(eq(documents.id, existing.id));

      return reply.code(204).send();
    },
  );

  fastify.post<{ Params: { documentId: string } }>(
    "/api/v1/documents/:documentId/restore",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;

      const [existing] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, request.params.documentId))
        .limit(1);

      if (!existing?.deletedAt) {
        return reply.code(404).send({ error: "not_found", message: "Trashed document not found" });
      }

      if (existing.folderId) {
        const [folder] = await db
          .select()
          .from(folders)
          .where(eq(folders.id, existing.folderId))
          .limit(1);

        if (folder?.deletedAt) {
          return reply.code(400).send({
            error: "validation_error",
            message: "Restore the parent folder first",
          });
        }

        if (folder) {
          try {
            await assertFolderWriteAccess(db, folder.path, userId, role);
          } catch (err) {
            if (err instanceof FolderAccessError) {
              return reply.code(403).send({ error: "forbidden", message: err.message });
            }
            throw err;
          }
        }
      }

      await db
        .update(documents)
        .set({ deletedAt: null, purgeAt: null, updatedAt: new Date() })
        .where(eq(documents.id, existing.id));

      return reply.code(204).send();
    },
  );

  fastify.get(
    "/api/v1/trash",
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;

      const trashedFolders = await db.execute<{
        id: string;
        name: string;
        deleted_at: string;
      }>(sql`
        WITH ${authorizedFoldersCte(userId, role, { includeDeleted: true })}
        SELECT f.id, f.name, f.deleted_at
        FROM folders f
        INNER JOIN authorized_folders af ON af.id = f.id
        WHERE f.deleted_at IS NOT NULL
          AND f.parent_id IS NOT NULL
        ORDER BY f.deleted_at DESC
      `);

      const trashedDocs = await db.execute<{
        id: string;
        title: string;
        deleted_at: string;
        purge_at: string | null;
      }>(sql`
        WITH ${authorizedFoldersCte(userId, role, { includeDeleted: true })}
        SELECT d.id, d.title, d.deleted_at, d.purge_at
        FROM documents d
        LEFT JOIN folders f ON f.id = d.folder_id
        LEFT JOIN authorized_folders af ON af.id = f.id
        WHERE d.deleted_at IS NOT NULL
          AND (d.folder_id IS NULL OR af.id IS NOT NULL)
        ORDER BY d.deleted_at DESC
      `);

      const items = [
        ...trashedFolders.map((f) => ({
          id: f.id,
          type: "folder" as const,
          name: f.name,
          deletedAt: f.deleted_at,
          purgeAt: null,
        })),
        ...trashedDocs.map((d) => ({
          id: d.id,
          type: "document" as const,
          name: d.title,
          deletedAt: d.deleted_at,
          purgeAt: d.purge_at,
        })),
      ].sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime());

      return reply.send({ items });
    },
  );
}
