import { sql } from "drizzle-orm";
import {
  createDb,
  documents,
  users,
  workspaceMembers,
  workspaceRateLimits,
  workspaces,
  type Db,
} from "@rag/db";

export interface SeedWorkspaceResult {
  userId: string;
  workspaceId: string;
  documentId: string;
  email: string;
  password: string;
}

export async function seedWorkspaceWithDocument(
  db: Db,
  input: {
    email: string;
    password: string;
    fullName: string;
    workspaceName: string;
    workspaceSlug: string;
    documentTitle: string;
  },
): Promise<SeedWorkspaceResult> {
  const argon2 = await import("argon2");
  const passwordHash = await argon2.default.hash(input.password);

  const [user] = await db
    .insert(users)
    .values({
      email: input.email,
      fullName: input.fullName,
      passwordHash,
    })
    .returning({ id: users.id });

  const [workspace] = await db
    .insert(workspaces)
    .values({
      name: input.workspaceName,
      slug: input.workspaceSlug,
    })
    .returning({ id: workspaces.id });

  await db.insert(workspaceMembers).values({
    workspaceId: workspace.id,
    userId: user.id,
    role: "workspace_admin",
  });

  await db.insert(workspaceRateLimits).values({
    workspaceId: workspace.id,
  });

  const documentId = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.current_workspace', ${workspace.id}::text, true)`,
    );

    const [document] = await tx
      .insert(documents)
      .values({
        workspaceId: workspace.id,
        title: input.documentTitle,
        sourceType: "pdf_native",
        originalFilename: `${input.documentTitle}.pdf`,
        storageUri: `s3://test/${input.workspaceSlug}/${input.documentTitle}.pdf`,
        uploadedBy: user.id,
      })
      .returning({ id: documents.id });

    return document.id;
  });

  return {
    userId: user.id,
    workspaceId: workspace.id,
    documentId,
    email: input.email,
    password: input.password,
  };
}

export async function resetPublicSchema(db: Db): Promise<void> {
  await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await db.execute(sql`CREATE SCHEMA public`);
  await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
}
