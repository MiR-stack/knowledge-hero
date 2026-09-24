import type {
  AuthLoginResponse,
  DriveListResponse,
  DocumentSummary,
  FolderPermissionRecord,
  FolderTreeNode,
  InviteMemberResponse,
  TeamMembersResponse,
  TrashItem,
  UserRole,
  WorkspaceSummary,
} from "@rag/shared-types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  options: RequestInit & { token?: string; workspaceId?: string } = {},
): Promise<T> {
  const { token, workspaceId, ...init } = options;
  const headers = new Headers(init.headers);

  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (workspaceId) headers.set("X-Workspace-Id", workspaceId);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`${API_URL}${path}`, { ...init, headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? "request_failed", body.message ?? res.statusText);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export async function login(email: string, password: string): Promise<AuthLoginResponse> {
  return request<AuthLoginResponse>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function signup(input: {
  email: string;
  password: string;
  fullName: string;
  workspaceName: string;
}): Promise<AuthLoginResponse & { workspace: { id: string; name: string; slug: string } }> {
  return request("/api/v1/auth/signup", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchFolderContents(
  token: string,
  workspaceId: string,
  parentId?: string,
): Promise<DriveListResponse> {
  const qs = parentId ? `?parentId=${parentId}` : "";
  return request<DriveListResponse>(`/api/v1/folders${qs}`, { token, workspaceId });
}

export async function fetchFolderTree(
  token: string,
  workspaceId: string,
): Promise<{ tree: FolderTreeNode[] }> {
  return request("/api/v1/folders/tree", { token, workspaceId });
}

export async function createFolder(
  token: string,
  workspaceId: string,
  name: string,
  parentId: string,
): Promise<{ folder: { id: string; name: string } }> {
  return request("/api/v1/folders", {
    method: "POST",
    token,
    workspaceId,
    body: JSON.stringify({ name, parentId }),
  });
}

export async function moveFolder(
  token: string,
  workspaceId: string,
  folderId: string,
  targetParentId: string,
): Promise<void> {
  await request(`/api/v1/folders/${folderId}/move`, {
    method: "POST",
    token,
    workspaceId,
    body: JSON.stringify({ targetParentId }),
  });
}

export async function moveDocument(
  token: string,
  workspaceId: string,
  documentId: string,
  targetFolderId: string,
): Promise<void> {
  await request(`/api/v1/documents/${documentId}/move`, {
    method: "POST",
    token,
    workspaceId,
    body: JSON.stringify({ targetFolderId }),
  });
}

export async function uploadDocument(
  token: string,
  workspaceId: string,
  folderId: string,
  file: File,
  options: { isBaseDocument?: boolean; baseDocCategory?: string },
): Promise<{ documentId: string; status: string }> {
  const form = new FormData();
  form.append("file", file);
  form.append("folderId", folderId);
  form.append("isBaseDocument", String(options.isBaseDocument ?? false));
  if (options.baseDocCategory) {
    form.append("baseDocCategory", options.baseDocCategory);
  }

  return request("/api/v1/documents/upload", {
    method: "POST",
    token,
    workspaceId,
    body: form,
  });
}

export async function deleteFolder(
  token: string,
  workspaceId: string,
  folderId: string,
): Promise<void> {
  await request(`/api/v1/folders/${folderId}`, { method: "DELETE", token, workspaceId });
}

export async function deleteDocument(
  token: string,
  workspaceId: string,
  documentId: string,
): Promise<void> {
  await request(`/api/v1/documents/${documentId}`, { method: "DELETE", token, workspaceId });
}

export async function renameFolder(
  token: string,
  workspaceId: string,
  folderId: string,
  name: string,
): Promise<void> {
  await request(`/api/v1/folders/${folderId}`, {
    method: "PATCH",
    token,
    workspaceId,
    body: JSON.stringify({ name }),
  });
}

export async function renameDocument(
  token: string,
  workspaceId: string,
  documentId: string,
  title: string,
): Promise<void> {
  await request(`/api/v1/documents/${documentId}`, {
    method: "PATCH",
    token,
    workspaceId,
    body: JSON.stringify({ title }),
  });
}

export async function searchDocuments(
  token: string,
  workspaceId: string,
  q: string,
): Promise<{ documents: DocumentSummary[] }> {
  return request(`/api/v1/documents?q=${encodeURIComponent(q)}`, { token, workspaceId });
}

export function canMarkBaseDocument(role: UserRole): boolean {
  return role === "workspace_admin" || role === "senior_reviewer";
}

export function canManageTeam(role: UserRole): boolean {
  return role === "workspace_admin" || role === "senior_reviewer";
}

export async function fetchWorkspaces(token: string): Promise<{ workspaces: WorkspaceSummary[] }> {
  return request("/api/v1/workspaces", { token });
}

export async function fetchTeamMembers(
  token: string,
  workspaceId: string,
): Promise<TeamMembersResponse> {
  return request("/api/v1/team/members", { token, workspaceId });
}

export async function inviteTeamMember(
  token: string,
  workspaceId: string,
  input: { email: string; fullName: string; role: UserRole; password?: string },
): Promise<InviteMemberResponse> {
  return request("/api/v1/team/invite", {
    method: "POST",
    token,
    workspaceId,
    body: JSON.stringify(input),
  });
}

export async function updateTeamMemberRole(
  token: string,
  workspaceId: string,
  userId: string,
  role: UserRole,
): Promise<void> {
  await request(`/api/v1/team/members/${userId}`, {
    method: "PATCH",
    token,
    workspaceId,
    body: JSON.stringify({ role }),
  });
}

export async function removeTeamMember(
  token: string,
  workspaceId: string,
  userId: string,
): Promise<void> {
  await request(`/api/v1/team/members/${userId}`, {
    method: "DELETE",
    token,
    workspaceId,
  });
}

export async function fetchFolderPermissions(
  token: string,
  workspaceId: string,
  folderId: string,
): Promise<{ permissions: FolderPermissionRecord[] }> {
  return request(`/api/v1/folders/${folderId}/permissions`, { token, workspaceId });
}

export async function setFolderPermission(
  token: string,
  workspaceId: string,
  folderId: string,
  input: {
    userId?: string;
    role?: UserRole;
    accessLevel: "none" | "read" | "write";
  },
): Promise<void> {
  await request(`/api/v1/folders/${folderId}/permissions`, {
    method: "PUT",
    token,
    workspaceId,
    body: JSON.stringify(input),
  });
}

export async function deleteFolderPermission(
  token: string,
  workspaceId: string,
  folderId: string,
  permissionId: string,
): Promise<void> {
  await request(`/api/v1/folders/${folderId}/permissions/${permissionId}`, {
    method: "DELETE",
    token,
    workspaceId,
  });
}

export function roleLabel(role: UserRole): string {
  return role.replace(/_/g, " ");
}

export async function fetchTrash(
  token: string,
  workspaceId: string,
): Promise<{ items: TrashItem[] }> {
  return request("/api/v1/trash", { token, workspaceId });
}

export async function restoreDocument(
  token: string,
  workspaceId: string,
  documentId: string,
): Promise<void> {
  await request(`/api/v1/documents/${documentId}/restore`, {
    method: "POST",
    token,
    workspaceId,
  });
}

export async function restoreFolder(
  token: string,
  workspaceId: string,
  folderId: string,
): Promise<void> {
  await request(`/api/v1/folders/${folderId}/restore`, {
    method: "POST",
    token,
    workspaceId,
  });
}

export function openDocumentEventStream(
  documentId: string,
  token: string,
  workspaceId: string,
  onEvent: (event: { status: string; progressPct: number; error: string | null }) => void,
  onClose?: () => void
): () => void {
  let closed = false;
  
  async function connect() {
    try {
      const res = await fetch(`${API_URL}/api/v1/documents/${documentId}/events`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Workspace-Id': workspaceId,
          Accept: 'text/event-stream',
        },
      });
      if (!res.ok || !res.body) { onClose?.(); return; }
      
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const event of events) {
          if (!event.trim()) continue;
          const lines = event.split('\n');
          let dataStr = '';
          for (const line of lines) {
            if (line.startsWith('data:')) dataStr = line.slice(5).trim();
          }
          if (!dataStr) continue;
          try {
            const data = JSON.parse(dataStr);
            onEvent({ status: data.status, progressPct: data.progressPct ?? 0, error: data.error ?? null });
            if (data.status === 'indexed' || data.status === 'failed') {
              closed = true; reader.cancel(); onClose?.(); return;
            }
          } catch {}
        }
      }
    } catch { onClose?.(); }
  }
  
  connect();
  return () => { closed = true; };
}

/** FR-1.5 — Copy a document into a target folder */
export async function copyDocument(
  token: string,
  workspaceId: string,
  documentId: string,
  targetFolderId: string,
): Promise<{ documentId: string; copiedFromId: string; status: string; createdAt: string }> {
  return request(`/api/v1/documents/${documentId}/copy`, {
    method: "POST",
    token,
    workspaceId,
    body: JSON.stringify({ targetFolderId }),
  });
}

/**
 * FR-1.4 — Build the URL for inline document preview.
 * Returns an authenticated URL suitable for use in an <iframe> or <img>.
 * The preview endpoint streams the raw file with the correct Content-Type.
 */
export function getPreviewUrl(documentId: string): string {
  const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  return `${API_URL}/api/v1/documents/${documentId}/preview`;
}
