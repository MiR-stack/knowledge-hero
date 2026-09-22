import { createPostgresClient } from "@rag/db";
import { config } from "../config.js";
import { deleteObject } from "../lib/storage.js";

interface PurgeDocumentRow {
  id: string;
  storage_uri: string;
  workspace_id: string;
}

export async function purgeExpiredTrash(): Promise<{ documents: number; folders: number }> {
  const sql = createPostgresClient(config.databaseUrl, { max: 2 });
  let purgedDocuments = 0;
  let purgedFolders = 0;

  try {
    const expiredDocs = await sql<PurgeDocumentRow[]>`
      SELECT id, storage_uri, workspace_id
      FROM documents
      WHERE deleted_at IS NOT NULL
        AND purge_at IS NOT NULL
        AND purge_at <= now()
    `;

    for (const doc of expiredDocs) {
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_workspace', ${doc.workspace_id}::text, true)`;
        await tx`DELETE FROM document_chunks WHERE document_id = ${doc.id}::uuid`;
        await tx`DELETE FROM documents WHERE id = ${doc.id}::uuid`;
      });

      try {
        await deleteObject(doc.storage_uri);
      } catch (err) {
        console.warn(`[purge] Failed to delete S3 object ${doc.storage_uri}:`, err);
      }

      purgedDocuments++;
    }

    const retentionCutoff = new Date();
    retentionCutoff.setDate(retentionCutoff.getDate() - config.drive.trashRetentionDays);

    const expiredFolders = await sql<{ id: string; workspace_id: string; path: string }[]>`
      SELECT id, workspace_id, path::text AS path
      FROM folders
      WHERE deleted_at IS NOT NULL
        AND parent_id IS NOT NULL
        AND deleted_at <= ${retentionCutoff.toISOString()}::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM documents d
          WHERE d.folder_id IN (
            SELECT f2.id FROM folders f2 WHERE f2.path <@ folders.path
          )
          AND d.deleted_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM documents d
          WHERE d.folder_id IN (
            SELECT f2.id FROM folders f2 WHERE f2.path <@ folders.path
          )
          AND d.deleted_at IS NOT NULL
          AND (d.purge_at IS NULL OR d.purge_at > now())
        )
    `;

    for (const folder of expiredFolders) {
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_workspace', ${folder.workspace_id}::text, true)`;
        await tx`DELETE FROM folder_permissions WHERE folder_id IN (
          SELECT id FROM folders WHERE path <@ ${folder.path}::ltree
        )`;
        await tx`DELETE FROM folders WHERE path <@ ${folder.path}::ltree AND deleted_at IS NOT NULL`;
      });
      purgedFolders++;
    }

    return { documents: purgedDocuments, folders: purgedFolders };
  } finally {
    await sql.end();
  }
}

export async function runPurgeJob(): Promise<void> {
  console.log("[purge] Starting trash purge job...");
  try {
    const result = await purgeExpiredTrash();
    console.log(
      `[purge] Completed — ${result.documents} document(s), ${result.folders} folder tree(s) hard-deleted`,
    );
  } catch (err) {
    console.error("[purge] Job failed:", err);
    throw err;
  }
}
