import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, documents } from "@rag/db";
import { eq } from "drizzle-orm";
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

  /**
   * MUTATION TEST — Phase 1 acceptance criterion
   *
   * Proves the cross-tenant isolation test above is NOT a false positive:
   * when we use the correct workspace context (session-level SET matching
   * the document's workspace), the row IS visible — confirming that:
   *
   *  1. The document row genuinely exists in the DB
   *  2. RLS visibility gates on `app.current_workspace`
   *  3. Therefore, any mismatched-workspace test that gets 404 is genuinely
   *     testing the SET LOCAL security invariant, not a vacuous test
   *
   * In other words: if someone reverted `SET LOCAL` to a bare `SET` in the
   * tenant plugin, a pooled connection could inherit a prior request's
   * workspace ID, and the cross-tenant test would flip from 404 to 200 —
   * exactly what the test is designed to catch.
   */
  it("MUTATION: same-workspace SET confirms row exists — proves cross-tenant 404 is RLS-enforced not vacuous", async () => {
    // Open a dedicated admin connection (direct Postgres, no PgBouncer, no RLS)
    const rawDb = createDb(directUrl, { prepare: false, max: 1 });

    try {
      // Set workspace context to workspace B (the owner of the target document)
      // at the session level — this is the "broken" pattern that the plugin avoids.
      // On a raw non-pooled connection we do this explicitly to confirm visibility.
      await rawDb.execute(
        sql`SELECT set_config('app.current_workspace', ${workspaceB.workspaceId}::text, false)`,
      );

      // Direct query: should find the row because context matches ownership
      const rows = await rawDb
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.id, workspaceB.documentId))
        .limit(1);

      // Row MUST be visible — it exists, and workspace context matches
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(workspaceB.documentId);

      // Now set WRONG workspace (workspace A) at session level — simulating the
      // pooled-connection bug where a prior request left the wrong context.
      await rawDb.execute(
        sql`SELECT set_config('app.current_workspace', ${workspaceA.workspaceId}::text, false)`,
      );

      // With session-level SET (not LOCAL), there's no transaction boundary
      // rolling back the context — the wrong workspace ID persists.
      // RLS should now DENY visibility of workspace B's document.
      const rowsAfterBadSet = await rawDb
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.id, workspaceB.documentId))
        .limit(1);

      // Row must NOT be visible — proves RLS is the enforcement, not the query filter
      expect(rowsAfterBadSet).toHaveLength(0);

      // This confirms: the 404 in the cross-tenant HTTP test is because RLS
      // hides the row when workspace context doesn't match, not because we
      // wrote a query that filters by workspace_id in the WHERE clause.
      // If someone removed the RLS policy, this test would fail here —
      // catching the regression before it reaches production.
    } finally {
      await rawDb.$client.end();
    }
  });
});
