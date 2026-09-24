/**
 * Integration tests for Phase 3 ingestion events:
 *   - GET /api/v1/documents/:documentId/status  (polling endpoint, uses tenant plugin)
 *   - GET /api/v1/documents/:documentId/events  (SSE streaming endpoint, manual auth)
 *
 * Uses live Postgres + PgBouncer + Redis from docker-compose.
 * The state machine is driven directly via adminDb writes + Redis publishes
 * so we don't need to run the full worker.
 *
 * Required env (defaults match docker-compose):
 *   DATABASE_URL   = postgresql://rag:rag@localhost:5434/rag
 *   PGBOUNCER_URL  = postgresql://rag_app:rag_app@localhost:6432/rag
 *   REDIS_URL      = redis://localhost:6379
 *   JWT_SECRET     = test-secret
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, documents, workspaces, users, workspaceMembers, workspaceRateLimits } from "@rag/db";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import { buildApp } from "../app.js";
import { signAccessToken } from "../lib/jwt.js";
import { resetPublicSchema } from "./helpers.js";

const directUrl =
  process.env.DATABASE_URL ?? "postgresql://rag:rag@localhost:5434/rag";
const pgbouncerUrl =
  process.env.PGBOUNCER_URL ??
  "postgresql://rag_app:rag_app@localhost:6432/rag";
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

// ─────────────────────────────────────────────────────────────────────────────
// Shared setup — one schema reset + migration + seed for all suites in this file
// ─────────────────────────────────────────────────────────────────────────────

let app: Awaited<ReturnType<typeof buildApp>>;
let redisPublisher: Redis;

/** Main test workspace: used for all happy-path tests. */
let wsId: string;
let userId: string;
let userEmail: string;
let docId: string;
let token: string;

/** Second document in same workspace (used to test cross-doc 404). */
let otherWsId: string;
let otherDocId: string;

beforeAll(async () => {
  process.env.PGBOUNCER_URL = pgbouncerUrl;
  process.env.DATABASE_URL = directUrl;
  process.env.JWT_SECRET = "test-secret";
  process.env.REDIS_URL = redisUrl;

  // 1. Reset + migrate schema
  const adminDb = createDb(directUrl, { prepare: false, max: 1 });
  await resetPublicSchema(adminDb);
  const migrationsFolder = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../packages/db/drizzle",
  );
  await migrate(adminDb, { migrationsFolder });

  // 2. Seed primary workspace
  const argon2 = await import("argon2");
  const hash = await argon2.default.hash("pass-ingestion-123");

  const [user] = await adminDb
    .insert(users)
    .values({ email: "ingestion@example.com", fullName: "Ingestion User", passwordHash: hash })
    .returning({ id: users.id });

  const [ws] = await adminDb
    .insert(workspaces)
    .values({ name: "Ingestion Workspace", slug: "ingestion-ws-events" })
    .returning({ id: workspaces.id });

  await adminDb.insert(workspaceMembers).values({
    workspaceId: ws.id, userId: user.id, role: "workspace_admin",
  });
  await adminDb.insert(workspaceRateLimits).values({ workspaceId: ws.id });

  const [doc] = await adminDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.current_workspace', ${ws.id}::text, true)`,
    );
    return tx.insert(documents).values({
      workspaceId: ws.id,
      title: "Ingestion Test Document",
      sourceType: "pdf_native",
      originalFilename: "test.pdf",
      storageUri: `s3://test/${ws.id}/test.pdf`,
      uploadedBy: user.id,
      processingStatus: "queued",
    }).returning({ id: documents.id });
  });

  // 3. Seed second (isolated) workspace for cross-tenant 404 test
  const [otherWs] = await adminDb
    .insert(workspaces)
    .values({ name: "Other Workspace", slug: "other-ws-events" })
    .returning({ id: workspaces.id });

  await adminDb.insert(workspaceRateLimits).values({ workspaceId: otherWs.id });

  const [otherDoc] = await adminDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.current_workspace', ${otherWs.id}::text, true)`,
    );
    return tx.insert(documents).values({
      workspaceId: otherWs.id,
      title: "Other Document",
      sourceType: "pdf_native",
      originalFilename: "other.pdf",
      storageUri: `s3://test/${otherWs.id}/other.pdf`,
      uploadedBy: user.id,
      processingStatus: "queued",
    }).returning({ id: documents.id });
  });

  await adminDb.$client.end();

  wsId = ws.id;
  userId = user.id;
  userEmail = "ingestion@example.com";
  docId = doc.id;
  otherWsId = otherWs.id;
  otherDocId = otherDoc.id;
  token = await signAccessToken({ sub: userId, email: userEmail });

  // 4. Build Fastify app + Redis publisher
  app = await buildApp();
  redisPublisher = new Redis(redisUrl, { maxRetriesPerRequest: null });
}, 120_000);

