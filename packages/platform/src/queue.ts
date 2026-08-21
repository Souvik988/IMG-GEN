import { Queue, Worker, type JobsOptions } from "bullmq";
import IORedis from "ioredis";

export const GENERATION_QUEUE = "generation";

/** BullMQ requires maxRetriesPerRequest disabled. */
export function createRedisConnection(url: string): IORedis {
  return new IORedis(url, { maxRetriesPerRequest: null });
}

export function createGenerationQueue(url: string): Queue {
  return new Queue(GENERATION_QUEUE, {
    connection: createRedisConnection(url),
    defaultJobOptions: {
      // A provider/system error must stop for inspection, never replay a
      // potentially billable generation. Intentional image retries are
      // scheduled explicitly by the workflow after a valid QA FAIL.
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 200,
    } satisfies JobsOptions,
  });
}

export type GenerationJobData = { jobId: string };

export function createGenerationWorker(
  url: string,
  processor: (job: { id?: string; data: GenerationJobData }) => Promise<void>,
  concurrency = 2,
): Worker<GenerationJobData> {
  return new Worker<GenerationJobData>(GENERATION_QUEUE, processor, {
    connection: createRedisConnection(url),
    concurrency,
  });
}

/** Alias matching the worker main.ts call. */
export const createWorker = createGenerationWorker;
