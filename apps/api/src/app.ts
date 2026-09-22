import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import type { HealthResponse } from "@rag/shared-types";
import { config } from "./config.js";
import dbPlugin from "./plugins/db.js";
import authPlugin from "./plugins/auth.js";
import tenantPlugin from "./plugins/tenant.js";
import { authRoutes } from "./routes/auth.js";
import { documentRoutes } from "./routes/documents.js";
import { folderRoutes } from "./routes/folders.js";
import { folderPermissionRoutes } from "./routes/folder-permissions.js";
import { teamRoutes, workspaceRoutes } from "./routes/team.js";

export async function buildApp() {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: config.webUrl });
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });
  await app.register(dbPlugin);
  await app.register(authPlugin);
  await app.register(tenantPlugin);

  app.get("/health", async (): Promise<HealthResponse> => ({
    status: "ok",
    service: "api",
    timestamp: new Date().toISOString(),
  }));

  app.get("/api/v1/health", async (): Promise<HealthResponse> => ({
    status: "ok",
    service: "api",
    timestamp: new Date().toISOString(),
  }));

  await app.register(authRoutes);
  await app.register(folderRoutes);
  await app.register(folderPermissionRoutes);
  await app.register(documentRoutes);
  await app.register(teamRoutes);
  await app.register(workspaceRoutes);

  return app;
}
