/**
 * Integration tests for Phase 5 Dynamic Scoping Engine:
 *   - Scope CRUD routes
 *   - Tenant isolation
 *   - Document membership → scope_resolved_documents
 *   - Folder membership + incremental propagation
 *   - EXPLAIN index-scan verification on scope_resolved_documents
 *
 * Uses live Postgres + PgBouncer + Redis from docker-compose.
 * Required env (defaults match docker-compose):
 *   DATABASE_URL   = postgresql://rag:rag@localhost:5434/rag
 *   PGBOUNCER_URL  = postgresql://rag_app:rag_app@localhost:6432/rag
 *   REDIS_URL      = redis://localhost:6379
 *   JWT_SECRET     = test-secret
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, documents, workspaces, users, workspaceMembers, workspaceRateLimits, folders } from '@rag/db';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../app.js';
import { signAccessToken } from '../lib/jwt.js';
import { resetPublicSchema } from './helpers.js';
import { closeRedisConnections } from '../lib/redis.js';

const directUrl = process.env.DATABASE_URL ?? 'postgresql://rag:rag@localhost:5434/rag';
const pgbouncerUrl = process.env.PGBOUNCER_URL ?? 'postgresql://rag_app:rag_app@localhost:6432/rag';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

// ─────────────────────────────────────────────────────────────────────────────
// Shared setup — one reset + migrate + seed for all suites
// ─────────────────────────────────────────────────────────────────────────────

let app: Awaited<ReturnType<typeof buildApp>>;
let adminDb: ReturnType<typeof createDb>;

// Workspace A — primary
let wsIdA: string;
let userIdA: string;
let tokenA: string;

// Workspace B — for tenant isolation tests
let wsIdB: string;
let userIdB: string;
let tokenB: string;

beforeAll(async () => {
  process.env.PGBOUNCER_URL = pgbouncerUrl;
  process.env.DATABASE_URL = directUrl;
  process.env.JWT_SECRET = 'test-secret';
  process.env.REDIS_URL = redisUrl;

  // 1. Reset + migrate
  adminDb = createDb(directUrl, { prepare: false, max: 1 });
  await resetPublicSchema(adminDb);
  const migrationsFolder = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../packages/db/drizzle',
  );
  await migrate(adminDb, { migrationsFolder });

  // 2. Build app
  app = await buildApp();
  await app.ready();

  const argon2 = await import('argon2');

  // ── Workspace A ──────────────────────────────────────────────────────────
  const hashA = await argon2.default.hash('password-scope-a');
  const [uA] = await adminDb.insert(users)
    .values({ email: 'scope-a@example.com', fullName: 'Scope User A', passwordHash: hashA })
    .returning({ id: users.id });
  userIdA = uA.id;

  const [wA] = await adminDb.insert(workspaces)
    .values({ name: 'Scope Workspace A', slug: 'scope-ws-a' })
    .returning({ id: workspaces.id });
  wsIdA = wA.id;

  await adminDb.insert(workspaceMembers).values({ workspaceId: wsIdA, userId: userIdA, role: 'workspace_admin' });
  await adminDb.insert(workspaceRateLimits).values({ workspaceId: wsIdA });

  tokenA = await signAccessToken({ userId: userIdA, workspaceId: wsIdA, role: 'workspace_admin' });

  // ── Workspace B ──────────────────────────────────────────────────────────
  const hashB = await argon2.default.hash('password-scope-b');
  const [uB] = await adminDb.insert(users)
    .values({ email: 'scope-b@example.com', fullName: 'Scope User B', passwordHash: hashB })
    .returning({ id: users.id });
  userIdB = uB.id;

  const [wB] = await adminDb.insert(workspaces)
    .values({ name: 'Scope Workspace B', slug: 'scope-ws-b' })
    .returning({ id: workspaces.id });
  wsIdB = wB.id;

  await adminDb.insert(workspaceMembers).values({ workspaceId: wsIdB, userId: userIdB, role: 'workspace_admin' });
  await adminDb.insert(workspaceRateLimits).values({ workspaceId: wsIdB });

  tokenB = await signAccessToken({ userId: userIdB, workspaceId: wsIdB, role: 'workspace_admin' });
}, 30_000);

afterAll(async () => {
  await app?.close();
  await closeRedisConnections();
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Scopes Integration Tests', () => {

  it('CRUD: create, get, list, update, archive scope', async () => {
    // Create
    const resCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/scopes',
      headers: { authorization: `Bearer ${tokenA}`, 'x-workspace-id': wsIdA },
      payload: { name: 'My Research Scope', description: 'Test description' },
    });
    expect(resCreate.statusCode, resCreate.payload).toBe(201);
    const scopeId: string = resCreate.json().scope.id;
    expect(scopeId).toBeTruthy();

    // Get
    const resGet = await app.inject({
      method: 'GET',
      url: `/api/v1/scopes/${scopeId}`,
      headers: { authorization: `Bearer ${tokenA}`, 'x-workspace-id': wsIdA },
    });
    expect(resGet.statusCode).toBe(200);
    expect(resGet.json().scope.name).toBe('My Research Scope');
    expect(resGet.json().scope.resolvedDocCount).toBe(0);

    // List
    const resList = await app.inject({
      method: 'GET',
      url: '/api/v1/scopes',
      headers: { authorization: `Bearer ${tokenA}`, 'x-workspace-id': wsIdA },
    });
    expect(resList.statusCode).toBe(200);
    const listed = resList.json().scopes as any[];
    expect(listed.some((s: any) => s.id === scopeId)).toBe(true);

    // Update
    const resUpdate = await app.inject({
      method: 'PUT',
      url: `/api/v1/scopes/${scopeId}`,
      headers: { authorization: `Bearer ${tokenA}`, 'x-workspace-id': wsIdA },
      payload: { name: 'Updated Research Scope' },
    });
    expect(resUpdate.statusCode).toBe(200);
    expect(resUpdate.json().scope.name).toBe('Updated Research Scope');

    // Archive (DELETE)
    const resArchive = await app.inject({
      method: 'DELETE',
      url: `/api/v1/scopes/${scopeId}`,
      headers: { authorization: `Bearer ${tokenA}`, 'x-workspace-id': wsIdA },
    });
    expect(resArchive.statusCode).toBe(204);

    // Get after archive → 404
    const resAfter = await app.inject({
      method: 'GET',
      url: `/api/v1/scopes/${scopeId}`,
      headers: { authorization: `Bearer ${tokenA}`, 'x-workspace-id': wsIdA },
    });
    expect(resAfter.statusCode).toBe(404);
  });

  it('Tenant isolation: workspace B user cannot read workspace A scopes', async () => {
    // Create scope in workspace A
    const resCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/scopes',
      headers: { authorization: `Bearer ${tokenA}`, 'x-workspace-id': wsIdA },
      payload: { name: 'Workspace A Private Scope' },
    });
    expect(resCreate.statusCode).toBe(201);
    const scopeId: string = resCreate.json().scope.id;

    // Workspace B user tries to read it via their own workspace context → 404 (RLS hides it)
    const resGet = await app.inject({
      method: 'GET',
      url: `/api/v1/scopes/${scopeId}`,
      headers: { authorization: `Bearer ${tokenB}`, 'x-workspace-id': wsIdB },
    });
    expect(resGet.statusCode).toBe(404);

    // Workspace B list should NOT include workspace A's scope
    const resList = await app.inject({
      method: 'GET',
      url: '/api/v1/scopes',
      headers: { authorization: `Bearer ${tokenB}`, 'x-workspace-id': wsIdB },
    });
    expect(resList.statusCode).toBe(200);
    const scopeIds = (resList.json().scopes as any[]).map((s: any) => s.id);
    expect(scopeIds).not.toContain(scopeId);
  });

  it('Document membership: add doc → resolvedDocCount=1; remove doc → 0', async () => {
    // Create scope
    const scopeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/scopes',
      headers: { authorization: `Bearer ${tokenA}`, 'x-workspace-id': wsIdA },
      payload: { name: 'Doc Membership Scope' },
    });
    expect(scopeRes.statusCode).toBe(201);
    const scopeId: string = scopeRes.json().scope.id;

    // Insert a doc directly via adminDb (bypass upload)
    const [doc] = await adminDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_workspace', ${wsIdA}::text, true)`);
      return tx.insert(documents).values({
        workspaceId: wsIdA,
        title: 'Membership Test Doc',
        sourceType: 'pdf_native',
        originalFilename: 'test.pdf',
        storageUri: `s3://test/${wsIdA}/mem-test.pdf`,
        uploadedBy: userIdA,
        processingStatus: 'indexed', // must be 'indexed' to be included in resolution
      }).returning({ id: documents.id });
    });

    // Add doc to scope explicitly
    const resAdd = await app.inject({
      method: 'POST',
      url: `/api/v1/scopes/${scopeId}/documents`,
      headers: { authorization: `Bearer ${tokenA}`, 'x-workspace-id': wsIdA },
      payload: { documentId: doc.id },
    });
    expect(resAdd.statusCode, resAdd.payload).toBe(201);

    // Verify resolvedDocCount = 1
    const resGet1 = await app.inject({
      method: 'GET',
      url: `/api/v1/scopes/${scopeId}`,
      headers: { authorization: `Bearer ${tokenA}`, 'x-workspace-id': wsIdA },
    });
    expect(resGet1.json().scope.resolvedDocCount).toBe(1);

    // Remove doc from scope
    const resDel = await app.inject({
      method: 'DELETE',
      url: `/api/v1/scopes/${scopeId}/documents/${doc.id}`,
      headers: { authorization: `Bearer ${tokenA}`, 'x-workspace-id': wsIdA },
    });
    expect(resDel.statusCode).toBe(204);

    // Verify resolvedDocCount = 0
    const resGet2 = await app.inject({
      method: 'GET',
      url: `/api/v1/scopes/${scopeId}`,
      headers: { authorization: `Bearer ${tokenA}`, 'x-workspace-id': wsIdA },
    });
    expect(resGet2.json().scope.resolvedDocCount).toBe(0);
  });

  it('Folder membership: add folder → upload doc into folder → resolvedDocCount=1 (sync)', async () => {
    // Create a folder via API
    const folderRes = await app.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: { authorization: `Bearer ${tokenA}`, 'x-workspace-id': wsIdA },
      payload: { name: 'Scoped Folder' },
    });
    expect(folderRes.statusCode, folderRes.payload).toBe(201);
    const folderId: string = folderRes.json().folder.id;

    // Create scope
    const scopeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/scopes',
      headers: { authorization: `Bearer ${tokenA}`, 'x-workspace-id': wsIdA },
      payload: { name: 'Folder Scope' },
    });
    expect(scopeRes.statusCode).toBe(201);
    const scopeId: string = scopeRes.json().scope.id;

    // Add folder to scope (triggers sync recompute — 0 docs in folder yet)
    const addFolderRes = await app.inject({
      method: 'POST',
      url: `/api/v1/scopes/${scopeId}/folders`,
      headers: { authorization: `Bearer ${tokenA}`, 'x-workspace-id': wsIdA },
      payload: { folderId, includeSubtree: true },
    });
    expect(addFolderRes.statusCode, addFolderRes.payload).toBe(201);

    // Insert an indexed doc directly into the folder via adminDb + trigger onDocumentAddedToFolder
    const [doc] = await adminDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_workspace', ${wsIdA}::text, true)`);
      return tx.insert(documents).values({
        workspaceId: wsIdA,
        folderId,
        title: 'Folder Scoped Doc',
        sourceType: 'pdf_native',
        originalFilename: 'folder-doc.pdf',
        storageUri: `s3://test/${wsIdA}/folder-doc.pdf`,
        uploadedBy: userIdA,
        processingStatus: 'indexed',
      }).returning({ id: documents.id });
    });

    // Trigger the incremental hook (simulates what the upload endpoint does)
    const { onDocumentAddedToFolder } = await import('../lib/scope-resolver.js');
    await onDocumentAddedToFolder(doc.id, folderId, wsIdA, adminDb);

    // Verify resolvedDocCount = 1
    const resGet = await app.inject({
      method: 'GET',
      url: `/api/v1/scopes/${scopeId}`,
      headers: { authorization: `Bearer ${tokenA}`, 'x-workspace-id': wsIdA },
    });
    expect(resGet.json().scope.resolvedDocCount).toBe(1);
  });

  it('Query-plan: scope_resolved_documents join uses index scan (not seq scan)', async () => {
    // Seed scope_resolved_documents with 100 rows to ensure non-trivial table
    const [ws] = await adminDb.insert(workspaces)
      .values({ name: 'Plan Test WS', slug: 'plan-test-ws' })
      .returning({ id: workspaces.id });
    const [u] = await adminDb.insert(users)
      .values({ email: 'plan@example.com', fullName: 'Plan User' })
      .returning({ id: users.id });
    await adminDb.insert(workspaceMembers).values({ workspaceId: ws.id, userId: u.id, role: 'workspace_admin' });
    await adminDb.insert(workspaceRateLimits).values({ workspaceId: ws.id });

    // Create a scope directly
    const [scope] = await adminDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_workspace', ${ws.id}::text, true)`);
      const { scopes: scopesTable } = await import('@rag/db');
      return tx.insert(scopesTable).values({ workspaceId: ws.id, name: 'Plan Scope', ownerId: u.id }).returning({ id: scopesTable.id });
    });

    // Insert 100 documents + scope_resolved_documents rows
    for (let i = 0; i < 100; i++) {
      const [doc] = await adminDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_workspace', ${ws.id}::text, true)`);
        return tx.insert(documents).values({
          workspaceId: ws.id,
          title: `Plan Doc ${i}`,
          sourceType: 'pdf_native',
          originalFilename: `doc${i}.pdf`,
          storageUri: `s3://test/${ws.id}/doc${i}.pdf`,
          uploadedBy: u.id,
          processingStatus: 'indexed',
        }).returning({ id: documents.id });
      });
      const { scopeResolvedDocuments } = await import('@rag/db');
      await adminDb.insert(scopeResolvedDocuments).values({ scopeId: scope.id, documentId: doc.id });
    }

    // Disable seqscan so the planner is forced to use indexes, then verify
    const { documentChunks, scopeResolvedDocuments } = await import('@rag/db');
    await adminDb.execute(sql`SET enable_seqscan = off`);
    const plan = await adminDb.execute<{ 'QUERY PLAN': string }>(sql`
      EXPLAIN
      SELECT dc.id
      FROM document_chunks dc
      JOIN scope_resolved_documents srd ON dc.document_id = srd.document_id
      WHERE srd.scope_id = ${scope.id}::uuid
    `);
    await adminDb.execute(sql`SET enable_seqscan = on`);

    const planText = plan.map(row => row['QUERY PLAN']).join('\n');
    expect(planText, `Expected index scan but got:\n${planText}`).toMatch(/Index/i);
  });
});
