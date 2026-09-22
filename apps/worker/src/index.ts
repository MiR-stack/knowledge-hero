import { Worker, Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config.js";
import { runPurgeJob } from "./jobs/purge-trash.js";

const connection = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
});

const INGESTION_QUEUE = "ingestion";
const PURGE_QUEUE = "maintenance";

const ingestionWorker = new Worker(
  INGESTION_QUEUE,
  async (job) => {
    console.log(`[worker] Processing ingestion job ${job.id} (${job.name})`);
    return { processed: true, jobId: job.id };
  },
  { connection },
);

const purgeWorker = new Worker(
  PURGE_QUEUE,
  async (job) => {
    if (job.name === "purge-trash") {
      await runPurgeJob();
      return { purged: true };
    }
    return { skipped: true };
  },
  { connection },
);

const purgeQueue = new Queue(PURGE_QUEUE, { connection });

async function schedulePurgeJob() {
  await purgeQueue.add(
    "purge-trash",
    {},
    {
      repeat: { every: config.purgeIntervalMs },
      jobId: "purge-trash-recurring",
      removeOnComplete: true,
      removeOnFail: 50,
    },
  );
  await purgeQueue.add("purge-trash", {}, { jobId: "purge-trash-startup" });
}

ingestionWorker.on("ready", () => {
  console.log(`[worker] Ingestion consumer ready on "${INGESTION_QUEUE}"`);
});

purgeWorker.on("ready", () => {
  console.log(`[worker] Maintenance consumer ready on "${PURGE_QUEUE}"`);
});

ingestionWorker.on("failed", (job, err) => {
  console.error(`[worker] Ingestion job ${job?.id} failed:`, err.message);
});

purgeWorker.on("failed", (job, err) => {
  console.error(`[worker] Purge job ${job?.id} failed:`, err.message);
});

async function shutdown() {
  console.log("[worker] Shutting down...");
  await Promise.all([ingestionWorker.close(), purgeWorker.close(), purgeQueue.close()]);
  await connection.quit();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`[worker] Starting (Redis: ${config.redisUrl})`);
schedulePurgeJob().catch((err) => {
  console.error("[worker] Failed to schedule purge job:", err);
});
