import fp from "fastify-plugin";
import { and, eq, sql } from "drizzle-orm";
import { workspaceMembers } from "@rag/db";

/**
 * Wraps tenant-scoped routes in an explicit transaction and sets
 * `SET LOCAL app.current_workspace` (via set_config(..., true)) per SRS §6.2.
 * Never uses session-level SET — safe under PgBouncer transaction pooling.
 */
export default fp(async (fastify) => {
  fastify.addHook("onRoute", (routeOptions) => {
    if (!routeOptions.config?.tenant) {
      return;
    }

    if (typeof routeOptions.preHandler === "undefined") {
      routeOptions.preHandler = fastify.authenticate;
    } else if (Array.isArray(routeOptions.preHandler)) {
      routeOptions.preHandler.unshift(fastify.authenticate);
    } else {
      routeOptions.preHandler = [fastify.authenticate, routeOptions.preHandler];
    }

    const originalHandler = routeOptions.handler;
    if (typeof originalHandler !== "function") {
      return;
    }

    routeOptions.handler = async function tenantScopedHandler(request, reply) {
      const workspaceId = request.headers["x-workspace-id"];
      if (typeof workspaceId !== "string" || workspaceId.length === 0) {
        return reply.code(400).send({
          error: "missing_workspace",
          message: "X-Workspace-Id header is required",
        });
      }

      if (!request.userId) {
        return reply.code(401).send({ error: "unauthorized", message: "Authentication required" });
      }

      const userId = request.userId;

      return fastify.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.current_workspace', ${workspaceId}::text, true)`,
        );

        const [membership] = await tx
          .select({
            workspaceId: workspaceMembers.workspaceId,
            userId: workspaceMembers.userId,
            role: workspaceMembers.role,
          })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, workspaceId),
              eq(workspaceMembers.userId, userId),
            ),
          )
          .limit(1);

        if (!membership) {
          return reply.code(403).send({
            error: "forbidden",
            message: "You are not a member of this workspace",
          });
        }

        request.workspaceId = workspaceId;
        request.workspaceRole = membership.role;
        request.tx = tx;

        return originalHandler.call(this, request, reply);
      });
    };
  });
});
