import { Worker } from "bullmq";
import { Redis } from "ioredis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

const connection = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

const QUEUE_NAME = "ingestion";

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    console.log(`[worker] Processing job ${job.id} (${job.name})`);
    return { processed: true, jobId: job.id };
  },
  { connection },
);

worker.on("ready", () => {
  console.log(`[worker] BullMQ consumer ready on queue "${QUEUE_NAME}"`);
});

worker.on("completed", (job) => {
  console.log(`[worker] Job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] Job ${job?.id} failed:`, err.message);
});

async function shutdown() {
  console.log("[worker] Shutting down...");
  await worker.close();
  await connection.quit();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`[worker] Starting BullMQ consumer (Redis: ${REDIS_URL})`);
