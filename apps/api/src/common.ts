import {
  CanActivate,
  ExecutionContext,
  Injectable,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import type { Request, Reply } from "./types";
import { createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { userSessions, users } from "@shotlin/database";
import type { z } from "zod";
import type { ApiDb } from "./infrastructure";
import { DB } from "./infrastructure";
import { Inject } from "@nestjs/common";
import type { AuthedRequest } from "./types";

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: "customer" | "admin";
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(DB) private db: ApiDb) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = (req.cookies as Record<string, string> | undefined)?.["shotlin_session"];
    if (!token) throw new UnauthorizedException("Not signed in");

    const rows = await this.db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
      })
      .from(userSessions)
      .innerJoin(users, eq(users.id, userSessions.userId))
      .where(
        and(
          eq(userSessions.tokenHash, hashSessionToken(token)),
          isNull(userSessions.revokedAt),
          gt(userSessions.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (rows.length === 0) throw new UnauthorizedException("Session expired or invalid");
    const r = rows[0];
    req.user = { id: r.userId, email: r.email, name: r.name, role: r.role };
    return true;
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private authGuard: AuthGuard) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.authGuard.canActivate(context);
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (req.user?.role !== "admin") throw new ForbiddenException("Admin access required");
    return true;
  }
}

/** Validate a payload against a zod schema → 400 with issues on failure. */
export function parseWith<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException({
      message: "Validation failed",
      issues: result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  return result.data;
}

export { BadRequestException, NotFoundException, UnauthorizedException };
