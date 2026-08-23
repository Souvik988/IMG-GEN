/**
 * Shotlin Worker — BullMQ workflow engine entry point.
 */

import { loadRootEnv } from "@shotlin/database";
import {
  createGenerationWorker,
  createRedisConnection,
  createLogger,
} from "@shotlin/platform";
import { resolveProviders } from "@shotlin/providers";
import { createDb } from "@shotlin/database";
import { createStorage, getAppConfig } from "@shotlin/platform";
import { processGenerationJob, type ProcessorDeps } from "./processor";
import type { Worker } from "bullmq";
import type { GenerationJobData } from "@shotlin/platform";

loadRootEnv();
const config = getAppConfig();
const log = createLogger("worker.main");

// ── Bootstrap dependencies ────────────────────────────────────────────────────
const { db, pool } = createDb(config.DATABASE_URL, 3);
const lockRedis = createRedisConnection(config.REDIS_URL);
const storage = createStorage(config);
const providers = resolveProviders();

const deps: ProcessorDeps = { db, storage, providers, lockRedis };

// ── Create BullMQ worker ──────────────────────────────────────────────────────
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY ?? "2", 10);

const worker: Worker<GenerationJobData> = createGenerationWorker(
  config.REDIS_URL,
  async (job) => {
    const jobId = job.data.jobId;
    log.info("received job", { jobId, bullJobId: job.id });
    await processGenerationJob(jobId, deps);
  },
  CONCURRENCY,
);

worker.on("completed", (job) => {
  log.info("job completed", { jobId: job?.data?.jobId, bullJobId: job?.id });
});

worker.on("failed", (job, err) => {
  log.error("job failed", { jobId: job?.data?.jobId, bullJobId: job?.id, error: err.message, stack: err.stack });
});

worker.on("error", (err) => {
  log.error("worker error", { error: err.message });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
const shutdown = async () => {
  log.info("shutting down");
  await worker.close();
  await lockRedis.quit();
  await pool.end();
  log.info("shutdown complete");
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

log.info("listening", { queue: config.REDIS_URL, concurrency: CONCURRENCY });
