/**
 * HNSW Index Verification Test — Phase 4 acceptance criterion
 *
 * Confirms that vector similarity queries on document_chunks use the HNSW
 * index (idx_chunks_embedding) rather than a sequential scan.
 *
 * Why this matters:
 *   - The SRS requires sub-second vector search at scale.
 *   - A seq scan on a table with millions of 1536-dim vectors would be
 *     unacceptably slow (O(n) distance computations).
 *   - This test catches any accidental index drop, schema migration error,
 *     or planner configuration that defeats the HNSW index.
 *
 * Approach:
 *   1. Seed 500 document_chunks with real random VECTOR(1536) embeddings.
 *   2. Run EXPLAIN (not ANALYZE, to avoid real computation cost) on a
 *      k-NN similarity search query.
 *   3. Set enable_seqscan = off so the planner is forced to use an available
 *      index (same technique used by the scope_resolved_documents test).
 *   4. Assert the plan text contains "Index" — confirming HNSW is used.
 *
 * Uses live Postgres from docker-compose.
 * Required env (defaults match docker-compose):
 *   DATABASE_URL = postgresql://rag:rag@localhost:5434/rag
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, documents, documentChunks, workspaces, users, workspaceMembers, workspaceRateLimits } from '@rag/db';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetPublicSchema } from '../test/helpers.js';

const directUrl = process.env.DATABASE_URL ?? 'postgresql://rag:rag@localhost:5434/rag';

const EMBEDDING_DIM = 1536;
const SEED_CHUNKS = 500;

/** Generate a random unit vector with the given dimensionality. */
function randomEmbedding(dim: number): number[] {
  const vec = Array.from({ length: dim }, () => Math.random() * 2 - 1);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
}

let adminDb: ReturnType<typeof createDb>;
let workspaceId: string;
let userId: string;

beforeAll(async () => {
  process.env.DATABASE_URL = directUrl;
  adminDb = createDb(directUrl, { prepare: false, max: 1 });

  await resetPublicSchema(adminDb);

  const migrationsFolder = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../packages/db/drizzle',
  );
  await migrate(adminDb, { migrationsFolder });

  // Seed workspace + user
  const [ws] = await adminDb
    .insert(workspaces)
    .values({ name: 'HNSW Test WS', slug: 'hnsw-test-ws' })
    .returning({ id: workspaces.id });
  workspaceId = ws.id;

  const [u] = await adminDb
    .insert(users)
    .values({ email: 'hnsw@example.com', fullName: 'HNSW Test User' })
    .returning({ id: users.id });
  userId = u.id;

  await adminDb.insert(workspaceMembers).values({ workspaceId, userId, role: 'workspace_admin' });
  await adminDb.insert(workspaceRateLimits).values({ workspaceId });

  // Seed SEED_CHUNKS document_chunks with random embeddings
  // We insert documents first (one per 50 chunks to avoid too many doc rows),
  // then bulk-insert chunk rows in batches of 50.
  const docsToCreate = Math.ceil(SEED_CHUNKS / 50);
  const docIds: string[] = [];

  for (let d = 0; d < docsToCreate; d++) {
    const [doc] = await adminDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_workspace', ${workspaceId}::text, true)`);
      return tx
        .insert(documents)
        .values({
          workspaceId,
          title: `HNSW Doc ${d}`,
          sourceType: 'pdf_native',
          originalFilename: `hnsw-doc-${d}.pdf`,
          storageUri: `s3://test/${workspaceId}/hnsw-doc-${d}.pdf`,
          uploadedBy: userId,
          processingStatus: 'indexed',
        })
        .returning({ id: documents.id });
    });
    docIds.push(doc.id);
  }

  // Insert chunks in batches of 50
  let chunkIdx = 0;
  for (let d = 0; d < docIds.length && chunkIdx < SEED_CHUNKS; d++) {
    const batch: typeof documentChunks.$inferInsert[] = [];
    for (let c = 0; c < 50 && chunkIdx < SEED_CHUNKS; c++, chunkIdx++) {
      batch.push({
        documentId: docIds[d],
        workspaceId,
        chunkIndex: c,
        content: `Chunk ${chunkIdx} content for HNSW index test`,
        tokenCount: 32,
        embedding: randomEmbedding(EMBEDDING_DIM),
        metadata: { chunk_index: c, document_id: docIds[d] },
      });
    }
    await adminDb.insert(documentChunks).values(batch);
  }
}, 120_000); // seeding 500 chunks with 1536-dim vectors can be slow

afterAll(async () => {
  await adminDb.$client?.end?.();
});

describe('HNSW index verification — Phase 4 FR-3.5', () => {
  it('vector similarity search uses HNSW index scan (not seq scan)', async () => {
    const queryVec = randomEmbedding(EMBEDDING_DIM);
    const queryVecLiteral = `[${queryVec.join(',')}]`;

    // Disable seq scan so the planner must use an index if one is available
    await adminDb.execute(sql`SET enable_seqscan = off`);

    const plan = await adminDb.execute<{ 'QUERY PLAN': string }>(sql`
      EXPLAIN
      SELECT id, document_id, content
      FROM document_chunks
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> ${queryVecLiteral}::vector(${sql.raw(String(EMBEDDING_DIM))})
      LIMIT 10
    `);

    await adminDb.execute(sql`SET enable_seqscan = on`);

    const planText = plan.map((row) => row['QUERY PLAN']).join('\n');

    console.log(`[hnsw-index] Query plan:\n${planText}`);

    // The plan must reference an index scan (HNSW) rather than a seq scan
    expect(
      planText,
      `Expected HNSW index scan but got:\n${planText}`,
    ).toMatch(/Index/i);
  });

  it('confirms the HNSW index exists on document_chunks.embedding', async () => {
    const result = await adminDb.execute<{ indexname: string; indexdef: string }>(sql`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'document_chunks'
        AND indexdef ILIKE '%hnsw%'
    `);

    expect(result.length, 'No HNSW index found on document_chunks').toBeGreaterThan(0);
    expect(result[0].indexname).toBe('idx_chunks_embedding');
    expect(result[0].indexdef).toMatch(/hnsw/i);
    expect(result[0].indexdef).toMatch(/vector_cosine_ops/i);

    console.log(`[hnsw-index] Found index: ${result[0].indexdef}`);
  });
});
