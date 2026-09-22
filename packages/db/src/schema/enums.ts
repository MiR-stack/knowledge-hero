import { pgEnum } from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", [
  "workspace_admin",
  "senior_reviewer",
  "staff_member",
  "read_only_client",
]);

export const processingStatusEnum = pgEnum("processing_status", [
  "queued",
  "extracting",
  "chunking",
  "embedding",
  "indexed",
  "failed",
]);

export const documentSourceTypeEnum = pgEnum("document_source_type", [
  "pdf_native",
  "pdf_scanned",
  "image",
  "excel",
  "csv",
  "docx",
  "web_url",
]);

export const batchOperationTypeEnum = pgEnum("batch_operation_type", [
  "move",
  "tag",
  "delete",
  "add_to_scope",
]);

export const batchJobStatusEnum = pgEnum("batch_job_status", [
  "queued",
  "running",
  "completed",
  "failed",
]);

export const messageRoleEnum = pgEnum("message_role", [
  "user",
  "assistant",
  "system",
]);
