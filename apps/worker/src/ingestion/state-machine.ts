import type { Db } from '@rag/db';
import { documents } from '@rag/db';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';

export class StateTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateTransitionError';
  }
}

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  queued: ['extracting', 'failed'],
  extracting: ['chunking', 'failed'],
  chunking: ['embedding', 'failed'],
  embedding: ['indexed', 'failed'],
  indexed: [],
  failed: []
};

export class ProcessingStateMachine {
  public currentStatus: string;

  constructor(
    private documentId: string,
    private workspaceId: string,
    private db: Db,
    private redisPublisher: Redis,
    initialStatus: string = 'queued'
  ) {
    this.currentStatus = initialStatus;
  }

  /** Load the current persisted status from the DB before processing. */
  static async create(
    documentId: string,
    workspaceId: string,
    db: Db,
    redisPublisher: Redis
  ): Promise<ProcessingStateMachine> {
    const [doc] = await db
      .select({ processingStatus: documents.processingStatus })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    const status = doc?.processingStatus ?? 'queued';
    return new ProcessingStateMachine(documentId, workspaceId, db, redisPublisher, status);
  }

  async transition(newStatus: string, progressPct?: number, error?: string): Promise<void> {
    const allowed = ALLOWED_TRANSITIONS[this.currentStatus] || [];
    if (!allowed.includes(newStatus)) {
      throw new StateTransitionError(`Cannot transition from ${this.currentStatus} to ${newStatus}`);
    }

    const updatedAt = new Date();

    await this.db.update(documents)
      .set({
        processingStatus: newStatus as any,
        processingError: error ?? null,
        updatedAt,
      })
      .where(eq(documents.id, this.documentId));

    const payload = JSON.stringify({
      documentId: this.documentId,
      status: newStatus,
      progressPct: progressPct ?? 0,
      error: error ?? null,
      updatedAt: updatedAt.toISOString()
    });

    await this.redisPublisher.publish(`ingestion:events:doc:${this.documentId}`, payload);
    await this.redisPublisher.publish(`ingestion:events:${this.workspaceId}`, payload);

    this.currentStatus = newStatus;
  }
}
