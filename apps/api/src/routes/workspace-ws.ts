import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import { workspaceMembers } from '@rag/db';
import { createRedisSubscriber } from '../lib/redis.js';
import { verifyToken } from '../lib/jwt.js';
import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';

// Per-workspace fan-out: one Redis subscriber shared by all WS clients in a workspace.
interface WorkspaceChannel {
  sub: Redis;
  emitter: EventEmitter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  clients: Set<any>;
}

const workspaceChannels = new Map<string, WorkspaceChannel>();

function getOrCreateChannel(workspaceId: string): WorkspaceChannel {
  if (workspaceChannels.has(workspaceId)) {
    return workspaceChannels.get(workspaceId)!;
  }

  const sub = createRedisSubscriber();
  const emitter = new EventEmitter();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channel: WorkspaceChannel = { sub, emitter, clients: new Set<any>() };

  const redisChannel = `ingestion:events:${workspaceId}`;
  sub.subscribe(redisChannel);
  sub.on('message', (_ch: string, message: string) => {
    emitter.emit('status', message);
  });
  sub.on('error', (err: Error) => console.error(`[ws:${workspaceId}] Redis error:`, err.message));

  workspaceChannels.set(workspaceId, channel);
  return channel;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function releaseChannel(workspaceId: string, client: any): void {
  const channel = workspaceChannels.get(workspaceId);
  if (!channel) return;
  channel.clients.delete(client);
  if (channel.clients.size === 0) {
    const redisChannel = `ingestion:events:${workspaceId}`;
    channel.sub.unsubscribe(redisChannel).then(() => channel.sub.disconnect()).catch(() => {});
    workspaceChannels.delete(workspaceId);
  }
}

export async function workspaceWsRoutes(fastify: FastifyInstance) {
  // NOTE: @fastify/websocket handler signature is (socket, request).
  // We use explicit FastifyRequest typing to avoid tsc confusion before the
  // module's type augmentation loads.
  fastify.get(
    '/ws/workspaces/:workspaceId/documents',
    { websocket: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (socket: any, request: FastifyRequest<{
      Params: { workspaceId: string };
      Querystring: { token?: string };
    }>) => {
      const { workspaceId } = request.params;
      const { token } = request.query;

      if (!token) {
        socket.send(JSON.stringify({ error: 'unauthorized', message: 'token query param required' }));
        socket.close(1008, 'Unauthorized');
        return;
      }

      let userId: string;
      try {
        const payload = await verifyToken(token);
        userId = payload.sub as string;
      } catch {
        socket.send(JSON.stringify({ error: 'unauthorized', message: 'Invalid token' }));
        socket.close(1008, 'Unauthorized');
        return;
      }

      // Verify workspace membership inside a transaction
      const [membership] = await fastify.adminDb.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.current_workspace', ${workspaceId}::text, true)`,
        );
        return tx
          .select({ workspaceId: workspaceMembers.workspaceId })
          .from(workspaceMembers)
          .where(and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, userId),
          ))
          .limit(1);
      });

      if (!membership) {
        socket.send(JSON.stringify({ error: 'forbidden', message: 'Not a member of this workspace' }));
        socket.close(1008, 'Forbidden');
        return;
      }

      // Subscribe this client to workspace-wide status events
      const channel = getOrCreateChannel(workspaceId);
      channel.clients.add(socket);

      const handler = (message: string) => {
        if (socket.readyState === 1 /* OPEN */) {
          socket.send(message);
        }
      };
      channel.emitter.on('status', handler);

      socket.on('close', () => {
        channel.emitter.off('status', handler);
        releaseChannel(workspaceId, socket);
      });

      socket.on('error', (err: Error) => {
        console.error(`[ws:${workspaceId}] Client error:`, err.message);
        channel.emitter.off('status', handler);
        releaseChannel(workspaceId, socket);
      });

      // Confirm connection
      socket.send(JSON.stringify({ type: 'connected', workspaceId }));
    },
  );
}
