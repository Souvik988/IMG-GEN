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
  await instance.register(cors as never, {
    origin: [config.WEB_URL, "http://localhost:3100"],
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
