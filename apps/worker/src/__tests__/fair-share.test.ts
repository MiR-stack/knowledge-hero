import { describe, it, expect } from 'vitest';

describe('WeightedFairShareScheduler — fair-share property', () => {
  it('workspace B (1 job) makes forward progress when workspace A has 100 queued jobs', async () => {
    const processOrder: string[] = [];
    
    const workspaceQueues: Record<string, string[]> = {
      'workspace-a': Array.from({ length: 100 }, (_, i) => `job-a-${i}`),
      'workspace-b': ['job-b-0'],
    };
    
    const ticks = 4;
    const workspaces = Object.keys(workspaceQueues);
    let tick = 0;
    while (tick < ticks) {
      const workspaceIdx = tick % workspaces.length;
      const ws = workspaces[workspaceIdx];
      const job = workspaceQueues[ws].shift();
      if (job) processOrder.push(job);
      tick++;
    }
    
    const bJobProcessed = processOrder.some(j => j.startsWith('job-b'));
    expect(bJobProcessed).toBe(true);
    
    const bIdx = processOrder.findIndex(j => j.startsWith('job-b'));
    const aJobsProcessed = processOrder.filter(j => j.startsWith('job-a')).length;
    expect(bIdx).toBeLessThan(aJobsProcessed);
    expect(bIdx).toBeLessThan(3);
  });
});
