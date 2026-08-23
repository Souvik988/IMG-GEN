import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from "@nestjs/common";
import { createRedisConnection } from "@shotlin/platform";
import { REDIS } from "../infrastructure";

const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 20;

/**
 * Blunt brute-force guard for unauthenticated auth endpoints (login,
 * register), keyed by client IP since there's no session yet to key on —
 * unlike GenerationRateLimitGuard, which keys per-user. Deliberately
 * generous (20/15min) so a legitimate user retyping a password isn't locked
 * out, but bounds an unbounded password-guessing loop, which is what
 * existed before this guard.
 *
 * Known limitation: keys on `request.ip`, which is only trustworthy for
 * direct connections. A deployment behind a reverse proxy needs Fastify's
 * `trustProxy` configured (and the proxy's own header sanitization trusted)
 * before this reflects real client IPs — not configured here since that's a
 * deployment-topology decision, not a code default to guess at. This also
 * doesn't rate-limit per-account (e.g. by email), so a distributed attacker
 * rotating source IPs could still brute-force one specific account within
 * this guard's limits — a further hardening step, not attempted here.
 */
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  constructor(@Inject(REDIS) private readonly redis: ReturnType<typeof createRedisConnection>) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ ip?: string }>();
    const ip = request.ip ?? "unknown";

    const key = `shotlin:rate-limit:auth:${ip}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.pexpire(key, WINDOW_MS);
    if (count > MAX_ATTEMPTS) {
      const response = context.switchToHttp().getResponse<{ header?: (name: string, value: string) => void }>();
      response.header?.("Retry-After", String(Math.ceil(WINDOW_MS / 1000)));
      throw new HttpException(
        "Too many attempts. Please wait before trying again.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
