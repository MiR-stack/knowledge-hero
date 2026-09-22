import fp from "fastify-plugin";
import { createDb } from "@rag/db";
import { config } from "../config.js";

export default fp(async (fastify) => {
  const tenantConnectionString = process.env.PGBOUNCER_URL ?? config.pgbouncerUrl;
  const adminConnectionString = process.env.DATABASE_URL ?? config.databaseUrl;

  const db = createDb(tenantConnectionString, { prepare: false });
  const adminDb = createDb(adminConnectionString, { prepare: false, max: 5 });

  fastify.decorate("db", db);
  fastify.decorate("adminDb", adminDb);

  fastify.addHook("onClose", async () => {
    await Promise.all([fastify.db.$client.end(), fastify.adminDb.$client.end()]);
  });
});

declare module "fastify" {
  interface FastifyInstance {
    adminDb: import("@rag/db").Db;
  }
}