afterAll(async () => {
  await redisPublisher?.quit();
  await app?.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Polling status endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/v1/documents/:id/status — polling endpoint", () => {
  it("returns 200 with queued status for a freshly uploaded document", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${docId}/status`,
      headers: {
        authorization: `Bearer ${token}`,
        "x-workspace-id": wsId,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.documentId).toBe(docId);
    expect(body.status).toBe("queued");
    expect(body.progressPct).toBe(0);
    expect(body.stagesCompleted).toEqual([]);
    expect(body.currentStage).toBe("queued");
    expect(body.error).toBeNull();
  });

  it("returns 401 without auth token", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${docId}/status`,
      headers: { "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 without X-Workspace-Id header", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${docId}/status`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it("returns 404 for a document belonging to a different workspace", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${otherDocId}/status`,
      headers: {
        authorization: `Bearer ${token}`,
        "x-workspace-id": wsId,
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "not_found" });
  });

  it("returns updated status after worker transitions document to extracting", async () => {
    // Simulate the worker: update the document status directly via adminDb inside workspace context
    const adminDb = createDb(directUrl, { prepare: false, max: 1 });
    await adminDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.current_workspace', ${wsId}::text, true)`,
      );
      await tx
        .update(documents)
        .set({ processingStatus: "extracting", updatedAt: new Date() })
        .where(eq(documents.id, docId));
    });
    await adminDb.$client.end();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${docId}/status`,
      headers: {
        authorization: `Bearer ${token}`,
        "x-workspace-id": wsId,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("extracting");
    expect(body.progressPct).toBe(20);
    expect(body.stagesCompleted).toEqual(["queued"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SSE streaming endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/v1/documents/:id/events — SSE endpoint", () => {
  it("responds with 401 when Authorization header is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${docId}/events`,
      headers: { "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(401);
  });

  it("responds with 401 for an invalid Bearer token", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${docId}/events`,
      headers: {
        authorization: "Bearer this.is.invalid",
        "x-workspace-id": wsId,
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("responds with 400 when X-Workspace-Id is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${docId}/events`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "missing_workspace" });
  });

  it("responds with 403 when user is not a member of the requested workspace", async () => {
    // Use the correct token but request a workspace the user doesn't belong to
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${docId}/events`,
      headers: {
        authorization: `Bearer ${token}`,
        "x-workspace-id": otherWsId, // user is NOT a member of otherWs
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "forbidden" });
  });

  it("responds with 404 for a document that doesn't belong to the workspace", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${otherDocId}/events`,
      headers: {
        authorization: `Bearer ${token}`,
        "x-workspace-id": wsId, // user IS a member of wsId, but otherDocId is in otherWsId
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("immediately closes SSE stream for a document already in terminal 'indexed' state", async () => {
    // Set to indexed via adminDb inside workspace context
    const adminDb = createDb(directUrl, { prepare: false, max: 1 });
    await adminDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.current_workspace', ${wsId}::text, true)`,
      );
      await tx
        .update(documents)
        .set({ processingStatus: "indexed", updatedAt: new Date() })
        .where(eq(documents.id, docId));
    });
    await adminDb.$client.end();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${docId}/events`,
      headers: {
        authorization: `Bearer ${token}`,
        "x-workspace-id": wsId,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("status_update");
    expect(res.body).toContain('"status":"indexed"');
  });

  it("SSE streams a Redis-published status update and closes on terminal event", async () => {
    // Reset to queued so the SSE stays open
    const adminDb = createDb(directUrl, { prepare: false, max: 1 });
    await adminDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.current_workspace', ${wsId}::text, true)`,
      );
      await tx
        .update(documents)
        .set({ processingStatus: "queued", updatedAt: new Date() })
        .where(eq(documents.id, docId));
    });
    await adminDb.$client.end();

    const publishPayload = JSON.stringify({
      documentId: docId,
      status: "indexed",
      progressPct: 100,
      error: null,
      updatedAt: new Date().toISOString(),
    });

    // Publish after 300ms so the SSE route can subscribe to Redis first
    const publishTimer = setTimeout(async () => {
      await redisPublisher.publish(
        `ingestion:events:doc:${docId}`,
        publishPayload,
      );
    }, 300);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${docId}/events`,
      headers: {
        authorization: `Bearer ${token}`,
        "x-workspace-id": wsId,
      },
    });

    clearTimeout(publishTimer);

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    // Body must contain both the initial queued event and the published indexed event
    expect(res.body).toContain("status_update");
    expect(res.body).toContain('"status":"indexed"');
  }, 10_000);
});
