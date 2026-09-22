/** Drive configuration defaults per SRS FR-1.1 and FR-1.7 */
export const DRIVE_DEFAULTS = {
  maxFolderDepth: 15,
  trashRetentionDays: 30,
} as const;

export type AccessLevel = "none" | "read" | "write";

export type UserRole =
  | "workspace_admin"
  | "senior_reviewer"
  | "staff_member"
  | "read_only_client";

export type ProcessingStatus =
  | "queued"
  | "extracting"
  | "chunking"
  | "embedding"
  | "indexed"
  | "failed";

export type DocumentSourceType =
  | "pdf_native"
  | "pdf_scanned"
  | "image"
  | "excel"
  | "csv"
  | "docx"
  | "web_url";

export interface FolderSummary {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  createdAt: string;
  updatedAt: string;
  accessLevel?: AccessLevel;
}

export interface BreadcrumbItem {
  id: string;
  name: string;
  path: string;
}

export interface FolderDetail extends FolderSummary {
  breadcrumbs: BreadcrumbItem[];
  accessLevel?: AccessLevel;
}

export interface DocumentSummary {
  id: string;
  workspaceId?: string;
  folderId: string | null;
  title: string;
  originalFilename: string;
  isBaseDocument: boolean;
  baseDocCategory: string | null;
  supersedesDocId: string | null;
  sourceType: DocumentSourceType;
  processingStatus: ProcessingStatus;
  processingError: string | null;
  tags: string[];
  fileSizeBytes: number | null;
  mimeType: string | null;
  uploadedBy: string;
  publishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  accessLevel?: AccessLevel;
}

export interface DocumentUploadResponse {
  documentId: string;
  status: ProcessingStatus;
  createdAt: string;
}

export interface FolderTreeNode {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  children: FolderTreeNode[];
}

export interface DriveListResponse {
  folder: FolderDetail | null;
  folders: FolderSummary[];
  documents: DocumentSummary[];
}

export interface TrashItem {
  id: string;
  type: "folder" | "document";
  name: string;
  deletedAt: string;
  purgeAt: string | null;
}

export interface HealthResponse {
  status: string;
  service: string;
  timestamp: string;
}

export interface FolderPermissionRecord {
  id: string;
  folderId: string;
  userId: string | null;
  userEmail?: string | null;
  userFullName?: string | null;
  role: UserRole | null;
  accessLevel: AccessLevel;
  grantedBy: string;
  createdAt: string;
}

export interface TeamMember {
  userId: string;
  email: string;
  fullName: string;
  role: UserRole;
  joinedAt: string;
  invitedBy: string | null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: UserRole;
}

export interface TeamMembersResponse {
  members: TeamMember[];
  assignableRoles: UserRole[];
}

export interface InviteMemberResponse {
  member: { userId: string; role: UserRole; joinedAt: string };
  temporaryPassword: string | null;
  message: string;
}

export interface AuthLoginResponse {
  user: { id: string; email: string; fullName: string };
  memberships: Array<{ workspaceId: string; role: UserRole }>;
  accessToken: string;
}
