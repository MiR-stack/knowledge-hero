import { eq } from 'drizzle-orm';
import { documentChunks } from '@rag/db';
import type { Db } from '@rag/db';
import type { ChunkerResult } from '../chunking/chunker.js';
import type { SpreadsheetChunk } from '../chunking/spreadsheet-chunker.js';
import crypto from 'node:crypto';

export interface ChunkWriterInput {
  documentId: string;
  workspaceId: string;
  sourceType: string;
  documentTitle: string;
  folderPath?: string | null;
  isBaseDocument: boolean;
  baseDocCategory?: string | null;
  tags: string[];
  documentVersion: number;
  chunkerResult: ChunkerResult | null;       // null for spreadsheets
  spreadsheetChunks: SpreadsheetChunk[] | null; // null for non-spreadsheets
  embeddings: number[][];  // one per child/spreadsheet chunk, in order
  createdAt: Date;
}

export async function writeChunks(db: Db, input: ChunkWriterInput): Promise<void> {
  const {
    documentId, workspaceId, sourceType, documentTitle,
    folderPath, isBaseDocument, baseDocCategory, tags, documentVersion,
    chunkerResult, spreadsheetChunks, embeddings, createdAt,
  } = input;

  await db.transaction(async (tx) => {
    // FR-3.6: Delete existing chunks for this document transactionally
    await tx.delete(documentChunks).where(eq(documentChunks.documentId, documentId));

    if (chunkerResult) {
      // Text-based document: insert parents first, then children
      const parentRows: typeof documentChunks.$inferInsert[] = [];
      const parentIdMap = new Map<number, string>(); // parentChunkIndex -> DB id

      // Build parent chunk rows
      for (const parent of chunkerResult.parents) {
        const parentId = crypto.randomUUID();
        parentIdMap.set(parent.chunkIndex, parentId);
        parentRows.push({
          id: parentId,
          documentId,
          workspaceId,
          parentChunkId: null,
          chunkIndex: parent.chunkIndex, // negative integer
          content: parent.content,
          tokenCount: parent.tokenCount,
          embedding: null, // parents are NOT embedded — only children are
          metadata: {
            chunk_id: parentId,
            document_id: documentId,
            workspace_id: workspaceId,
            is_base_document: isBaseDocument,
            base_doc_category: baseDocCategory ?? null,
            folder_path: folderPath ?? null,
            source_type: sourceType,
            document_title: documentTitle,
            chunk_index: parent.chunkIndex,
            parent_chunk_id: null,
            tags,
            document_version: documentVersion,
            created_at: createdAt.toISOString(),
          },
        });
      }

      if (parentRows.length > 0) {
        await tx.insert(documentChunks).values(parentRows);
      }

      // Build child chunk rows
      const children = chunkerResult.children;
      const childRows: typeof documentChunks.$inferInsert[] = children.map((child, i) => {
        const childId = crypto.randomUUID();
        // Each child belongs to a parent: parent covers every 3 children
        const parentGroupIndex = Math.floor(i / 3);
        const parentChunkIndex = -(parentGroupIndex + 1);
        const parentId = parentIdMap.get(parentChunkIndex) ?? null;
        return {
          id: childId,
          documentId,
          workspaceId,
          parentChunkId: parentId,
          chunkIndex: child.chunkIndex,
          content: child.content,
          tokenCount: child.tokenCount,
          embedding: embeddings[i] ?? null,
          metadata: {
            chunk_id: childId,
            document_id: documentId,
            workspace_id: workspaceId,
            is_base_document: isBaseDocument,
            base_doc_category: baseDocCategory ?? null,
            folder_path: folderPath ?? null,
            source_type: sourceType,
            document_title: documentTitle,
            page_number: child.metadata.pageNumber ?? null,
            bounding_box: child.metadata.boundingBox ?? null,
            section_heading: child.metadata.sectionHeading ?? null,
            chunk_index: child.chunkIndex,
            parent_chunk_id: parentId,
            tags,
            document_version: documentVersion,
            created_at: createdAt.toISOString(),
          } satisfies Record<string, unknown>,
        };
      });

      if (childRows.length > 0) {
        // Insert in batches of 100 to avoid param limits
        for (let i = 0; i < childRows.length; i += 100) {
          await tx.insert(documentChunks).values(childRows.slice(i, i + 100));
        }
      }
    } else if (spreadsheetChunks) {
      // Spreadsheet: each sheet chunk is a standalone child (no parent)
      const rows: typeof documentChunks.$inferInsert[] = spreadsheetChunks.map((chunk, i) => {
        const chunkId = crypto.randomUUID();
        return {
          id: chunkId,
          documentId,
          workspaceId,
          parentChunkId: null,
          chunkIndex: i,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
          embedding: embeddings[i] ?? null,
          metadata: {
            chunk_id: chunkId,
            document_id: documentId,
            workspace_id: workspaceId,
            is_base_document: isBaseDocument,
            base_doc_category: baseDocCategory ?? null,
            folder_path: folderPath ?? null,
            source_type: sourceType,
            document_title: documentTitle,
            sheet_name: chunk.metadata.sheetName,
            row_range: chunk.metadata.rowRange,
            column_range: chunk.metadata.columnRange ?? null,
            chunk_index: i,
            parent_chunk_id: null,
            tags,
            document_version: documentVersion,
            created_at: createdAt.toISOString(),
          } satisfies Record<string, unknown>,
        };
      });

      for (let i = 0; i < rows.length; i += 100) {
        await tx.insert(documentChunks).values(rows.slice(i, i + 100));
      }
    }
  });
}
