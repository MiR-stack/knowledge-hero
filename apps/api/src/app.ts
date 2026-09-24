import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import type { HealthResponse } from '@rag/shared-types';
import { config } from './config.js';
import dbPlugin from './plugins/db.js';
import authPlugin from './plugins/auth.js';
import tenantPlugin from './plugins/tenant.js';
import { authRoutes } from './routes/auth.js';
import { documentRoutes } from './routes/documents.js';
import { folderRoutes } from './routes/folders.js';
import { folderPermissionRoutes } from './routes/folder-permissions.js';
import { teamRoutes, workspaceRoutes } from './routes/team.js';
import { ingestionEventsRoutes } from './routes/ingestion-events.js';
import { workspaceWsRoutes } from './routes/workspace-ws.js';
import { scopeRoutes } from './routes/scopes.js';
import { closeRedisConnections } from './lib/redis.js';

export async function buildApp() {
  const app = Fastify({ logger: true });

  app.addHook('onClose', async () => {
    await closeRedisConnections();
  });

  await app.register(cors, { origin: config.webUrl });
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });
  await app.register(websocket);
  await app.register(dbPlugin);
  await app.register(authPlugin);
  await app.register(tenantPlugin);

  app.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: 'api',
    timestamp: new Date().toISOString(),
  }));

  app.get('/api/v1/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: 'api',
    timestamp: new Date().toISOString(),
  }));

  await app.register(authRoutes);
  await app.register(folderRoutes);
  await app.register(folderPermissionRoutes);
  await app.register(documentRoutes);
  await app.register(teamRoutes);
  await app.register(workspaceRoutes);
  await app.register(ingestionEventsRoutes);
  await app.register(workspaceWsRoutes);
  await app.register(scopeRoutes);

  return app;
}
