import { sql } from "drizzle-orm";
import type { DocumentSummary } from "@rag/shared-types";
import type { DbTransaction } from "@rag/db";
import { authorizedFoldersCte } from "./folder-permissions.js";

export function formatDocumentRow(row: {
  id: string;
  workspace_id?: string;
  folder_id: string | null;
  title: string;
  original_filename: string;
  is_base_document: boolean;
  base_doc_category: string | null;
  supersedes_doc_id: string | null;
  source_type: string;
  processing_status: string;
  processing_error: string | null;
  tags: string[];
  file_size_bytes: number | null;
  mime_type: string | null;
  uploaded_by: string;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  access_level?: string;
}): DocumentSummary & { publishedAt: string | null } {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    folderId: row.folder_id,
    title: row.title,
    originalFilename: row.original_filename,
    isBaseDocument: row.is_base_document,
    baseDocCategory: row.base_doc_category,
    supersedesDocId: row.supersedes_doc_id,
    sourceType: row.source_type as DocumentSummary["sourceType"],
    processingStatus: row.processing_status as DocumentSummary["processingStatus"],
    processingError: row.processing_error,
    tags: row.tags ?? [],
    fileSizeBytes: row.file_size_bytes,
    mimeType: row.mime_type,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    accessLevel: (row.access_level as DocumentSummary["accessLevel"]) ?? "write",
  };
}

type DocumentRow = Parameters<typeof formatDocumentRow>[0];

/** List documents in a folder, joined against authorized_folders (FR-1.3). */
export async function listAuthorizedDocumentsInFolder(
  tx: DbTransaction,
  userId: string,
  role: string,
  folderId: string,
): Promise<Array<DocumentSummary & { publishedAt: string | null }>> {
  const rows = await tx.execute<DocumentRow>(sql`
    WITH ${authorizedFoldersCte(userId, role as import("@rag/shared-types").UserRole)}
    SELECT
      d.id,
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
      af.access_level
    FROM documents d
    INNER JOIN folders f ON f.id = d.folder_id
    INNER JOIN authorized_folders af ON af.id = f.id
    WHERE d.folder_id = ${folderId}::uuid
      AND d.deleted_at IS NULL
    ORDER BY d.title
  `);

  return rows.map(formatDocumentRow);
}

/** Search documents with access-filtered query (FR-1.3). */
export async function searchAuthorizedDocuments(
  tx: DbTransaction,
  userId: string,
  role: string,
  query: string,
  options?: { tags?: string[]; folderId?: string },
): Promise<Array<DocumentSummary & { publishedAt: string | null }>> {
  const tagFilter =
    options?.tags && options.tags.length > 0
      ? sql`AND d.tags && ${options.tags}::text[]`
      : sql``;
  const folderFilter = options?.folderId
    ? sql`AND d.folder_id = ${options.folderId}::uuid`
    : sql``;
  const pattern = `%${query.replace(/[%_\\]/g, "\\$&")}%`;

  const rows = await tx.execute<DocumentRow>(sql`
    WITH ${authorizedFoldersCte(userId, role as import("@rag/shared-types").UserRole)}
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
    INNER JOIN folders f ON f.id = d.folder_id
    INNER JOIN authorized_folders af ON af.id = f.id
    WHERE d.deleted_at IS NULL
      AND (
        d.title ILIKE ${pattern}
        OR d.original_filename ILIKE ${pattern}
        OR EXISTS (SELECT 1 FROM unnest(d.tags) t WHERE t ILIKE ${pattern})
      )
      ${tagFilter}
      ${folderFilter}
    ORDER BY d.updated_at DESC
    LIMIT 100
  `);

  return rows.map(formatDocumentRow);
}
