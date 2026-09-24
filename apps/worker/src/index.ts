import { Worker, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createDb } from '@rag/db';
import { config } from './config.js';
import { runPurgeJob } from './jobs/purge-trash.js';
import { WeightedFairShareScheduler } from './queue/scheduler.js';
import { terminateTesseract } from './parsers/pdf-ocr.js';

const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const redisPublisher = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

const db = createDb(config.databaseUrl, { prepare: false, max: 5 });

// ── Maintenance / purge queue ──────────────────────────────────────────────
const PURGE_QUEUE = 'maintenance';
const purgeWorker = new Worker(
  PURGE_QUEUE,
  async (job) => {
    if (job.name === 'purge-trash') {
      await runPurgeJob();
      return { purged: true };
    }
    return { skipped: true };
  },
  { connection },
);

const purgeQueue = new Queue(PURGE_QUEUE, { connection });

async function schedulePurgeJob() {
  await purgeQueue.add('purge-trash', {}, {
    repeat: { every: config.purgeIntervalMs },
    jobId: 'purge-trash-recurring',
    removeOnComplete: true,
    removeOnFail: 50,
  });
  await purgeQueue.add('purge-trash', {}, { jobId: 'purge-trash-startup' });
}

// ── Dead-letter queue worker ───────────────────────────────────────────────
const DLQ_QUEUE = 'ingestion:dlq';
const dlqWorker = new Worker(
  DLQ_QUEUE,
  async (job) => {
    // Jobs in the DLQ are already failed — just log them
    // The state machine already transitioned them to 'failed' before they got here
    console.error(`[dlq] Dead-letter job received: ${job.id} for document ${job.data?.documentId}`);
    return { acknowledged: true };
  },
  { connection },
);

// ── Fair-share ingestion scheduler ────────────────────────────────────────
const scheduler = new WeightedFairShareScheduler(
  connection,
  db,
  config.ocrConcurrency,
);

// ── Event listeners ───────────────────────────────────────────────────────
purgeWorker.on('ready', () => console.log('[worker] Maintenance consumer ready'));
purgeWorker.on('failed', (job, err) => console.error(`[worker] Purge job ${job?.id} failed:`, err.message));

dlqWorker.on('ready', () => console.log('[worker] DLQ consumer ready'));

import { processScopeResolutionJob } from './jobs/scope-resolution-job.js';

const scopeWorker = new Worker(
  'scope-resolution',
  async (job) => processScopeResolutionJob(job, db),
  { connection, concurrency: 2 }
);
scopeWorker.on('failed', (job, err) => {
  console.error(`[scope-worker] Job ${job?.id} failed:`, err.message);
});
scopeWorker.on('ready', () => console.log('[worker] Scope resolution consumer ready'));

// ── Shutdown ──────────────────────────────────────────────────────────────
async function shutdown() {
  console.log('[worker] Shutting down...');
  await scheduler.stop();
  await Promise.all([
    purgeWorker.close(),
    dlqWorker.close(),
    scopeWorker.close(),
    purgeQueue.close(),
  ]);
  await terminateTesseract();
  await connection.quit();
  await redisPublisher.quit();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Start ─────────────────────────────────────────────────────────────────
console.log(`[worker] Starting (Redis: ${config.redisUrl})`);
scheduler.start();
schedulePurgeJob().catch(err => console.error('[worker] Failed to schedule purge job:', err));
