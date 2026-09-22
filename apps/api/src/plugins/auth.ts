import fp from "fastify-plugin";
import { verifyAccessToken } from "../lib/jwt.js";

function extractBearerToken(authorization?: string): string | undefined {
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }
  return authorization.slice("Bearer ".length).trim() || undefined;
}

export default fp(async (fastify) => {
  fastify.decorate("authenticate", async (request, reply) => {
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      return reply.code(401).send({ error: "unauthorized", message: "Missing bearer token" });
    }

    try {
      const payload = await verifyAccessToken(token);
      request.userId = payload.sub;
      request.userEmail = payload.email;
    } catch {
      return reply.code(401).send({ error: "unauthorized", message: "Invalid or expired token" });
    }
  });
});

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>;
  }
}
