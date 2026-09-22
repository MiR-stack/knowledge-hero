import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@rag/db";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../app.js";
import { signAccessToken } from "../lib/jwt.js";
import { resetPublicSchema, seedWorkspaceWithDocument } from "./helpers.js";

const directUrl = process.env.DATABASE_URL ?? "postgresql://rag:rag@localhost:5434/rag";
const pgbouncerUrl =
  process.env.PGBOUNCER_URL ?? "postgresql://rag_app:rag_app@localhost:6432/rag";

describe("tenant isolation through PgBouncer transaction pooling", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let workspaceA: Awaited<ReturnType<typeof seedWorkspaceWithDocument>>;
  let workspaceB: Awaited<ReturnType<typeof seedWorkspaceWithDocument>>;
  let tokenA: string;

  beforeAll(async () => {
    process.env.PGBOUNCER_URL = pgbouncerUrl;
    process.env.JWT_SECRET = "test-secret";

    const adminDb = createDb(directUrl, { prepare: false, max: 1 });
    await resetPublicSchema(adminDb);

    const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../../../packages/db/drizzle");
    await migrate(adminDb, { migrationsFolder });
    await adminDb.$client.end();

    const seedDb = createDb(directUrl, { prepare: false, max: 1 });
    workspaceA = await seedWorkspaceWithDocument(seedDb, {
      email: "alice@example.com",
      password: "password-a-123",
      fullName: "Alice Admin",
      workspaceName: "Workspace A",
      workspaceSlug: "workspace-a",
      documentTitle: "Document A",
    });

    workspaceB = await seedWorkspaceWithDocument(seedDb, {
      email: "bob@example.com",
      password: "password-b-123",
      fullName: "Bob Admin",
      workspaceName: "Workspace B",
      workspaceSlug: "workspace-b",
      documentTitle: "Document B",
    });
    await seedDb.$client.end();

    app = await buildApp();
    tokenA = await signAccessToken({ sub: workspaceA.userId, email: workspaceA.email });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it("returns a document belonging to the authenticated workspace", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${workspaceA.documentId}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        "x-workspace-id": workspaceA.workspaceId,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      document: {
        id: workspaceA.documentId,
        workspaceId: workspaceA.workspaceId,
        title: "Document A",
      },
    });
  });

  it("never reads a row from another workspace in the same request", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${workspaceB.documentId}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        "x-workspace-id": workspaceA.workspaceId,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "not_found" });
  });

  it("does not leak workspace B rows after a prior workspace B request on the pooled connection", async () => {
    const tokenB = await signAccessToken({ sub: workspaceB.userId, email: workspaceB.email });

    const primePool = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${workspaceB.documentId}`,
      headers: {
        authorization: `Bearer ${tokenB}`,
        "x-workspace-id": workspaceB.workspaceId,
      },
    });
    expect(primePool.statusCode).toBe(200);
    expect(primePool.json()).toMatchObject({
      document: { id: workspaceB.documentId, workspaceId: workspaceB.workspaceId },
    });

    const crossTenant = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${workspaceB.documentId}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        "x-workspace-id": workspaceA.workspaceId,
      },
    });

    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json()).toMatchObject({ error: "not_found" });
  });
});
