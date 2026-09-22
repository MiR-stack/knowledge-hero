import type { DocumentSummary, FolderSummary } from "@rag/shared-types";
import type { DriveSelection } from "./drive-selection";

export type ViewMode = "grid" | "list";
export type SortField = "name" | "modified" | "size";
export type SortOrder = "asc" | "desc";
export type DriveSection = "my-drive" | "trash" | "search";

export function formatBytes(bytes: number | null): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  if (diffDays < 7) {
    return date.toLocaleDateString(undefined, { weekday: "short" });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function folderToSelection(folder: FolderSummary): DriveSelection {
  return {
    kind: "folder",
    id: folder.id,
    name: folder.name,
    accessLevel: folder.accessLevel ?? "write",
    parentId: folder.parentId,
    updatedAt: folder.updatedAt,
  };
}

export function documentToSelection(doc: DocumentSummary): DriveSelection {
  return {
    kind: "document",
    id: doc.id,
    name: doc.title,
    accessLevel: doc.accessLevel ?? "write",
    parentId: doc.folderId,
    updatedAt: doc.updatedAt,
    fileSizeBytes: doc.fileSizeBytes,
    mimeType: doc.mimeType,
    processingStatus: doc.processingStatus,
    isBaseDocument: doc.isBaseDocument,
  };
}

export function sortFolders(
  items: FolderSummary[],
  field: SortField,
  order: SortOrder,
): FolderSummary[] {
  const sorted = [...items].sort((a, b) => {
    let cmp = 0;
    if (field === "name") cmp = a.name.localeCompare(b.name);
    else cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
    return order === "asc" ? cmp : -cmp;
  });
  return sorted;
}

export function sortDocuments(
  items: DocumentSummary[],
  field: SortField,
  order: SortOrder,
): DocumentSummary[] {
  const sorted = [...items].sort((a, b) => {
    let cmp = 0;
    if (field === "name") cmp = a.title.localeCompare(b.title);
    else if (field === "size") cmp = (a.fileSizeBytes ?? 0) - (b.fileSizeBytes ?? 0);
    else cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
    return order === "asc" ? cmp : -cmp;
  });
  return sorted;
}

export function getFileTypeLabel(mimeType: string | null, filename: string): string {
  if (!mimeType) {
    const ext = filename.split(".").pop()?.toLowerCase();
    if (ext === "pdf") return "PDF";
    if (ext === "docx" || ext === "doc") return "Word";
    if (ext === "xlsx" || ext === "xls") return "Spreadsheet";
    if (ext === "csv") return "CSV";
    if (ext === "png" || ext === "jpg" || ext === "jpeg") return "Image";
    return "File";
  }
  if (mimeType.includes("pdf")) return "PDF";
  if (mimeType.includes("word") || mimeType.includes("document")) return "Word";
  if (mimeType.includes("sheet") || mimeType.includes("excel")) return "Spreadsheet";
  if (mimeType.includes("csv")) return "CSV";
  if (mimeType.startsWith("image/")) return "Image";
  if (mimeType.includes("text")) return "Text";
  return "File";
}
