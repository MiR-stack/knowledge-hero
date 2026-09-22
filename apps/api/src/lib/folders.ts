import { sql } from "drizzle-orm";
import type { DbTransaction } from "@rag/db";
import { folders } from "@rag/db";
import { buildChildPath, pathDepth } from "./ltree.js";
import { config } from "../config.js";

export async function ensureRootFolder(
  tx: DbTransaction,
  workspaceId: string,
  userId: string,
): Promise<{ id: string; path: string }> {
  const existing = await tx.execute<{ id: string; path: string }>(sql`
    SELECT id, path::text AS path
    FROM folders
    WHERE workspace_id = ${workspaceId}::uuid
      AND parent_id IS NULL
      AND deleted_at IS NULL
    LIMIT 1
  `);

  if (existing[0]) {
    return existing[0];
  }

  const [folder] = await tx
    .insert(folders)
    .values({
      workspaceId,
      parentId: null,
      name: "Root",
      path: "root",
      createdBy: userId,
    })
    .returning({ id: folders.id, path: folders.path });

  return { id: folder.id, path: folder.path };
}

export async function resolveBreadcrumbs(
  tx: DbTransaction,
  folderPath: string,
): Promise<Array<{ id: string; name: string; path: string }>> {
  const rows = await tx.execute<{ id: string; name: string; path: string }>(sql`
    SELECT f.id, f.name, f.path::text AS path
    FROM folders f
    WHERE f.path @> ${folderPath}::ltree
      AND f.deleted_at IS NULL
    ORDER BY nlevel(f.path)
  `);

  return rows;
}

export async function assertFolderWriteAccess(
  tx: DbTransaction,
  folderPath: string,
  userId: string,
  role: string,
): Promise<void> {
  const [row] = await tx.execute<{ access_level: string }>(sql`
    SELECT COALESCE(
      (
        SELECT fp.access_level
        FROM folders ancestor
        INNER JOIN folder_permissions fp ON fp.folder_id = ancestor.id
          AND (fp.user_id = ${userId}::uuid OR fp.role = ${role})
        WHERE ancestor.path @> ${folderPath}::ltree
          AND ancestor.deleted_at IS NULL
        ORDER BY nlevel(ancestor.path) DESC, (fp.user_id IS NOT NULL) DESC
        LIMIT 1
      ),
      ${role === "read_only_client" ? "read" : "write"}
    ) AS access_level
  `);

  if (!row || row.access_level !== "write") {
    throw new FolderAccessError("Write access denied for this folder");
  }
}

export class FolderAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FolderAccessError";
  }
}

export async function validateFolderDepth(parentPath: string | null): Promise<void> {
  const depth = parentPath ? pathDepth(parentPath) : 0;
  if (depth >= config.drive.maxFolderDepth) {
    throw new FolderDepthError(
      `Maximum folder depth of ${config.drive.maxFolderDepth} exceeded`,
    );
  }
}

export class FolderDepthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FolderDepthError";
  }
}

export function computeTrashPurgeAt(): Date {
  const purgeAt = new Date();
  purgeAt.setDate(purgeAt.getDate() + config.drive.trashRetentionDays);
  return purgeAt;
}

export { buildChildPath };
