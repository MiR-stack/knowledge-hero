import type { FastifyInstance } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import { documents, workspaceMembers } from '@rag/db';
import { createRedisSubscriber } from '../lib/redis.js';
import { verifyToken } from '../lib/jwt.js';
import { config } from '../config.js';

// Status progress percentages by stage
const STAGE_PROGRESS: Record<string, number> = {
  queued: 0,
  extracting: 20,
  chunking: 50,
  embedding: 80,
  indexed: 100,
  failed: 0,
};

const STAGES_ORDER = ['queued', 'extracting', 'chunking', 'embedding', 'indexed'];

export async function ingestionEventsRoutes(fastify: FastifyInstance) {
  // ── Polling endpoint (SRS §5.2) ────────────────────────────────────────
  fastify.get<{ Params: { documentId: string } }>(
    '/api/v1/documents/:documentId/status',
    { config: { tenant: true } },
    async (request, reply) => {
      const db = request.tx!;
      const { documentId } = request.params;

      const [doc] = await db
        .select({
          id: documents.id,
          processingStatus: documents.processingStatus,
          processingError: documents.processingError,
          updatedAt: documents.updatedAt,
        })
        .from(documents)
        .where(and(eq(documents.id, documentId), eq(documents.workspaceId, request.workspaceId!)))
        .limit(1);

      if (!doc) {
        return reply.code(404).send({ error: 'not_found', message: 'Document not found' });
      }

      const status = doc.processingStatus;
      const stagesCompleted = STAGES_ORDER.slice(0, STAGES_ORDER.indexOf(status));
      const progressPct = STAGE_PROGRESS[status] ?? 0;

      return reply.send({
        documentId: doc.id,
        status,
        progressPct,
        stagesCompleted,
        currentStage: status,
        error: doc.processingError,
        updatedAt: doc.updatedAt.toISOString(),
      });
    },
  );

  // ── SSE streaming endpoint (SRS §5.3) ──────────────────────────────────
  // NOTE: This route does NOT use the tenant plugin — manual auth below.
  fastify.get<{ Params: { documentId: string } }>(
    '/api/v1/documents/:documentId/events',
    async (request, reply) => {
      const { documentId } = request.params;
      const workspaceId = request.headers['x-workspace-id'] as string;

      if (!workspaceId) {
        return reply.code(400).send({ error: 'missing_workspace', message: 'X-Workspace-Id header is required' });
      }

      // Manual JWT verification (can't use authenticate hook — we're about to hijack)
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return reply.code(401).send({ error: 'unauthorized', message: 'Bearer token required' });
      }
      let userId: string;
      try {
        const payload = await verifyToken(authHeader.slice(7));
        userId = payload.sub as string;
      } catch {
        return reply.code(401).send({ error: 'unauthorized', message: 'Invalid or expired token' });
      }

      // Verify workspace membership and document ownership inside a tenant-scoped transaction
      const { membership, doc } = await fastify.adminDb.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.current_workspace', ${workspaceId}::text, true)`,
        );

        const [m] = await tx
          .select({ workspaceId: workspaceMembers.workspaceId })
          .from(workspaceMembers)
          .where(and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, userId),
          ))
          .limit(1);

        const [d] = await tx
          .select({ id: documents.id, processingStatus: documents.processingStatus, processingError: documents.processingError })
          .from(documents)
          .where(and(eq(documents.id, documentId), eq(documents.workspaceId, workspaceId)))
          .limit(1);

        return { membership: m, doc: d };
      });

      if (!membership) {
        return reply.code(403).send({ error: 'forbidden', message: 'Not a member of this workspace' });
      }

      if (!doc) {
        return reply.code(404).send({ error: 'not_found', message: 'Document not found' });
      }

      // If already in terminal state, send final event and close
      const isTerminal = doc.processingStatus === 'indexed' || doc.processingStatus === 'failed';
      
      // Hijack and take over the raw socket for SSE
      reply.hijack();
      const res = reply.raw;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
      res.write('retry: 2000\n\n');

      function sendEvent(eventName: string, data: object): void {
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
      }

      // Send current state immediately
      sendEvent(doc.processingStatus === 'failed' ? 'error' : 'status_update', {
        documentId,
        status: doc.processingStatus,
        progressPct: STAGE_PROGRESS[doc.processingStatus] ?? 0,
        error: doc.processingError,
      });

      if (isTerminal) {
        res.end();
        return;
      }

      // Subscribe to Redis channel for this document
      const sub = createRedisSubscriber();
      const channel = `ingestion:events:doc:${documentId}`;
      await sub.subscribe(channel);

      sub.on('message', (_channel: string, message: string) => {
        try {
          const data = JSON.parse(message) as {
            documentId: string;
            status: string;
            progressPct: number;
            error: string | null;
          };
          const eventName = data.status === 'failed' ? 'error' : 'status_update';
          sendEvent(eventName, data);
          if (data.status === 'indexed' || data.status === 'failed') {
            sub.unsubscribe(channel).then(() => sub.disconnect());
            res.end();
          }
        } catch (e) {
          console.error('[sse] Failed to parse Redis message:', e);
        }
      });

      // Clean up when client disconnects
      request.socket?.on('close', () => {
        sub.unsubscribe(channel).then(() => sub.disconnect()).catch(() => {});
      });

      // Heartbeat: send a comment every 25s to keep connection alive
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
          res.write(': heartbeat\n\n');
        } else {
          clearInterval(heartbeat);
        }
      }, 25_000);

      sub.on('end', () => clearInterval(heartbeat));
    },
  );
}
