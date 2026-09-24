import { Redis } from 'ioredis';
import { Db, workspaceRateLimits, workspaceUsageEvents } from '@rag/db';
import { eq, and } from 'drizzle-orm';
import { config } from '../config.js';

interface RateLimitCacheEntry {
  limit: number;
  expiresAt: number;
}

export class AdmissionGate {
  private cache = new Map<string, RateLimitCacheEntry>();
  
  constructor(private redisClient: Redis, private db: Db) {}

  async check(workspaceId: string, resource: 'ocr_pages' | 'embedding_calls', quantity: number): Promise<boolean> {
    const limitKey = `${workspaceId}:${resource}`;
    let limit = 0;

    const cached = this.cache.get(limitKey);
    if (cached && cached.expiresAt > Date.now()) {
      limit = cached.limit;
    } else {
      const records = await this.db.select()
        .from(workspaceRateLimits)
        .where(eq(workspaceRateLimits.workspaceId, workspaceId));
      
      const record = records[0];
      if (resource === 'ocr_pages') {
        limit = record?.ocrPagesPerMin ?? 200;
      } else {
        limit = record?.embeddingCallsPerMin ?? 1000;
      }
      
      this.cache.set(limitKey, {
        limit,
        expiresAt: Date.now() + 60_000,
      });
    }

    const counterKey = `rl:${workspaceId}:${resource}`;
    
    // Pipeline INCRBY and EXPIRE
    const multi = this.redisClient.multi();
    multi.incrby(counterKey, quantity);
    
    // We only want to set expiry if we just created the key, but to keep it simple
    // and using a sliding/rolling window logic, we can just use EXPIRE if the TTL is -1.
    // However, BullMQ / redis standard sliding window is often just INCR + EXPIRE.
    // For simplicity, we just check the current ttl and set it if it doesn't exist.
    // A better lua script could be used, but let's stick to the requested logic:
    // INCRBY quantity, set EXPIRE rateLimitWindowMs if not set
    const results = await multi.exec();
    if (!results) return false;
    
    const count = results[0][1] as number;
    
    // Check TTL and set if not set
    const ttl = await this.redisClient.ttl(counterKey);
    if (ttl === -1) {
      await this.redisClient.pexpire(counterKey, config.rateLimitWindowMs);
    }
    
    if (count > limit) {
      return false; // over-limit
    }
    
    // Record usage (fire-and-forget)
    this.recordUsage(workspaceId, resource, quantity).catch(e => {
      console.error(`[AdmissionGate] Failed to record usage for ${workspaceId}:`, e);
    });
    
    return true;
  }

  async recordUsage(workspaceId: string, resource: string, quantity: number): Promise<void> {
    await this.db.insert(workspaceUsageEvents).values({
      workspaceId,
      resource,
      quantity,
    });
  }
}
