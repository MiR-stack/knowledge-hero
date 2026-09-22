import { sql } from "drizzle-orm";
import type { AccessLevel, UserRole } from "@rag/shared-types";

/** Default workspace-level access when no folder_permissions ancestor exists. */
export function defaultWorkspaceAccess(role: UserRole): AccessLevel {
  return role === "read_only_client" ? "read" : "write";
}

/**
 * SQL fragment: CTE `authorized_folders` with folders the caller may read.
 * Nearest-ancestor resolution per SRS FR-1.3 — join in queries, never post-filter.
 */
export function authorizedFoldersCte(
  userId: string,
  role: UserRole,
  options?: { includeDeleted?: boolean },
) {
  const defaultAccess = defaultWorkspaceAccess(role);
  const deletedFilter = options?.includeDeleted
    ? sql``
    : sql`AND f.deleted_at IS NULL`;

  return sql`
    authorized_folders AS (
      SELECT
        f.id,
        f.path,
        COALESCE(nearest.access_level, ${defaultAccess}) AS access_level
      FROM folders f
      LEFT JOIN LATERAL (
        SELECT fp.access_level
        FROM folders ancestor
        INNER JOIN folder_permissions fp ON fp.folder_id = ancestor.id
          AND (fp.user_id = ${userId}::uuid OR fp.role = ${role})
        WHERE ancestor.path @> f.path
          AND ancestor.deleted_at IS NULL
        ORDER BY nlevel(ancestor.path) DESC, (fp.user_id IS NOT NULL) DESC
        LIMIT 1
      ) nearest ON true
      WHERE COALESCE(nearest.access_level, ${defaultAccess}) IN ('read', 'write')
        ${deletedFilter}
    )
  `;
}

/** Check write access for a specific folder path via nearest-ancestor resolution. */
export function folderWriteAccessSql(
  folderPath: string,
  userId: string,
  role: UserRole,
) {
  const defaultAccess = defaultWorkspaceAccess(role);

  return sql`
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
      ${defaultAccess}
    ) AS access_level
  `;
}

export function canWrite(accessLevel: string): boolean {
  return accessLevel === "write";
}

export function canUploadBaseDocument(role: UserRole): boolean {
  return role === "workspace_admin" || role === "senior_reviewer";
}
