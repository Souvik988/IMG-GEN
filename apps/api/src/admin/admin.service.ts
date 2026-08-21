import { Inject, Injectable } from "@nestjs/common";
import { desc, eq, sql } from "drizzle-orm";
import {
  adminAuditEvents,
  budgetRules,
  costEvents,
  jobs,
  modelRegistry,
} from "@shotlin/database";
import { DB, type ApiDb } from "../infrastructure";

@Injectable()
export class AdminService {
  constructor(@Inject(DB) private db: ApiDb) {}

  /** Record a production configuration change (audit). */
  async audit(
    userId: string,
    action: string,
    entityType: string,
    entityId: string | null,
    payload?: Record<string, unknown>,
  ) {
    await this.db.insert(adminAuditEvents).values({
      userId,
      action,
      entityType,
      entityId,
      payload: payload ?? null,
    });
  }

  async getBudgetRules() {
    const rows = await this.db.select().from(budgetRules).limit(1);
    if (rows.length === 0) {
      const [created] = await this.db
        .insert(budgetRules)
        .values({ singletonKey: "global" })
        .returning();
      return created;
    }
    return rows[0];
  }

  /** Cost dashboard aggregations computed live from cost_events. */
  async costSummary() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [todayRow] = await this.db
      .select({
        inr: sql<string>`coalesce(sum(${costEvents.inrCost}), 0)`,
        usd: sql<string>`coalesce(sum(${costEvents.usdCost}), 0)`,
      })
      .from(costEvents)
      .where(sql`${costEvents.createdAt} >= ${todayStart.toISOString()}`);

    const [totalRow] = await this.db
      .select({
        inr: sql<string>`coalesce(sum(${costEvents.inrCost}), 0)`,
        usd: sql<string>`coalesce(sum(${costEvents.usdCost}), 0)`,
      })
      .from(costEvents);

    const byModel = await this.db
      .select({
        modelId: costEvents.modelId,
        provider: costEvents.provider,
        calls: sql<string>`count(*)`,
        inr: sql<string>`coalesce(sum(${costEvents.inrCost}), 0)`,
        usd: sql<string>`coalesce(sum(${costEvents.usdCost}), 0)`,
      })
      .from(costEvents)
      .groupBy(costEvents.modelId, costEvents.provider);

    const byProvider = await this.db
      .select({
        provider: costEvents.provider,
        calls: sql<string>`count(*)`,
        inr: sql<string>`coalesce(sum(${costEvents.inrCost}), 0)`,
      })
      .from(costEvents)
      .groupBy(costEvents.provider);

    const daily = await this.db
      .select({
        day: sql<string>`to_char(${costEvents.createdAt}::date, 'YYYY-MM-DD')`,
        inr: sql<string>`coalesce(sum(${costEvents.inrCost}), 0)`,
      })
      .from(costEvents)
      .where(sql`${costEvents.createdAt} >= now() - interval '14 days'`)
      .groupBy(sql`to_char(${costEvents.createdAt}::date, 'YYYY-MM-DD')`)
      .orderBy(sql`to_char(${costEvents.createdAt}::date, 'YYYY-MM-DD')`);

    // Successful-image economics: cost per delivered image by resolution.
    const successByResolution = await this.db
      .select({
        resolution: jobs.requestedResolution,
        successfulJobs: sql<string>`count(*)`,
        totalInr: sql<string>`coalesce(sum(${jobs.totalCostInr}), 0)`,
      })
      .from(jobs)
      .where(eq(jobs.state, "ready"))
      .groupBy(jobs.requestedResolution);

    // Failed spend: cost of jobs that never delivered.
    const [failedRow] = await this.db
      .select({
        inr: sql<string>`coalesce(sum(${jobs.totalCostInr}), 0)`,
        jobs: sql<string>`count(*)`,
      })
      .from(jobs)
      .where(sql`${jobs.state} in ('failed','budget_stopped','input_rejected')`);

    const byResolution = successByResolution.map((r) => {
      const successful = Number(r.successfulJobs);
      const totalInr = Number(r.totalInr);
      const images = successful; // MVP: one delivered image per ready job
      return {
        resolution: r.resolution,
        successfulJobs: successful,
        totalInr: Number(totalInr.toFixed(2)),
        avgInrPerImage: images > 0 ? Number((totalInr / images).toFixed(2)) : 0,
      };
    });

