import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';

export interface IngestionJobData {
  documentId: string;
  workspaceId: string;
  sourceType: 'pdf_native' | 'pdf_scanned' | 'image' | 'excel' | 'csv' | 'docx' | 'web_url';
  storageUri: string;
  webUrl?: string; // only for web_url source type
}

// Queue name format: ingestion:{workspaceId}
export function queueName(workspaceId: string): string {
  return `ingestion:${workspaceId}`;
}

// Cache queues by workspaceId
const queueCache = new Map<string, Queue<IngestionJobData>>();

export function getIngestionQueue(workspaceId: string, connection: Redis): Queue<IngestionJobData> {
  if (!queueCache.has(workspaceId)) {
    const q = new Queue<IngestionJobData>(queueName(workspaceId), { connection });
    queueCache.set(workspaceId, q);
  }
  return queueCache.get(workspaceId)!;
}

export async function enqueueIngestionJob(
  workspaceId: string,
  connection: Redis,
  data: IngestionJobData
): Promise<void> {
  const queue = getIngestionQueue(workspaceId, connection);
  await queue.add('process', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 100 },
    removeOnFail: false, // keep for DLQ inspection
  });
}
