import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { documents, documentChunks, folders } from '@rag/db';
import type { Db } from '@rag/db';
import { eq } from 'drizzle-orm';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ProcessingStateMachine, StateTransitionError } from './state-machine.js';
import { dispatchParser } from '../parsers/index.js';
import { AdmissionGate } from '../queue/admission-gate.js';
import type { IngestionJobData } from '../queue/ingestion-queue.js';
import { config } from '../config.js';
import { chunkText } from '../chunking/chunker.js';
import { chunkSpreadsheet } from '../chunking/spreadsheet-chunker.js';
import { getEmbeddingProvider } from '../embedding/index.js';
import { writeChunks } from './chunk-writer.js';

class OverLimitError extends Error {
  constructor() { super('Workspace is over rate limit — job will retry'); this.name = 'OverLimitError'; }
}

let s3Client: S3Client | null = null;
function getS3(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      credentials: { accessKeyId: config.s3.accessKey, secretAccessKey: config.s3.secretKey },
      forcePathStyle: config.s3.forcePathStyle,
    });
  }
  return s3Client;
}

async function downloadFromS3(storageUri: string): Promise<Buffer> {
  const res = await getS3().send(new GetObjectCommand({
    Bucket: config.s3.bucket,
    Key: storageUri,
  }));
  const chunks: Uint8Array[] = [];
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function processIngestionJob(
  job: Job<IngestionJobData>,
  db: Db,
  redisPublisher: Redis
): Promise<void> {
  const { documentId, workspaceId, sourceType, storageUri } = job.data;
  const sm = await ProcessingStateMachine.create(documentId, workspaceId, db, redisPublisher);
  const admissionGate = new AdmissionGate(redisPublisher, db);

  console.log(`[job-processor] Starting job ${job.id}: ${documentId} (${sourceType}), attempt ${job.attemptsMade + 1}`);

  try {
    // Load document metadata for chunk metadata payload (FR-3.3)
    const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
    if (!doc) throw new Error(`Document ${documentId} not found`);

    // Fetch folder path if document is in a folder
    let folderPath: string | null = null;
    if (doc.folderId) {
      const [folder] = await db.select({ path: folders.path }).from(folders).where(eq(folders.id, doc.folderId)).limit(1);
      folderPath = folder?.path ?? null;
    }

    // Transition: queued → extracting
    await sm.transition('extracting', 5);

    // Admission check for OCR BEFORE expensive work
    const isOcr = ['pdf_scanned', 'image'].includes(sourceType);
    if (isOcr) {
      const isAdmitted = await admissionGate.check(workspaceId, 'ocr_pages', 1);
      if (!isAdmitted) {
        console.log(`[job-processor] Workspace ${workspaceId} over OCR rate limit, will retry`);
        throw new OverLimitError();
      }
    }

    // Download document from S3
    const buffer = await downloadFromS3(storageUri);
    await sm.transition('extracting', 20);

    // Parse document
    const parseResult = await dispatchParser(buffer, job.data);
    console.log(`[job-processor] Parsed ${documentId}: ${parseResult.text.length} chars`);

    if ((parseResult.metadata as any)?.needsManualReview === true) {
      await db.update(documents)
        .set({ processingError: 'manual_review_required: Low confidence table detection', updatedAt: new Date() })
        .where(eq(documents.id, documentId));
    }

    // Transition: extracting → chunking
    await sm.transition('chunking', 50);

    // Chunk the document
    const isSpreadsheet = ['excel', 'csv'].includes(sourceType);
    let childTexts: string[] = [];
    let chunkerResult = null;
    let ssChunks = null;

    if (isSpreadsheet) {
      const rawSheets = (parseResult.metadata as any)?.sheets ?? [];
      const sheets = rawSheets.map((s: any) => ({
        name: s.sheetName,
        headers: s.headers,
        // The first row in s.rows is the header, so we skip it to get data rows.
        rows: s.rows.slice(1).map((r: any[]) => r.map(c => String(c.rawValue ?? '')))
      }));
      ssChunks = chunkSpreadsheet(sheets);
      childTexts = ssChunks.map(c => c.content);
      console.log(`[job-processor] Spreadsheet chunked to ${ssChunks.length} chunks`);
    } else {
      chunkerResult = chunkText(parseResult.text);
      childTexts = chunkerResult.children.map(c => c.content);
      console.log(`[job-processor] Text chunked to ${chunkerResult.children.length} children, ${chunkerResult.parents.length} parents`);
    }

    // Admission check for embedding calls
    if (childTexts.length > 0) {
      const embeddingAdmitted = await admissionGate.check(workspaceId, 'embedding_calls', childTexts.length);
      if (!embeddingAdmitted) {
        console.log(`[job-processor] Workspace ${workspaceId} over embedding rate limit, will retry`);
        throw new OverLimitError();
      }
    }

    // Transition: chunking → embedding
    await sm.transition('embedding', 70);

    // Generate embeddings
    const embedder = getEmbeddingProvider();
    const embeddings = childTexts.length > 0
      ? await embedder.embedBatch(childTexts)
      : [];
    console.log(`[job-processor] Generated ${embeddings.length} embeddings for ${documentId}`);

    // Write chunks to DB (transactional, deletes old chunks first per FR-3.6)
    await writeChunks(db, {
      documentId,
      workspaceId,
      sourceType,
      documentTitle: doc.title,
      folderPath,
      isBaseDocument: doc.isBaseDocument,
      baseDocCategory: doc.baseDocCategory ?? null,
      tags: doc.tags ?? [],
      documentVersion: 1, // TODO Phase 5: use supersedes chain to determine version
      chunkerResult,
      spreadsheetChunks: ssChunks,
      embeddings,
      createdAt: new Date(),
    });

    // Transition: embedding → indexed
    await sm.transition('indexed', 100);
    console.log(`[job-processor] Job complete: ${documentId} indexed with ${embeddings.length} chunks`);

  } catch (err) {
    if (err instanceof OverLimitError) throw err;
    if (err instanceof StateTransitionError) {
      console.error(`[job-processor] Invalid state transition for ${documentId}:`, err.message);
      throw err;
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[job-processor] Failed ${documentId}:`, errorMsg);
    try {
      await sm.transition('failed', 0, errorMsg);
    } catch {
      console.error(`[job-processor] Could not transition ${documentId} to failed state`);
    }
    throw err;
  }
}
