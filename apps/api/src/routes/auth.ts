import type { FastifyInstance } from "fastify";
import argon2 from "argon2";
import { and, eq } from "drizzle-orm";
import { users, workspaceMembers, workspaceRateLimits, workspaces } from "@rag/db";
import { signAccessToken } from "../lib/jwt.js";

interface SignupBody {
  email: string;
  password: string;
  fullName: string;
  workspaceName: string;
  workspaceSlug: string;
}

interface LoginBody {
  email: string;
  password: string;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: SignupBody }>("/api/v1/auth/signup", async (request, reply) => {
    const { email, password, fullName, workspaceName } = request.body ?? {};
    const workspaceSlug = request.body?.workspaceSlug ?? slugify(workspaceName ?? "");

    if (!email || !password || !fullName || !workspaceName || !workspaceSlug) {
      return reply.code(400).send({
        error: "validation_error",
        message: "email, password, fullName, and workspaceName are required",
      });
    }

    if (password.length < 8) {
      return reply.code(400).send({
        error: "validation_error",
        message: "Password must be at least 8 characters",
      });
    }

    const passwordHash = await argon2.hash(password);

    try {
      const result = await fastify.adminDb.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({
            email,
            fullName,
            passwordHash,
          })
          .returning({
            id: users.id,
            email: users.email,
            fullName: users.fullName,
          });

        const [workspace] = await tx
          .insert(workspaces)
          .values({
            name: workspaceName,
            slug: workspaceSlug,
          })
          .returning({
            id: workspaces.id,
            name: workspaces.name,
            slug: workspaces.slug,
          });

        await tx.insert(workspaceMembers).values({
          workspaceId: workspace.id,
          userId: user.id,
          role: "workspace_admin",
        });

        await tx.insert(workspaceRateLimits).values({
          workspaceId: workspace.id,
        });

        return { user, workspace };
      });

      const accessToken = await signAccessToken({
        sub: result.user.id,
        email: result.user.email,
      });

      return reply.code(201).send({
        user: result.user,
        workspace: result.workspace,
        accessToken,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("unique")) {
        return reply.code(409).send({
          error: "conflict",
          message: "Email or workspace slug already exists",
        });
      }
      throw error;
    }
  });

  fastify.post<{ Body: LoginBody }>("/api/v1/auth/login", async (request, reply) => {
    const { email, password } = request.body ?? {};

    if (!email || !password) {
      return reply.code(400).send({
        error: "validation_error",
        message: "email and password are required",
      });
    }

    const [user] = await fastify.adminDb
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user?.passwordHash) {
      return reply.code(401).send({ error: "unauthorized", message: "Invalid credentials" });
    }

    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) {
      return reply.code(401).send({ error: "unauthorized", message: "Invalid credentials" });
    }

    const accessToken = await signAccessToken({ sub: user.id, email: user.email });

    const memberships = await fastify.adminDb
      .select({
        workspaceId: workspaceMembers.workspaceId,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, user.id));

    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
      },
      memberships,
      accessToken,
    });
  });

  fastify.get(
    "/api/v1/auth/me",
    {
      config: { tenant: true },
    },
    async (request, reply) => {
      if (!request.userId || !request.workspaceId || !request.workspaceRole) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      return reply.send({
        userId: request.userId,
        email: request.userEmail,
        workspaceId: request.workspaceId,
        role: request.workspaceRole,
      });
    },
  );
}
