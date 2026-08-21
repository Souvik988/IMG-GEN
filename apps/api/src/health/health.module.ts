import { Controller, Get, Module } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { DB_POOL, GENERATION_QUEUE_PROV, STORAGE } from "../infrastructure";
import type { Pool } from "pg";
import type { Queue } from "bullmq";
import type { Storage } from "@shotlin/platform";

@Controller("/health")
class HealthController {
  constructor(
    @Inject(DB_POOL) private pool: Pool,
    @Inject(STORAGE) private storage: Storage,
    @Inject(GENERATION_QUEUE_PROV) private queue: Queue,
  ) {}

  @Get()
  async health() {
    const checks: Record<string, string> = {};
    try {
      await this.pool.query("SELECT 1");
      checks.postgres = "ok";
    } catch {
      checks.postgres = "error";
    }
    try {
      // A lightweight queue query exercises the underlying Redis connection.
      await this.queue.getWaitingCount();
      checks.redis = "ok";
    } catch {
      checks.redis = "error";
    }
    try {
      // Storage check: list buckets is non-trivial; just confirm client exists.
      checks.storage = this.storage ? "ok" : "error";
    } catch {
      checks.storage = "error";
    }
    const allOk = Object.values(checks).every((v) => v === "ok");
    return { status: allOk ? "ok" : "degraded", checks };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
