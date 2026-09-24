import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';

const SCOPE_RESOLUTION_QUEUE = 'scope-resolution';

let _conn: Redis | null = null;
let _queue: Queue | null = null;

function getConnection(): Redis {
  if (!_conn) _conn = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  return _conn;
}

export async function enqueueScopeResolution(scopeId: string, workspaceId: string): Promise<void> {
  if (!_queue) _queue = new Queue(SCOPE_RESOLUTION_QUEUE, { connection: getConnection() });
  await _queue.add('recompute', { scopeId, workspaceId }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 100 },
    jobId: `scope-recompute:${scopeId}`,
  });
}
