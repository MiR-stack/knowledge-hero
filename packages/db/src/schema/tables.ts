import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
  vector,
} from "drizzle-orm/pg-core";
import { citext, ltree, tsvector } from "./custom-types.js";
import {
  batchJobStatusEnum,
  batchOperationTypeEnum,
  documentSourceTypeEnum,
  messageRoleEnum,
  processingStatusEnum,
  userRoleEnum,
} from "./enums.js";

// ============================================================
// Tenancy & Identity
// ============================================================

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  planTier: varchar("plan_tier", { length: 50 }).notNull().default("starter"),
  settings: jsonb("settings").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: citext("email").notNull().unique(),
  fullName: varchar("full_name", { length: 255 }).notNull(),
  passwordHash: text("password_hash"),
  ssoSubjectId: text("sso_subject_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: userRoleEnum("role").notNull().default("staff_member"),
    invitedBy: uuid("invited_by").references(() => users.id),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.userId] })],
);

// ============================================================
// Drive-Style File System
// ============================================================

export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    name: varchar("name", { length: 255 }).notNull(),
    path: ltree("path").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    unique("folders_workspace_id_parent_id_name_unique").on(
      table.workspaceId,
      table.parentId,
      table.name,
    ),
    index("idx_folders_path").using("gist", table.path),
    index("idx_folders_workspace")
      .on(table.workspaceId)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const folderPermissions = pgTable(
  "folder_permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    folderId: uuid("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    role: userRoleEnum("role"),
    accessLevel: varchar("access_level", { length: 10 }).notNull().default("read"),
    grantedBy: uuid("granted_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "folder_permissions_user_id_role_xor",
      sql`((${table.userId} IS NOT NULL)::int <> (${table.role} IS NOT NULL)::int)`,
    ),
    check(
      "folder_permissions_access_level_check",
      sql`${table.accessLevel} IN ('none', 'read', 'write')`,
    ),
    index("idx_folder_perms_folder").on(table.folderId),
    index("idx_folder_perms_user")
      .on(table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
    isBaseDocument: boolean("is_base_document").notNull().default(false),
    baseDocCategory: varchar("base_doc_category", { length: 100 }),
    supersedesDocId: uuid("supersedes_doc_id"),
    title: varchar("title", { length: 500 }).notNull(),
    sourceType: documentSourceTypeEnum("source_type").notNull(),
    originalFilename: varchar("original_filename", { length: 500 }).notNull(),
    storageUri: text("storage_uri").notNull(),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
    mimeType: varchar("mime_type", { length: 150 }),
    checksumSha256: char("checksum_sha256", { length: 64 }),
    processingStatus: processingStatusEnum("processing_status").notNull().default("queued"),
    processingError: text("processing_error"),
    tags: text("tags").array().notNull().default([]),
    pageCount: integer("page_count"),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    purgeAt: timestamp("purge_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_documents_workspace_folder")
      .on(table.workspaceId, table.folderId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("idx_documents_base")
      .on(table.workspaceId)
      .where(sql`${table.isBaseDocument} = true AND ${table.deletedAt} IS NULL`),
    index("idx_documents_status").on(table.processingStatus),
    index("idx_documents_tags").using("gin", table.tags),
  ],
);

export const batchJobs = pgTable(
  "batch_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    initiatedBy: uuid("initiated_by")
      .notNull()
      .references(() => users.id),
    operationType: batchOperationTypeEnum("operation_type").notNull(),
    status: batchJobStatusEnum("status").notNull().default("queued"),
    totalItems: integer("total_items").notNull(),
    processedItems: integer("processed_items").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("idx_batch_jobs_workspace").on(table.workspaceId, table.status)],
);

export const documentChunks = pgTable(
  "document_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    parentChunkId: uuid("parent_chunk_id"),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    tokenCount: integer("token_count"),
    embedding: vector("embedding", { dimensions: 1536 }),
    metadata: jsonb("metadata").notNull().default({}),
    contentTsv: tsvector("content_tsv").generatedAlwaysAs(
      (): ReturnType<typeof sql> => sql`to_tsvector('english', ${documentChunks.content})`,
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("document_chunks_document_id_chunk_index_unique").on(table.documentId, table.chunkIndex),
    index("idx_chunks_embedding").using("hnsw", table.embedding.op("vector_cosine_ops")),
    index("idx_chunks_workspace").on(table.workspaceId),
    index("idx_chunks_metadata").using("gin", sql`${table.metadata} jsonb_path_ops`),
    index("idx_chunks_tsv").using("gin", table.contentTsv),
  ],
);

// ============================================================
// Dynamic Scoping Engine
// ============================================================

export const scopes = pgTable("scopes", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id),
  isShared: boolean("is_shared").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});

export const scopeDocuments = pgTable(
  "scope_documents",
  {
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.scopeId, table.documentId] })],
);

export const scopeFolders = pgTable(
  "scope_folders",
  {
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    includeSubtree: boolean("include_subtree").notNull().default(true),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.scopeId, table.folderId] })],
);

export const scopeShares = pgTable(
  "scope_shares",
  {
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    canEdit: boolean("can_edit").notNull().default(false),
    sharedAt: timestamp("shared_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.scopeId, table.userId] })],
);

export const scopeResolvedDocuments = pgTable(
  "scope_resolved_documents",
  {
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.scopeId, table.documentId] }),
    index("idx_scope_resolved_by_scope").on(table.scopeId),
    index("idx_scope_resolved_by_document").on(table.documentId),
  ],
);

// ============================================================
// Rate Limiting & Cost Control
// ============================================================

export const workspaceRateLimits = pgTable("workspace_rate_limits", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  ocrPagesPerMin: integer("ocr_pages_per_min").notNull().default(200),
  embeddingCallsPerMin: integer("embedding_calls_per_min").notNull().default(500),
  llmTokensPerHour: integer("llm_tokens_per_hour").notNull().default(200000),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceUsageEvents = pgTable(
  "workspace_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    resource: varchar("resource", { length: 20 }).notNull(),
    quantity: integer("quantity").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_usage_events_workspace_time").on(table.workspaceId, table.occurredAt)],
);

// ============================================================
// Chat & Retrieval
// ============================================================

export const chatSessions = pgTable("chat_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  title: varchar("title", { length: 255 }),
  scopeIds: uuid("scope_ids").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => chatSessions.id, { onDelete: "cascade" }),
  role: messageRoleEnum("role").notNull(),
  content: text("content").notNull(),
  retrievalDebug: jsonb("retrieval_debug"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chatMessageCitations = pgTable(
  "chat_message_citations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    chunkId: uuid("chunk_id")
      .notNull()
      .references(() => documentChunks.id),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id),
    citationLabel: varchar("citation_label", { length: 10 }),
    pageNumber: integer("page_number"),
    sheetName: varchar("sheet_name", { length: 255 }),
    rowReference: varchar("row_reference", { length: 50 }),
    boundingBox: jsonb("bounding_box"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_citations_message").on(table.messageId)],
);
