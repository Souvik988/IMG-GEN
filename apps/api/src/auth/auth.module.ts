import {
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { userSessions, users } from "@shotlin/database";
import { getAppConfig, hashPassword, verifyPassword } from "@shotlin/platform";
import { z } from "zod";
import { AuthGuard, hashSessionToken, parseWith } from "../common";
import type { AuthedRequest, Reply } from "../types";
import { DB, type ApiDb } from "../infrastructure";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(120).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
});

const SESSION_COOKIE = "shotlin_session";

function setSessionCookie(reply: Reply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // local MVP over http
    path: "/",
    maxAge: getAppConfig().SESSION_TTL_HOURS * 3600,
  });
}

function clearSessionCookie(reply: Reply) {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

@Injectable()
class AuthService {
  constructor(@Inject(DB) private db: ApiDb) {}

  async register(body: unknown) {
    const input = parseWith(registerSchema, body);
    const email = input.email.toLowerCase();
    const existing = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing.length > 0) throw new ConflictException("Email already registered");

    const inserted = await this.db
      .insert(users)
      .values({
        email,
        name: input.name ?? email.split("@")[0],
        role: "customer",
        passwordHash: hashPassword(input.password),
      })
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
      });
    return inserted[0];
  }

  async login(body: unknown) {
    const input = parseWith(loginSchema, body);
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.email, input.email.toLowerCase()))
      .limit(1);
    const user = rows[0];
    if (!user || !verifyPassword(input.password, user.passwordHash)) {
      throw new UnauthorizedException("Invalid email or password");
    }
    return user;
  }

  async createSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString("hex");
    const ttlHours = getAppConfig().SESSION_TTL_HOURS;
    await this.db.insert(userSessions).values({
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + ttlHours * 3600 * 1000),
    });
    return token;
  }

  async logout(req: AuthedRequest) {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) {
      await this.db
        .update(userSessions)
        .set({ revokedAt: new Date() })
        .where(eq(userSessions.tokenHash, hashSessionToken(token)));
    }
  }
}

@Controller("/auth")
class AuthController {
  constructor(private service: AuthService) {}

  @Post("/register")
  async register(@Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const user = await this.service.register(body);
    const token = await this.service.createSession(user.id);
    setSessionCookie(reply, token);
    return { user };
  }

  @Post("/login")
  async login(@Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    const user = await this.service.login(body);
    const token = await this.service.createSession(user.id);
    setSessionCookie(reply, token);
    return {
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };
  }

  @Post("/logout")
  @UseGuards(AuthGuard)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) reply: Reply) {
    await this.service.logout(req);
    clearSessionCookie(reply);
    return { ok: true };
  }

  @Get("/me")
  @UseGuards(AuthGuard)
  async me(@Req() req: AuthedRequest) {
    return { user: req.user };
  }
}

@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthGuard],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
