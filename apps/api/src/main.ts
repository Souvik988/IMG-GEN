import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { AppModule } from "./app.module";
import { getAppConfig } from "@shotlin/platform";

async function bootstrap() {
  const config = getAppConfig();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: 1_048_576 }), // small bodies only; uploads go via presigned URLs
  );

  const instance = app.getHttpAdapter().getInstance();
  // Cast needed: the plugins augment the fastify type provider, which conflicts
  // with Nest's typed adapter instance (runtime behaviour is unaffected).
  await instance.register(cookie as never);

  // This API only ever serves JSON behind `/api` — no server-rendered HTML,
  // so a full CSP/helmet setup would mostly be dead weight. These are the
  // handful of headers that matter for a credentialed-cookie JSON API:
  // stop MIME-sniffing, stop the API being framed (clickjacking), avoid
  // leaking full referrer URLs to third parties, and require HTTPS going
  // forward once actually deployed over it.
  instance.addHook("onSend", (_req: unknown, reply: { header: (name: string, value: string) => void }, payload: unknown, done: (err: Error | null, payload: unknown) => void) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    if (config.NODE_ENV === "production") {
      reply.header("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    }
    done(null, payload);
  });
  // The localhost dev-server origin is only ever reachable from the
  // developer's own machine, but there's no reason to keep it in the
  // allowlist once deployed — a stray production CORS entry that can never
  // legitimately be exercised is still a smaller attack surface removed.
  const corsOrigins =
    config.NODE_ENV === "production" ? [config.WEB_URL] : [config.WEB_URL, "http://localhost:3100"];
  await instance.register(cors as never, {
    origin: corsOrigins,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  app.setGlobalPrefix("api");
  await app.listen(config.API_PORT, "0.0.0.0");
  console.log(`✓ shotlin api listening on :${config.API_PORT}`);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
