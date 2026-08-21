import { Global, Module } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@shotlin/database";
import {
  createGenerationQueue,
  createRedisConnection,
  createStorage,
  getAppConfig,
  type Storage,
} from "@shotlin/platform";
import type { Queue } from "bullmq";

export const DB = "DB";
export const DB_POOL = "DB_POOL";
export const STORAGE = "STORAGE";
export const GENERATION_QUEUE_PROV = "GENERATION_QUEUE";
export const REDIS = "REDIS";

export type ApiDb = ReturnType<typeof drizzle<typeof schema>>;

const poolProvider: Provider = {
  provide: DB_POOL,
  useFactory: (): Pool => new Pool({ connectionString: getAppConfig().DATABASE_URL, max: 10 }),
};

const dbProvider: Provider = {
  provide: DB,
  inject: [DB_POOL],
  useFactory: (pool: Pool): ApiDb => drizzle(pool, { schema }),
};

const storageProvider: Provider = {
  provide: STORAGE,
  useFactory: (): Storage => createStorage(getAppConfig()),
};

const queueProvider: Provider = {
  provide: GENERATION_QUEUE_PROV,
  useFactory: (): Queue => createGenerationQueue(getAppConfig().REDIS_URL),
};

const redisProvider: Provider = {
  provide: REDIS,
  useFactory: () => createRedisConnection(getAppConfig().REDIS_URL),
};

@Global()
@Module({
  providers: [poolProvider, dbProvider, storageProvider, queueProvider, redisProvider],
  exports: [DB, DB_POOL, STORAGE, GENERATION_QUEUE_PROV, REDIS],
})
export class InfrastructureModule {}
