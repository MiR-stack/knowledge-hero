import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { scopes, scopeDocuments, scopeFolders, scopeShares } from '@rag/db';
import { syncOrAsyncRecompute } from '../lib/scope-resolver.js';

interface CreateScopeBody {
  name: string;
  description?: string;
}

interface UpdateScopeBody {
  name?: string;
  description?: string;
}

interface AddFolderBody {
  folderId: string;
  includeSubtree?: boolean;
}

interface AddDocumentBody {
  documentId: string;
}

interface ShareScopeBody {
  userId: string;
  canEdit: boolean;
}

export async function scopeRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: CreateScopeBody }>(
    '/api/v1/scopes',
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const { name, description } = request.body ?? {};

      if (!name?.trim()) {
        return reply.code(400).send({ error: 'validation_error', message: 'Name is required' });
      }

      const [scope] = await db
        .insert(scopes)
        .values({
          workspaceId: request.workspaceId!,
          name: name.trim(),
          description: description?.trim(),
          ownerId: request.userId!,
        })
        .returning();

      return reply.code(201).send({
        scope: {
          id: scope.id,
          name: scope.name,
          description: scope.description,
          isShared: scope.isShared,
          ownerId: scope.ownerId,
          createdAt: scope.createdAt.toISOString(),
          resolvedDocCount: 0,
        },
      });
    }
  );

  fastify.get(
    '/api/v1/scopes',
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;

      const isWorkspaceAdmin = role === 'workspace_admin';

      const results = await db.execute<{
        id: string;
        name: string;
        description: string;
        is_shared: boolean;
        owner_id: string;
        created_at: string;
        resolved_doc_count: number;
      }>(sql`
        SELECT s.id, s.name, s.description, s.is_shared, s.owner_id, s.created_at,
          (SELECT COUNT(*) FROM scope_resolved_documents srd WHERE srd.scope_id = s.id) as resolved_doc_count
        FROM scopes s
        LEFT JOIN scope_shares ss ON ss.scope_id = s.id AND ss.user_id = ${userId}::uuid
        WHERE s.workspace_id = ${request.workspaceId!}::uuid
          AND s.archived_at IS NULL
          AND (${isWorkspaceAdmin} OR s.owner_id = ${userId}::uuid OR ss.user_id IS NOT NULL)
        ORDER BY s.created_at DESC
      `);

      return reply.send({
        scopes: results.map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description,
          isShared: row.is_shared,
          ownerId: row.owner_id,
          createdAt: row.created_at,
          resolvedDocCount: Number(row.resolved_doc_count),
        })),
      });
    }
  );

  fastify.get<{ Params: { scopeId: string } }>(
    '/api/v1/scopes/:scopeId',
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;
      const isWorkspaceAdmin = role === 'workspace_admin';
      const scopeId = request.params.scopeId;

      const results = await db.execute<{
        id: string;
        name: string;
        description: string;
        is_shared: boolean;
        owner_id: string;
        created_at: string;
        resolved_doc_count: number;
        can_edit: boolean;
      }>(sql`
        SELECT s.id, s.name, s.description, s.is_shared, s.owner_id, s.created_at,
          (SELECT COUNT(*) FROM scope_resolved_documents srd WHERE srd.scope_id = s.id) as resolved_doc_count,
          COALESCE(ss.can_edit, false) as can_edit
        FROM scopes s
        LEFT JOIN scope_shares ss ON ss.scope_id = s.id AND ss.user_id = ${userId}::uuid
        WHERE s.workspace_id = ${request.workspaceId!}::uuid
          AND s.id = ${scopeId}::uuid
          AND s.archived_at IS NULL
          AND (${isWorkspaceAdmin} OR s.owner_id = ${userId}::uuid OR ss.user_id IS NOT NULL)
        LIMIT 1
      `);

      const row = results[0];
      if (!row) {
        return reply.code(404).send({ error: 'not_found', message: 'Scope not found' });
      }

      const folderRows = await db.execute<{ folder_id: string; include_subtree: boolean; added_at: string }>(sql`
        SELECT folder_id, include_subtree, added_at
        FROM scope_folders
        WHERE scope_id = ${scopeId}::uuid
      `);

      const docRows = await db.execute<{ document_id: string; added_at: string }>(sql`
        SELECT document_id, added_at
        FROM scope_documents
        WHERE scope_id = ${scopeId}::uuid
      `);

      const shareRows = await db.execute<{ user_id: string; can_edit: boolean; shared_at: string }>(sql`
        SELECT user_id, can_edit, shared_at
        FROM scope_shares
        WHERE scope_id = ${scopeId}::uuid
      `);

      return reply.send({
        scope: {
          id: row.id,
          name: row.name,
          description: row.description,
          isShared: row.is_shared,
          ownerId: row.owner_id,
          createdAt: row.created_at,
          resolvedDocCount: Number(row.resolved_doc_count),
          folders: folderRows.map(f => ({ folderId: f.folder_id, includeSubtree: f.include_subtree, addedAt: f.added_at })),
          documents: docRows.map(d => ({ documentId: d.document_id, addedAt: d.added_at })),
          shares: shareRows.map(s => ({ userId: s.user_id, canEdit: s.can_edit, sharedAt: s.shared_at })),
        },
      });
    }
  );

  fastify.put<{ Params: { scopeId: string }; Body: UpdateScopeBody }>(
    '/api/v1/scopes/:scopeId',
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;
      const isWorkspaceAdmin = role === 'workspace_admin';
      const scopeId = request.params.scopeId;
      const { name, description } = request.body ?? {};

      const [scope] = await db.select().from(scopes).where(eq(scopes.id, scopeId)).limit(1);
      if (!scope || scope.archivedAt) {
        return reply.code(404).send({ error: 'not_found', message: 'Scope not found' });
      }

      const canEdit = isWorkspaceAdmin || scope.ownerId === userId || (await db.select().from(scopeShares).where(and(eq(scopeShares.scopeId, scopeId), eq(scopeShares.userId, userId), eq(scopeShares.canEdit, true))).limit(1)).length > 0;
      if (!canEdit) {
        return reply.code(403).send({ error: 'forbidden', message: 'Not authorized to edit' });
      }

      const [updated] = await db.update(scopes)
        .set({
          name: name?.trim() ?? scope.name,
          description: description !== undefined ? description.trim() : scope.description,
          updatedAt: new Date(),
        })
        .where(eq(scopes.id, scopeId))
        .returning();

      return reply.send({ scope: updated });
    }
  );

  fastify.delete<{ Params: { scopeId: string } }>(
    '/api/v1/scopes/:scopeId',
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;
      const isWorkspaceAdmin = role === 'workspace_admin';
      const scopeId = request.params.scopeId;

      const [scope] = await db.select().from(scopes).where(eq(scopes.id, scopeId)).limit(1);
      if (!scope || scope.archivedAt) {
        return reply.code(404).send({ error: 'not_found', message: 'Scope not found' });
      }

      if (!isWorkspaceAdmin && scope.ownerId !== userId) {
        return reply.code(403).send({ error: 'forbidden', message: 'Only owner or admin can archive scope' });
      }

      await db.update(scopes)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(eq(scopes.id, scopeId));

      return reply.code(204).send();
    }
  );

  fastify.post<{ Params: { scopeId: string }; Body: AddDocumentBody }>(
    '/api/v1/scopes/:scopeId/documents',
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;
      const isWorkspaceAdmin = role === 'workspace_admin';
      const scopeId = request.params.scopeId;
      const { documentId } = request.body ?? {};

      if (!documentId) return reply.code(400).send({ error: 'validation_error', message: 'documentId required' });

      const [scope] = await db.select().from(scopes).where(eq(scopes.id, scopeId)).limit(1);
      if (!scope || scope.archivedAt) return reply.code(404).send({ error: 'not_found', message: 'Scope not found' });

      const canEdit = isWorkspaceAdmin || scope.ownerId === userId || (await db.select().from(scopeShares).where(and(eq(scopeShares.scopeId, scopeId), eq(scopeShares.userId, userId), eq(scopeShares.canEdit, true))).limit(1)).length > 0;
      if (!canEdit) return reply.code(403).send({ error: 'forbidden', message: 'Not authorized to edit' });

      await db.insert(scopeDocuments).values({ scopeId, documentId }).onConflictDoNothing();

      await syncOrAsyncRecompute(scopeId, request.workspaceId!, fastify.adminDb);
      return reply.code(201).send({ success: true });
    }
  );

  fastify.delete<{ Params: { scopeId: string; documentId: string } }>(
    '/api/v1/scopes/:scopeId/documents/:documentId',
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;
      const isWorkspaceAdmin = role === 'workspace_admin';
      const { scopeId, documentId } = request.params;

      const [scope] = await db.select().from(scopes).where(eq(scopes.id, scopeId)).limit(1);
      if (!scope || scope.archivedAt) return reply.code(404).send({ error: 'not_found', message: 'Scope not found' });

      const canEdit = isWorkspaceAdmin || scope.ownerId === userId || (await db.select().from(scopeShares).where(and(eq(scopeShares.scopeId, scopeId), eq(scopeShares.userId, userId), eq(scopeShares.canEdit, true))).limit(1)).length > 0;
      if (!canEdit) return reply.code(403).send({ error: 'forbidden', message: 'Not authorized to edit' });

      await db.delete(scopeDocuments).where(and(eq(scopeDocuments.scopeId, scopeId), eq(scopeDocuments.documentId, documentId)));

      await syncOrAsyncRecompute(scopeId, request.workspaceId!, fastify.adminDb);
      return reply.code(204).send();
    }
  );

  fastify.post<{ Params: { scopeId: string }; Body: AddFolderBody }>(
    '/api/v1/scopes/:scopeId/folders',
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;
      const isWorkspaceAdmin = role === 'workspace_admin';
      const scopeId = request.params.scopeId;
      const { folderId, includeSubtree = true } = request.body ?? {};

      if (!folderId) return reply.code(400).send({ error: 'validation_error', message: 'folderId required' });

      const [scope] = await db.select().from(scopes).where(eq(scopes.id, scopeId)).limit(1);
      if (!scope || scope.archivedAt) return reply.code(404).send({ error: 'not_found', message: 'Scope not found' });

      const canEdit = isWorkspaceAdmin || scope.ownerId === userId || (await db.select().from(scopeShares).where(and(eq(scopeShares.scopeId, scopeId), eq(scopeShares.userId, userId), eq(scopeShares.canEdit, true))).limit(1)).length > 0;
      if (!canEdit) return reply.code(403).send({ error: 'forbidden', message: 'Not authorized to edit' });

      await db.insert(scopeFolders).values({ scopeId, folderId, includeSubtree }).onConflictDoNothing();

      await syncOrAsyncRecompute(scopeId, request.workspaceId!, fastify.adminDb);
      return reply.code(201).send({ success: true });
    }
  );

  fastify.delete<{ Params: { scopeId: string; folderId: string } }>(
    '/api/v1/scopes/:scopeId/folders/:folderId',
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;
      const isWorkspaceAdmin = role === 'workspace_admin';
      const { scopeId, folderId } = request.params;

      const [scope] = await db.select().from(scopes).where(eq(scopes.id, scopeId)).limit(1);
      if (!scope || scope.archivedAt) return reply.code(404).send({ error: 'not_found', message: 'Scope not found' });

      const canEdit = isWorkspaceAdmin || scope.ownerId === userId || (await db.select().from(scopeShares).where(and(eq(scopeShares.scopeId, scopeId), eq(scopeShares.userId, userId), eq(scopeShares.canEdit, true))).limit(1)).length > 0;
      if (!canEdit) return reply.code(403).send({ error: 'forbidden', message: 'Not authorized to edit' });

      await db.delete(scopeFolders).where(and(eq(scopeFolders.scopeId, scopeId), eq(scopeFolders.folderId, folderId)));

      await syncOrAsyncRecompute(scopeId, request.workspaceId!, fastify.adminDb);
      return reply.code(204).send();
    }
  );

  fastify.post<{ Params: { scopeId: string }; Body: ShareScopeBody }>(
    '/api/v1/scopes/:scopeId/shares',
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;
      const isWorkspaceAdmin = role === 'workspace_admin';
      const scopeId = request.params.scopeId;
      const { userId: targetUserId, canEdit } = request.body ?? {};

      if (!targetUserId) return reply.code(400).send({ error: 'validation_error', message: 'userId required' });

      const [scope] = await db.select().from(scopes).where(eq(scopes.id, scopeId)).limit(1);
      if (!scope || scope.archivedAt) return reply.code(404).send({ error: 'not_found', message: 'Scope not found' });

      const canShare = isWorkspaceAdmin || scope.ownerId === userId;
      if (!canShare) return reply.code(403).send({ error: 'forbidden', message: 'Only owner or admin can share' });

      await db.insert(scopeShares).values({ scopeId, userId: targetUserId, canEdit })
        .onConflictDoUpdate({ target: [scopeShares.scopeId, scopeShares.userId], set: { canEdit } });

      await db.update(scopes).set({ isShared: true }).where(eq(scopes.id, scopeId));

      return reply.code(201).send({ success: true });
    }
  );

  fastify.delete<{ Params: { scopeId: string; userId: string } }>(
    '/api/v1/scopes/:scopeId/shares/:userId',
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const userId = request.userId!;
      const role = request.workspaceRole!;
      const isWorkspaceAdmin = role === 'workspace_admin';
      const { scopeId, userId: targetUserId } = request.params;

      const [scope] = await db.select().from(scopes).where(eq(scopes.id, scopeId)).limit(1);
      if (!scope || scope.archivedAt) return reply.code(404).send({ error: 'not_found', message: 'Scope not found' });

      const canShare = isWorkspaceAdmin || scope.ownerId === userId;
      if (!canShare) return reply.code(403).send({ error: 'forbidden', message: 'Only owner or admin can modify shares' });

      await db.delete(scopeShares).where(and(eq(scopeShares.scopeId, scopeId), eq(scopeShares.userId, targetUserId)));

      const [remaining] = await db.select().from(scopeShares).where(eq(scopeShares.scopeId, scopeId)).limit(1);
      if (!remaining) {
        await db.update(scopes).set({ isShared: false }).where(eq(scopes.id, scopeId));
      }

      return reply.code(204).send();
    }
  );
}
