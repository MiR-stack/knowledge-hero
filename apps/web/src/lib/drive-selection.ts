import type { AccessLevel, ProcessingStatus } from "@rag/shared-types";

export type DriveItemKind = "folder" | "document";

export interface DriveSelection {
  kind: DriveItemKind;
  id: string;
  name: string;
  accessLevel: AccessLevel;
  parentId?: string | null;
  updatedAt?: string;
  fileSizeBytes?: number | null;
  mimeType?: string | null;
  processingStatus?: ProcessingStatus;
  isBaseDocument?: boolean;
}

export interface DriveClipboard {
  items: DriveSelection[];
  mode: "copy" | "cut";
}

export function canWriteItem(item: DriveSelection | null | undefined): boolean {
  return item?.accessLevel === "write";
}

export function canWriteAll(items: DriveSelection[]): boolean {
  return items.length > 0 && items.every(canWriteItem);
}

export function isSameItem(a: DriveSelection, b: DriveSelection): boolean {
  return a.kind === b.kind && a.id === b.id;
}

export function isItemSelected(item: DriveSelection, selection: DriveSelection[]): boolean {
  return selection.some((s) => isSameItem(s, item));
}

export function toggleSelection(
  item: DriveSelection,
  current: DriveSelection[],
  multi: boolean,
): DriveSelection[] {
  const exists = isItemSelected(item, current);
  if (!multi) return exists ? [] : [item];
  if (exists) return current.filter((s) => !isSameItem(s, item));
  return [...current, item];
}

export function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || (el as HTMLElement).isContentEditable;
}

export const DRAG_MIME = "application/x-rag-drive-item";

export function setDragPayload(e: React.DragEvent, item: DriveSelection) {
  e.dataTransfer.setData(DRAG_MIME, JSON.stringify(item));
  e.dataTransfer.setData("application/json", JSON.stringify({ id: item.id, kind: item.kind }));
  e.dataTransfer.effectAllowed = "move";
}

export function readDragPayload(e: React.DragEvent): DriveSelection | null {
  const raw = e.dataTransfer.getData(DRAG_MIME);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DriveSelection;
  } catch {
    return null;
  }
}
