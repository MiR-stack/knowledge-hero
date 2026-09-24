import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { config } from "../config.js";

let client: S3Client | null = null;
let bucketEnsured = false;

function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      credentials: {
        accessKeyId: config.s3.accessKey,
        secretAccessKey: config.s3.secretKey,
      },
      forcePathStyle: config.s3.forcePathStyle,
    });
  }
  return client;
}

export async function ensureBucket(): Promise<void> {
  if (bucketEnsured) return;

  const s3 = getClient();
  try {
    await s3.send(new HeadBucketCommand({ Bucket: config.s3.bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: config.s3.bucket }));
  }
  bucketEnsured = true;
}

export interface UploadResult {
  storageUri: string;
  checksumSha256: string;
  fileSizeBytes: number;
}

export async function uploadObject(
  key: string,
  body: Buffer,
  mimeType: string,
): Promise<UploadResult> {
  await ensureBucket();

  const checksumSha256 = createHash("sha256").update(body).digest("hex");
  const s3 = getClient();

  await s3.send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: body,
      ContentType: mimeType,
    }),
  );

  return {
    storageUri: key,
    checksumSha256,
    fileSizeBytes: body.length,
  };
}

export async function deleteObject(storageUri: string): Promise<void> {
  const s3 = getClient();
  await s3.send(
    new DeleteObjectCommand({
      Bucket: config.s3.bucket,
      Key: storageUri,
    }),
  );
}

export function buildStorageKey(
  workspaceId: string,
  documentId: string,
  filename: string,
): string {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${workspaceId}/${documentId}/${safeName}`;
}

export function inferSourceType(
  filename: string,
  mimeType: string,
): "pdf_native" | "pdf_scanned" | "image" | "excel" | "csv" | "docx" | "web_url" {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

  if (ext === "pdf" || mimeType === "application/pdf") return "pdf_native";
  if (["xlsx", "xls"].includes(ext) || mimeType.includes("spreadsheet")) return "excel";
  if (ext === "csv" || mimeType === "text/csv") return "csv";
  if (ext === "docx" || mimeType.includes("wordprocessingml")) return "docx";
  if (["png", "jpg", "jpeg", "gif", "webp", "tiff"].includes(ext) || mimeType.startsWith("image/")) {
    return "image";
  }

  return "pdf_native";
}

/**
 * Download an object from S3 as a Node.js Readable stream.
 * Used by the preview endpoint to pipe raw file bytes to the browser.
 */
export async function downloadObjectStream(
  storageUri: string,
): Promise<{ stream: Readable; contentLength?: number; contentType?: string }> {
  const s3 = getClient();
  const res = await s3.send(
    new GetObjectCommand({ Bucket: config.s3.bucket, Key: storageUri }),
  );
  return {
    stream: res.Body as Readable,
    contentLength: res.ContentLength,
    contentType: res.ContentType,
  };
}

/**
 * Server-side S3 copy — used by the document copy endpoint (FR-1.5).
 * Does not download/re-upload; copies within the bucket atomically.
 */
export async function copyObject(
  sourceKey: string,
  destKey: string,
): Promise<void> {
  await ensureBucket();
  const s3 = getClient();
  await s3.send(
    new CopyObjectCommand({
      Bucket: config.s3.bucket,
      CopySource: `${config.s3.bucket}/${sourceKey}`,
      Key: destKey,
    }),
  );
}
