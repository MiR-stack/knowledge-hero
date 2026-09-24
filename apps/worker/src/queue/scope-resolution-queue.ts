import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

export interface ScopeResolutionJobData {
  scopeId: string;
  workspaceId: string;
}

export const SCOPE_RESOLUTION_QUEUE = 'scope-resolution';

let _queue: Queue<ScopeResolutionJobData> | null = null;

export function getScopeResolutionQueue(connection: Redis): Queue<ScopeResolutionJobData> {
  if (!_queue) {
    _queue = new Queue<ScopeResolutionJobData>(SCOPE_RESOLUTION_QUEUE, { connection });
  }
  return _queue;
}

export async function enqueueScopeResolution(
  scopeId: string,
  workspaceId: string,
  connection: Redis
): Promise<void> {
  const queue = getScopeResolutionQueue(connection);
  await queue.add('recompute', { scopeId, workspaceId }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 100 },
    jobId: `scope-recompute:${scopeId}`,
  });
}
