/**
 * Shotlin Worker — BullMQ workflow engine entry point.
 */

import { loadRootEnv } from "@shotlin/database";
import {
  createGenerationWorker,
  createRedisConnection,
} from "@shotlin/platform";
import { resolveProviders } from "@shotlin/providers";
import { createDb } from "@shotlin/database";
import { createStorage, getAppConfig } from "@shotlin/platform";
import { processGenerationJob, type ProcessorDeps } from "./processor";
import type { Worker } from "bullmq";
import type { GenerationJobData } from "@shotlin/platform";

loadRootEnv();
const config = getAppConfig();

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
    console.log(`[worker] received job ${jobId}`);
    await processGenerationJob(jobId, deps);
  },
  CONCURRENCY,
);

worker.on("completed", (job) => {
  console.log(`[worker] job ${job?.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] job ${job?.id} failed: ${err.message}`);
  if (err.stack) console.error(err.stack);
});

worker.on("error", (err) => {
  console.error("[worker] worker error:", err.message);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
const shutdown = async () => {
  console.log("[worker] shutting down...");
  await worker.close();
  await lockRedis.quit();
  await pool.end();
  console.log("[worker] shutdown complete");
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(
  `[worker] listening | queue="${config.REDIS_URL}" | concurrency=${CONCURRENCY}`,
);
