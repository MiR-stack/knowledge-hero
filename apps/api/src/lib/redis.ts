import { Redis } from 'ioredis';
import { config } from '../config.js';

let publisher: Redis | null = null;
let subscriber: Redis | null = null;

export function getRedisPublisher(): Redis {
  if (!publisher) {
    publisher = new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
    publisher.on('error', (err) => console.error('[redis:publisher] Error:', err.message));
  }
  return publisher;
}

// Creates a DEDICATED subscriber connection (subscribe() blocks the connection).
// Each caller gets a fresh connection — callers are responsible for calling .disconnect().
export function createRedisSubscriber(): Redis {
  const sub = new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
  sub.on('error', (err) => console.error('[redis:subscriber] Error:', err.message));
  return sub;
}

export async function closeRedisConnections(): Promise<void> {
  await Promise.all([
    publisher?.quit(),
    subscriber?.quit(),
  ]);
}
