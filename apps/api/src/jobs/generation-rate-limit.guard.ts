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
import type { AuthedRequest } from "../types";

const WINDOW_MS = 5_000;

/** One new generation request per user per window, shared across API instances. */
@Injectable()
export class GenerationRateLimitGuard implements CanActivate {
  constructor(@Inject(REDIS) private readonly redis: ReturnType<typeof createRedisConnection>) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const userId = request.user?.id;
    if (!userId) return true;

    const key = `shotlin:rate-limit:generate:${userId}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.pexpire(key, WINDOW_MS);
    if (count > 1) {
      const response = context.switchToHttp().getResponse<{ header?: (name: string, value: string) => void }>();
      response.header?.("Retry-After", String(Math.ceil(WINDOW_MS / 1000)));
      throw new HttpException(
        "Generation is already being submitted. Please wait a few seconds.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
