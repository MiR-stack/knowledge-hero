import type { Db, DbTransaction } from "@rag/db";

type UserRole = "workspace_admin" | "senior_reviewer" | "staff_member" | "read_only_client";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
  }

  interface FastifyRequest {
    userId?: string;
    userEmail?: string;
    workspaceId?: string;
    workspaceRole?: UserRole;
    tx?: DbTransaction;
  }

  interface FastifyContextConfig {
    auth?: boolean;
    tenant?: boolean;
  }
}

export {};