    return {
      today: {
        inr: Number(Number(todayRow?.inr ?? 0).toFixed(2)),
        usd: Number(Number(todayRow?.usd ?? 0).toFixed(4)),
      },
      total: {
        inr: Number(Number(totalRow?.inr ?? 0).toFixed(2)),
        usd: Number(Number(totalRow?.usd ?? 0).toFixed(4)),
      },
      byModel: byModel.map((m) => ({
        modelId: m.modelId,
        provider: m.provider,
        calls: Number(m.calls),
        inr: Number(Number(m.inr).toFixed(2)),
        usd: Number(Number(m.usd).toFixed(4)),
      })),
      byProvider: byProvider.map((p) => ({
        provider: p.provider,
        calls: Number(p.calls),
        inr: Number(Number(p.inr).toFixed(2)),
      })),
      daily: daily.map((d) => ({ day: d.day, inr: Number(Number(d.inr).toFixed(2)) })),
      byResolution,
      failed: {
        inr: Number(Number(failedRow?.inr ?? 0).toFixed(2)),
        jobs: Number(failedRow?.jobs ?? 0),
      },
    };
  }

  /** Overview dashboard metrics. */
  async overview() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [jobsToday] = await this.db
      .select({ n: sql<string>`count(*)` })
      .from(jobs)
      .where(sql`${jobs.createdAt} >= ${todayStart.toISOString()}`);

    const stateCounts = await this.db
      .select({ state: jobs.state, n: sql<string>`count(*)` })
      .from(jobs)
      .groupBy(jobs.state);

    const [readyRow] = await this.db
      .select({
        n: sql<string>`count(*)`,
        avgCostInr: sql<string>`coalesce(avg(${jobs.totalCostInr}), 0)`,
      })
      .from(jobs)
      .where(eq(jobs.state, "ready"));

    const readyAttemptRows = await this.db.execute(sql`
      select coalesce(avg(attempt_count), 0) as avg_attempts
      from (
        select j.id, count(ja.id)::numeric as attempt_count
        from jobs j
        left join job_attempts ja on ja.job_id = j.id
        where j.state = 'ready'
        group by j.id
      ) ready_attempts
    `);

    const resolutionMix = await this.db
      .select({
        resolution: jobs.requestedResolution,
        n: sql<string>`count(*)`,
      })
      .from(jobs)
      .groupBy(jobs.requestedResolution);

    const topDefects = await this.db.execute(sql`
      select code, count(*) as n
      from defects
      group by code
      order by n desc
      limit 10
    `);

    const firstPass = await this.db.execute(sql`
      select
        count(*) filter (where first_attempt_passed) as passed,
        count(*) as total
      from (
        select j.id,
          exists(
            select 1 from job_attempts ja
            where ja.job_id = j.id and ja.attempt_number = 1 and ja.status = 'passed'
          ) as first_attempt_passed
        from jobs j
        where j.state = 'ready'
      ) t
    `);

    return {
      jobsToday: Number(jobsToday?.n ?? 0),
      stateCounts: stateCounts.map((s) => ({ state: s.state, count: Number(s.n) })),
      successfulImages: Number(readyRow?.n ?? 0),
      avgAttemptsPerSuccess: Number(Number((readyAttemptRows.rows[0] as { avg_attempts?: string } | undefined)?.avg_attempts ?? 0).toFixed(2)),
      avgCostInrPerSuccess: Number(Number(readyRow?.avgCostInr ?? 0).toFixed(2)),
      resolutionMix: resolutionMix.map((r) => ({
        resolution: r.resolution,
        count: Number(r.n),
      })),
      topDefects: (topDefects.rows as Array<{ code: string; n: string }>).map((d) => ({
        code: d.code,
        count: Number(d.n),
      })),
      firstPassAcceptance: (firstPass.rows as Array<{ passed: string; total: string }>)[0]
        ? {
            passed: Number((firstPass.rows as Array<{ passed: string }>)[0].passed),
            total: Number((firstPass.rows as Array<{ total: string }>)[0].total),
          }
        : { passed: 0, total: 0 },
    };
  }

  async recentAudit(limit = 50) {
    return this.db
      .select()
      .from(adminAuditEvents)
      .orderBy(desc(adminAuditEvents.createdAt))
      .limit(limit);
  }

  async modelNamesById() {
    const rows = await this.db
      .select({ id: modelRegistry.id, name: modelRegistry.name, modelId: modelRegistry.modelId })
      .from(modelRegistry);
    return Object.fromEntries(rows.map((r) => [r.id, r]));
  }
}
