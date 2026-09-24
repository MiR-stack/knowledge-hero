import { Worker, Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Db } from '@rag/db';
import { queueName, type IngestionJobData } from './ingestion-queue.js';
import { processIngestionJob } from '../ingestion/job-processor.js';
import { config } from '../config.js';

export class WeightedFairShareScheduler {
  private workers = new Map<string, Worker>();
  private scanInterval: NodeJS.Timeout | null = null;
  private activeCount = 0;
  
  constructor(
    private connection: Redis,
    private db: Db,
    private concurrency: number = 4
  ) {}

  start(): void {
    // Scan for active workspace queues every 30 seconds
    this.scanInterval = setInterval(() => this.discoverAndRegisterQueues(), 30_000);
    // Initial scan
    this.discoverAndRegisterQueues();
  }

  async stop(): Promise<void> {
    if (this.scanInterval) clearInterval(this.scanInterval);
    await Promise.all([...this.workers.values()].map(w => w.close()));
  }

  private async discoverAndRegisterQueues(): Promise<void> {
    // BullMQ stores queue keys as bull:{name}:wait, bull:{name}:active, etc.
    const keys = await this.connection.keys('bull:ingestion:*:wait');
    for (const key of keys) {
      // key = bull:ingestion:{workspaceId}:wait
      const match = key.match(/^bull:ingestion:([^:]+):wait$/);
      if (!match) continue;
      const workspaceId = match[1];
      if (this.workers.has(workspaceId)) continue;
      this.registerWorker(workspaceId);
    }
  }

  private registerWorker(workspaceId: string): void {
    // Each workspace worker respects global concurrency via activeCount
    const worker = new Worker<IngestionJobData>(
      queueName(workspaceId),
      async (job: Job<IngestionJobData>) => {
        // Fair-share: if global cap reached, delay this job and yield
        if (this.activeCount >= this.concurrency) {
          // Re-add with a delay so other workspaces can process
          await job.moveToDelayed(Date.now() + 1000);
          return;
        }
        this.activeCount++;
        try {
          await processIngestionJob(job, this.db, this.connection);
        } finally {
          this.activeCount--;
        }
      },
      {
        connection: this.connection,
        concurrency: 1, // each workspace processes one job at a time
      }
    );

    worker.on('failed', (job, err) => {
      console.error(`[scheduler] Job ${job?.id} in workspace ${workspaceId} failed:`, err.message);
    });

    this.workers.set(workspaceId, worker);
    console.log(`[scheduler] Registered worker for workspace ${workspaceId}`);
  }
}
