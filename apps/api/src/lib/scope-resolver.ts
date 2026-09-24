import { sql } from 'drizzle-orm';
import type { Db, DbTransaction } from '@rag/db';
import { enqueueScopeResolution } from './scope-redis.js';

/** Target from SRS §4.3 — median propagation delay must be < 5s */
const PROPAGATION_WARN_MS = 5_000;

/**
 * Log scope propagation timing.
 * Emits a WARN if the delay exceeds the 5s target from FR-4.6 / §4.3.
 */
function logPropagation(documentId: string, workspaceId: string, elapsedMs: number): void {
  const level = elapsedMs > PROPAGATION_WARN_MS ? 'WARN' : 'INFO';
  const msg = `[scope-propagation] ${level}: document=${documentId} workspace=${workspaceId} propagation_ms=${elapsedMs}`;
  if (level === 'WARN') {
    console.warn(`${msg} — exceeds ${PROPAGATION_WARN_MS}ms target`);
  } else {
    console.log(msg);
  }
}

export async function countResolvedDocs(scopeId: string, db: Db | DbTransaction): Promise<number> {
  const result = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int as count FROM scope_resolved_documents WHERE scope_id = ${scopeId}::uuid
  `);
  return result[0]?.count ?? 0;
}

export async function recomputeScope(scopeId: string, workspaceId: string, db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM scope_resolved_documents WHERE scope_id = ${scopeId}::uuid`);
    
    await tx.execute(sql`
      INSERT INTO scope_resolved_documents (scope_id, document_id, resolved_at)
      SELECT DISTINCT ${scopeId}::uuid, d.id, now()
      FROM documents d
      WHERE d.workspace_id = ${workspaceId}::uuid 
        AND d.deleted_at IS NULL
        AND d.processing_status = 'indexed'
        AND (
          EXISTS (
            SELECT 1 FROM scope_documents sd 
            WHERE sd.scope_id = ${scopeId}::uuid AND sd.document_id = d.id
          )
          OR
          EXISTS (
            SELECT 1 FROM scope_folders sf
            JOIN folders f ON f.id = d.folder_id
            WHERE sf.scope_id = ${scopeId}::uuid
            AND (
              (sf.include_subtree = true AND f.path <@ (SELECT path FROM folders WHERE id = sf.folder_id))
              OR
              (sf.include_subtree = false AND d.folder_id = sf.folder_id)
            )
          )
        )
    `);
  });
}

export async function syncOrAsyncRecompute(
  scopeId: string,
  workspaceId: string,
  db: Db
): Promise<{ mode: 'sync' | 'async' }> {
  const count = await countResolvedDocs(scopeId, db);
  if (count < 1000) {
    await recomputeScope(scopeId, workspaceId, db);
    return { mode: 'sync' };
  } else {
    await enqueueScopeResolution(scopeId, workspaceId);
    return { mode: 'async' };
  }
}

export async function onDocumentAddedToFolder(
  documentId: string,
  folderId: string | null,
  workspaceId: string,
  db: Db
): Promise<void> {
  const startedAt = Date.now();

  await db.execute(sql`
    INSERT INTO scope_resolved_documents (scope_id, document_id, resolved_at)
    SELECT sd.scope_id, ${documentId}::uuid, now()
    FROM scope_documents sd
    JOIN scopes s ON s.id = sd.scope_id
    WHERE sd.document_id = ${documentId}::uuid AND s.workspace_id = ${workspaceId}::uuid
    ON CONFLICT DO NOTHING
  `);

  if (!folderId) {
    const propagationMs = Date.now() - startedAt;
    logPropagation(documentId, workspaceId, propagationMs);
    return;
  }

  const folderResult = await db.execute<{ path: string }>(sql`
    SELECT path::text FROM folders WHERE id = ${folderId}::uuid LIMIT 1
  `);
  
  if (!folderResult[0]) {
    const propagationMs = Date.now() - startedAt;
    logPropagation(documentId, workspaceId, propagationMs);
    return;
  }
  const folderPath = folderResult[0].path;

  await db.execute(sql`
    INSERT INTO scope_resolved_documents (scope_id, document_id, resolved_at)
    SELECT sf.scope_id, ${documentId}::uuid, now()
    FROM scope_folders sf
    JOIN scopes s ON s.id = sf.scope_id
    WHERE s.workspace_id = ${workspaceId}::uuid
    AND (
      (sf.include_subtree = true AND ${folderPath}::ltree <@ (SELECT path FROM folders WHERE id = sf.folder_id))
      OR
      (sf.include_subtree = false AND sf.folder_id = ${folderId}::uuid)
    )
    ON CONFLICT DO NOTHING
  `);

  const propagationMs = Date.now() - startedAt;
  logPropagation(documentId, workspaceId, propagationMs);
}

export async function onDocumentRemovedFromFolder(
  documentId: string,
  workspaceId: string,
  db: Db
): Promise<void> {
  await db.execute(sql`
    DELETE FROM scope_resolved_documents srd
    WHERE srd.document_id = ${documentId}::uuid
      AND srd.scope_id NOT IN (
        SELECT sd.scope_id FROM scope_documents sd WHERE sd.document_id = ${documentId}::uuid
      )
      AND EXISTS (
        SELECT 1 FROM scopes s 
        WHERE s.id = srd.scope_id AND s.workspace_id = ${workspaceId}::uuid
      )
  `);
}
