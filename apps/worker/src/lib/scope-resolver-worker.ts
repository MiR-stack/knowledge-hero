import { sql } from 'drizzle-orm';
import type { Db } from '@rag/db';

/** SRS §4.3 target: median propagation < 5s */
const PROPAGATION_WARN_MS = 5_000;

export async function recomputeScope(scopeId: string, workspaceId: string, db: Db): Promise<void> {
  const startedAt = Date.now();

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

  const elapsedMs = Date.now() - startedAt;
  const level = elapsedMs > PROPAGATION_WARN_MS ? 'WARN' : 'INFO';
  const msg = `[scope-propagation] ${level}: scope=${scopeId} workspace=${workspaceId} recompute_ms=${elapsedMs} mode=async-full`;
  if (level === 'WARN') {
    console.warn(`${msg} — exceeds ${PROPAGATION_WARN_MS}ms target`);
  } else {
    console.log(msg);
  }
}
