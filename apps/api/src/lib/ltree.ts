const LTREE_LABEL_RE = /[^A-Za-z0-9_]/g;

/** Sanitize a folder name into a valid ltree label segment. */
export function sanitizeLtreeLabel(name: string): string {
  let label = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(LTREE_LABEL_RE, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

  if (label.length === 0) {
    label = "folder";
  }

  if (/^[0-9]/.test(label)) {
    label = `f_${label}`;
  }

  return label.slice(0, 50);
}

/** Build child path from parent path and folder name. */
export function buildChildPath(parentPath: string | null, name: string, id: string): string {
  const label = `${sanitizeLtreeLabel(name)}_${id.replace(/-/g, "").slice(0, 8)}`;
  return parentPath ? `${parentPath}.${label}` : label;
}

/** Count depth of an ltree path (number of labels). */
export function pathDepth(path: string): number {
  return path.split(".").length;
}
