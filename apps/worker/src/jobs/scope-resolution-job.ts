import type { Job } from 'bullmq';
import type { Db } from '@rag/db';
import { recomputeScope } from '../lib/scope-resolver-worker.js';

export interface ScopeResolutionJobData {
  scopeId: string;
  workspaceId: string;
}

export async function processScopeResolutionJob(
  job: Job<ScopeResolutionJobData>,
  db: Db
): Promise<void> {
  const { scopeId, workspaceId } = job.data;
  console.log(`[scope-resolution] Recomputing scope ${scopeId}`);
  await recomputeScope(scopeId, workspaceId, db);
  console.log(`[scope-resolution] Done recomputing scope ${scopeId}`);
}
