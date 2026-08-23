import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  assets,
  characterIdentityReferences,
  characters,
  costEvents,
  defects,
  environmentPresets,
  generationCandidates,
  jobAttempts,
  jobInputs,
  jobOutputs,
  jobStateEvents,
  jobStepRuns,
  jobs,
  promptVersions,
  qualityReviews,
  users,
  workflowNodes,
} from "@shotlin/database";
import type { Storage } from "@shotlin/platform";
import { z } from "zod";
import { AdminGuard, parseWith } from "../common";
import type { AuthedRequest } from "../types";
import { DB, STORAGE, type ApiDb } from "../infrastructure";
import { AdminService } from "./admin.service";

type CostModelName = { name: string; modelId: string };
type CostModelSubtotal = {
  modelKey: string;
  provider: string;
  modelName: string | null;
  modelIdLabel: string | null;
  nodes: string[];
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  imageCount: number;
  providerReportedLines: number;
  configuredPriceLines: number;
  usdCost: number;
  inrCost: number;
  pricingBasis: "provider_reported" | "configured_price" | "mixed";
};

function costBasis(row: typeof costEvents.$inferSelect): "provider_reported" | "configured_price" | "deterministic" {
  if (row.provider === "deterministic") return "deterministic";
  return row.providerReportedCostUsd != null ? "provider_reported" : "configured_price";
}

function costTotals(rows: Array<typeof costEvents.$inferSelect>) {
  const inputTokens = rows.reduce((sum, row) => sum + row.inputTokens, 0);
  const outputTokens = rows.reduce((sum, row) => sum + row.outputTokens, 0);
  const imageCount = rows.reduce((sum, row) => sum + row.imageCount, 0);
  const apiRows = rows.filter((row) => row.provider !== "deterministic");
  const reportedRows = rows.filter((row) => row.providerReportedCostUsd != null);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    imageCount,
    workflowSteps: rows.length,
    apiCalls: apiRows.length,
    deterministicSteps: rows.length - apiRows.length,
    providerReportedCalls: reportedRows.length,
    configuredPriceCalls: apiRows.length - reportedRows.length,
    usdCost: Number(rows.reduce((sum, row) => sum + Number(row.usdCost), 0).toFixed(8)),
    inrCost: Number(rows.reduce((sum, row) => sum + Number(row.inrCost), 0).toFixed(2)),
    fxRate: Number(rows[0]?.fxRate ?? 1),
  };
}

function costModelSubtotals(
  rows: Array<typeof costEvents.$inferSelect>,
  modelNames: Record<string, CostModelName>,
): CostModelSubtotal[] {
  const grouped = new Map<string, CostModelSubtotal>();
  for (const row of rows) {
    if (row.provider === "deterministic") continue;
    const modelKey = row.modelId ?? `${row.provider}:${row.nodeKey}`;
    const modelName = row.modelId ? modelNames[row.modelId]?.name ?? null : null;
    const modelIdLabel = row.modelId ? modelNames[row.modelId]?.modelId ?? null : null;
    const existing = grouped.get(modelKey) ?? {
      modelKey,
      provider: row.provider,
      modelName,
      modelIdLabel,
      nodes: [],
      apiCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      imageCount: 0,
      providerReportedLines: 0,
      configuredPriceLines: 0,
      usdCost: 0,
      inrCost: 0,
      pricingBasis: "configured_price" as const,
    };
    existing.apiCalls += 1;
    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    existing.totalTokens += row.inputTokens + row.outputTokens;
    existing.imageCount += row.imageCount;
    existing.providerReportedLines += row.providerReportedCostUsd != null ? 1 : 0;
    existing.configuredPriceLines += row.providerReportedCostUsd == null ? 1 : 0;
    existing.usdCost += Number(row.usdCost);
    existing.inrCost += Number(row.inrCost);
    if (!existing.nodes.includes(row.nodeKey)) existing.nodes.push(row.nodeKey);
    existing.pricingBasis = existing.providerReportedLines === existing.apiCalls
      ? "provider_reported"
      : existing.configuredPriceLines === existing.apiCalls
        ? "configured_price"
        : "mixed";
    grouped.set(modelKey, existing);
  }
  return [...grouped.values()]
    .map((row) => ({
      ...row,
      usdCost: Number(row.usdCost.toFixed(8)),
      inrCost: Number(row.inrCost.toFixed(2)),
    }))
    .sort((a, b) => b.inrCost - a.inrCost);
}

function serializeCostRows(
  rows: Array<typeof costEvents.$inferSelect>,
  stepRuns: Array<typeof jobStepRuns.$inferSelect>,
  modelNames: Record<string, CostModelName>,
) {
  const stepById = new Map(stepRuns.map((step) => [step.id, step]));
  return rows.map((row) => ({
    ...row,
    modelName: row.modelId ? modelNames[row.modelId]?.name ?? null : null,
    modelIdLabel: row.modelId ? modelNames[row.modelId]?.modelId ?? null : null,
    totalTokens: row.inputTokens + row.outputTokens,
    costBasis: costBasis(row),
    stepStatus: row.stepRunId ? stepById.get(row.stepRunId)?.status ?? null : null,
    durationMs: row.stepRunId ? stepById.get(row.stepRunId)?.durationMs ?? null : null,
  }));
}

/* ------------------------------------------------------------------ */
/* Jobs list + inspector                                               */
/* ------------------------------------------------------------------ */

@Controller("/admin/jobs")
@UseGuards(AdminGuard)
class AdminJobsController {
  constructor(
    @Inject(DB) private db: ApiDb,
    @Inject(STORAGE) private storage: Storage,
    private admin: AdminService,
  ) {}

  @Get()
  async list(
    @Query("state") state?: string,
    @Query("limit") limit?: string,
  ) {
    const maxLimit = Math.min(Number(limit ?? 50) || 50, 200);
    const rows = state
      ? await this.db
          .select({
            job: jobs,
            userEmail: users.email,
          })
          .from(jobs)
          .innerJoin(users, eq(users.id, jobs.userId))
          .where(eq(jobs.state, state as never))
          .orderBy(desc(jobs.createdAt))
          .limit(maxLimit)
      : await this.db
          .select({
            job: jobs,
            userEmail: users.email,
          })
          .from(jobs)
          .innerJoin(users, eq(users.id, jobs.userId))
          .orderBy(desc(jobs.createdAt))
          .limit(maxLimit);
    return { jobs: rows.map((r) => ({ ...r.job, userEmail: r.userEmail })) };
  }

  /** Full job inspector: everything needed to diagnose a generation run. */
  @Get("/:id")
  async inspect(@Param("id") id: string) {
    const jobRow = (
      await this.db
        .select({ job: jobs, userEmail: users.email })
        .from(jobs)
        .innerJoin(users, eq(users.id, jobs.userId))
        .where(eq(jobs.id, id))
        .limit(1)
    )[0];
    if (!jobRow) throw new NotFoundException("Job not found");
    const job = jobRow.job;

    const [inputs, attempts, stepRuns, candidates, reviews, defectRows, outputs, stateEvents, costRows, workflowNodeRows] =
      await Promise.all([
        this.db.select().from(jobInputs).where(eq(jobInputs.jobId, id)),
        this.db
          .select()
          .from(jobAttempts)
          .where(eq(jobAttempts.jobId, id))
          .orderBy(jobAttempts.attemptNumber),
        this.db
          .select()
          .from(jobStepRuns)
          .where(eq(jobStepRuns.jobId, id))
          .orderBy(jobStepRuns.startedAt),
        this.db
          .select()
          .from(generationCandidates)
          .where(eq(generationCandidates.jobId, id))
          .orderBy(generationCandidates.createdAt),
        this.db.select().from(qualityReviews),
        this.db.select().from(defects),
        this.db.select().from(jobOutputs).where(eq(jobOutputs.jobId, id)).limit(1),
        this.db
          .select()
          .from(jobStateEvents)
          .where(eq(jobStateEvents.jobId, id))
          .orderBy(jobStateEvents.createdAt),
        this.db
          .select()
          .from(costEvents)
          .where(eq(costEvents.jobId, id))
          .orderBy(costEvents.createdAt),
        this.db
          .select()
          .from(workflowNodes)
          .where(eq(workflowNodes.workflowVersionId, job.workflowVersionId))
          .orderBy(workflowNodes.sequence),
      ]);

    const candidateIds = candidates.map((c) => c.id);
    const candidateReviews = candidateIds.length
      ? reviews.filter((r) => candidateIds.includes(r.candidateId))
      : [];
    const candidateDefects = candidateIds.length
      ? defectRows.filter((d) => candidateIds.includes(d.candidateId))
      : [];

    // Signed thumbnails for every referenced asset.
    const assetIds = new Set<string>([
      ...inputs.map((i) => i.assetId),
      ...candidates.map((c) => c.assetId),
      job.characterAssetId ?? "",
    ]);
    if (outputs[0]) {
      assetIds.add(outputs[0].masterAssetId);
      if (outputs[0].previewAssetId) assetIds.add(outputs[0].previewAssetId);
      if (outputs[0].jpgAssetId) assetIds.add(outputs[0].jpgAssetId);
    }
    assetIds.delete("");
    const assetRows = assetIds.size
      ? await this.db.select().from(assets).where(inArray(assets.id, [...assetIds]))
      : [];
    const assetUrls = new Map<string, string>();
    for (const a of assetRows) {
      assetUrls.set(a.id, await this.storage.presignGet(a.bucket, a.objectKey, 3600));
    }

    // Prompt version bodies referenced by attempts.
    const promptVersionIds = new Set<string>(
      attempts.map((a) => a.promptVersionId).filter((v): v is string => Boolean(v)),
    );
    const promptRows = promptVersionIds.size
      ? await this.db
          .select({ id: promptVersions.id, version: promptVersions.version, status: promptVersions.status })
          .from(promptVersions)
          .where(inArray(promptVersions.id, [...promptVersionIds]))
      : [];

    const modelNames = await this.admin.modelNamesById();
    const serializedCostRows = serializeCostRows(costRows, stepRuns, modelNames);

    return {
      job: { ...job, userEmail: jobRow.userEmail },
      inputs: inputs.map((i) => ({
        ...i,
        asset: assetRows.find((a) => a.id === i.assetId) ?? null,
        assetUrl: assetUrls.get(i.assetId) ?? null,
      })),
      truthSheet: job.truthSheet,
      attempts: attempts.map((a) => ({
        ...a,
        promptVersion: promptRows.find((p) => p.id === a.promptVersionId) ?? null,
      })),
      stepRuns,
      workflowNodes: workflowNodeRows,
      candidates: candidates.map((c) => ({
        ...c,
        assetUrl: assetUrls.get(c.assetId) ?? null,
        reviews: candidateReviews
          .filter((r) => r.candidateId === c.id)
          .map((r) => ({
            ...r,
            reviewerModel: r.reviewerModelId ? modelNames[r.reviewerModelId] : null,
            defects: candidateDefects.filter((d) => d.qualityReviewId === r.id),
          })),
      })),
      output: outputs[0]
        ? {
            ...outputs[0],
            masterUrl: assetUrls.get(outputs[0].masterAssetId) ?? null,
            previewUrl: outputs[0].previewAssetId ? assetUrls.get(outputs[0].previewAssetId) ?? null : null,
            jpgUrl: outputs[0].jpgAssetId ? assetUrls.get(outputs[0].jpgAssetId) ?? null : null,
          }
        : null,
      stateEvents,
      costTotals: costTotals(costRows),
      costModels: costModelSubtotals(costRows, modelNames),
      costEvents: serializedCostRows,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Costs & overview                                                    */
/* ------------------------------------------------------------------ */

@Controller("/admin/costs")
@UseGuards(AdminGuard)
class AdminCostsController {
  constructor(
    private admin: AdminService,
    @Inject(DB) private db: ApiDb,
  ) {}

  @Get()
  async costs() {
    const [summary, rules, modelNames] = await Promise.all([
      this.admin.costSummary(),
      this.admin.getBudgetRules(),
      this.admin.modelNamesById(),
    ]);
    return {
      ...summary,
      byModel: summary.byModel.map((m) => ({
        ...m,
        modelName: m.modelId ? (modelNames[m.modelId]?.name ?? m.modelId) : "Deterministic / no model",
      })),
      configured: {
        warnInr: Number(rules.warnInr),
        hardStopInr: Number(rules.hardStopInr),
        planningBudget1kInr: Number(rules.planningBudget1kInr),
        planningBudget2kInr: Number(rules.planningBudget2kInr),
        planningBudget4kInr: Number(rules.planningBudget4kInr),
        usdInrRate: Number(rules.usdInrRate),
      },
    };
  }

  /** Per-image history, aggregated across every workflow step and attempt. */
  @Get("/history")
  async history(@Query("limit") limit?: string) {
    const maxLimit = Math.min(Number(limit ?? 30) || 30, 100);
    const rows = await this.db
      .select({
        jobId: jobs.id,
        state: jobs.state,
        resolution: jobs.requestedResolution,
        outputCount: jobs.outputCount,
        jobTotalInr: jobs.totalCostInr,
        createdAt: jobs.createdAt,
        inputTokens: sql<string>`coalesce(sum(${costEvents.inputTokens}), 0)`,
        outputTokens: sql<string>`coalesce(sum(${costEvents.outputTokens}), 0)`,
        imageCount: sql<string>`coalesce(sum(${costEvents.imageCount}), 0)`,
        workflowSteps: sql<string>`count(${costEvents.id})`,
        apiCalls: sql<string>`count(${costEvents.id}) filter (where ${costEvents.provider} <> 'deterministic')`,
        inrCost: sql<string>`coalesce(sum(${costEvents.inrCost}), 0)`,
      })
      .from(jobs)
      .leftJoin(costEvents, eq(costEvents.jobId, jobs.id))
      .groupBy(jobs.id, jobs.state, jobs.requestedResolution, jobs.outputCount, jobs.totalCostInr, jobs.createdAt)
      .orderBy(desc(jobs.createdAt))
      .limit(maxLimit);

    const jobIds = rows.map((row) => row.jobId);
    const [historyCostRows, modelNames] = await Promise.all([
      jobIds.length
        ? this.db.select().from(costEvents).where(inArray(costEvents.jobId, jobIds))
        : Promise.resolve([]),
      this.admin.modelNamesById(),
    ]);
    const costRowsByJob = new Map<string, Array<typeof costEvents.$inferSelect>>();
    for (const row of historyCostRows) {
      if (!row.jobId) continue;
      const group = costRowsByJob.get(row.jobId) ?? [];
      group.push(row);
      costRowsByJob.set(row.jobId, group);
    }

    return {
      history: rows.map((row) => ({
        ...row,
        models: costModelSubtotals(costRowsByJob.get(row.jobId) ?? [], modelNames),
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        totalTokens: Number(row.inputTokens) + Number(row.outputTokens),
        imageCount: Number(row.imageCount),
        workflowSteps: Number(row.workflowSteps),
        apiCalls: Number(row.apiCalls),
        ledgerInr: Number(Number(row.inrCost).toFixed(2)),
        jobTotalInr: Number(Number(row.jobTotalInr).toFixed(2)),
        costPerOutputInr: Number(
          (
            (Number(row.jobTotalInr) || Number(row.inrCost)) /
            Math.max(Number(row.outputCount), 1)
          ).toFixed(2),
        ),
      })),
    };
  }

  /** Per-job cost trace. */
  @Get("/:jobId")
  async jobTrace(@Param("jobId") jobId: string) {
    const [rows, stepRuns] = await Promise.all([
      this.db
        .select()
        .from(costEvents)
        .where(eq(costEvents.jobId, jobId))
        .orderBy(costEvents.createdAt),
      this.db
        .select()
        .from(jobStepRuns)
        .where(eq(jobStepRuns.jobId, jobId))
        .orderBy(jobStepRuns.startedAt),
    ]);
    const modelNames = await this.admin.modelNamesById();
    const events = serializeCostRows(rows, stepRuns, modelNames);
    const totals = costTotals(rows);
    return {
      jobId,
      events,
      totals,
      models: costModelSubtotals(rows, modelNames),
      totalInr: totals.inrCost,
    };
  }
}

@Controller("/admin/overview")
@UseGuards(AdminGuard)
class AdminOverviewController {
  constructor(private admin: AdminService) {}

  @Get()
  async overview() {
    return this.admin.overview();
  }
}

/* ------------------------------------------------------------------ */
/* Characters & environments CRUD                                      */
/* ------------------------------------------------------------------ */

@Controller("/admin/characters")
@UseGuards(AdminGuard)
class AdminCharactersController {
  constructor(
    @Inject(DB) private db: ApiDb,
    private admin: AdminService,
  ) {}

  @Get()
  async list() {
    return { characters: await this.db.select().from(characters).orderBy(characters.sortOrder) };
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: unknown) {
    const schema = z.object({
      name: z.string().min(1).max(120),
      description: z.string().max(500).optional(),
      attributes: z.record(z.unknown()).default({}),
      isEnabled: z.boolean().default(true),
      sortOrder: z.number().int().default(100),
      previewAssetId: z.string().uuid().nullable().optional(),
    });
    const input = parseWith(schema, body);
    if (input.previewAssetId) await this.assertUsableAsset(input.previewAssetId);
    const [row] = await this.db
      .insert(characters)
      .values({ ...input, isPreset: true, description: input.description ?? null })
      .returning();
    await this.admin.audit(req.user!.id, "character.create", "character", row.id, input);
    return { character: row };
  }

  @Put("/:id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    const schema = z.object({
      name: z.string().min(1).max(120).optional(),
      description: z.string().max(500).nullable().optional(),
      attributes: z.record(z.unknown()).optional(),
      isEnabled: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
      previewAssetId: z.string().uuid().nullable().optional(),
    });
    const input = parseWith(schema, body);
    if (input.previewAssetId) await this.assertUsableAsset(input.previewAssetId);
    const [row] = await this.db
      .update(characters)
      .set(input)
      .where(eq(characters.id, id))
      .returning();
    if (!row) throw new NotFoundException("Character not found");
    await this.admin.audit(req.user!.id, "character.update", "character", id, input);
    return { character: row };
  }

  /**
   * Reference photos are uploaded through the generic /uploads presign flow
   * (kind: "character_reference") before being attached here. Reject
   * anything that hasn't cleared that pipeline's validation, so a broken or
   * rejected upload can never silently become a catalog character's
   * identity lock.
   */
  private async assertUsableAsset(assetId: string) {
    const [asset] = await this.db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
    if (!asset) throw new NotFoundException("Asset not found");
    if (asset.validationStatus !== "usable") {
      throw new BadRequestException(
        `Asset ${assetId} is not usable (status: ${asset.validationStatus}) — complete upload validation first`,
      );
    }
  }

  /** The structured identity pack — up to one photo per angle role. */
  @Get("/:id/identity-references")
  async listIdentityReferences(@Param("id") id: string) {
    const rows = await this.db
      .select()
      .from(characterIdentityReferences)
      .where(eq(characterIdentityReferences.characterId, id));
    return { identityReferences: rows };
  }

  @Put("/:id/identity-references/:role")
  async setIdentityReference(
    @Req() req: AuthedRequest,
    @Param("id") id: string,
    @Param("role") role: string,
    @Body() body: unknown,
  ) {
    const roleSchema = z.enum(["front", "three_quarter", "full_body"]);
    const parsedRole = roleSchema.safeParse(role);
    if (!parsedRole.success) {
      throw new BadRequestException("role must be one of: front, three_quarter, full_body");
    }
    const input = parseWith(z.object({ assetId: z.string().uuid() }), body);
    await this.assertUsableAsset(input.assetId);

    const [char] = await this.db.select().from(characters).where(eq(characters.id, id)).limit(1);
    if (!char) throw new NotFoundException("Character not found");

    const [row] = await this.db
      .insert(characterIdentityReferences)
      .values({ characterId: id, role: parsedRole.data, assetId: input.assetId })
      .onConflictDoUpdate({
        target: [characterIdentityReferences.characterId, characterIdentityReferences.role],
        set: { assetId: input.assetId },
      })
      .returning();
    await this.admin.audit(req.user!.id, "character.identity_reference.set", "character", id, {
      role: parsedRole.data,
      assetId: input.assetId,
    });
    return { identityReference: row };
  }

  @Delete("/:id/identity-references/:role")
  async removeIdentityReference(@Req() req: AuthedRequest, @Param("id") id: string, @Param("role") role: string) {
    const roleSchema = z.enum(["front", "three_quarter", "full_body"]);
    const parsedRole = roleSchema.safeParse(role);
    if (!parsedRole.success) {
      throw new BadRequestException("role must be one of: front, three_quarter, full_body");
    }
    await this.db
      .delete(characterIdentityReferences)
      .where(
        and(
          eq(characterIdentityReferences.characterId, id),
          eq(characterIdentityReferences.role, parsedRole.data),
        ),
      );
    await this.admin.audit(req.user!.id, "character.identity_reference.remove", "character", id, {
      role: parsedRole.data,
    });
    return { ok: true };
  }
}

@Controller("/admin/environments")
@UseGuards(AdminGuard)
class AdminEnvironmentsController {
  constructor(
    @Inject(DB) private db: ApiDb,
    private admin: AdminService,
  ) {}

  @Get()
  async list() {
    return {
      environments: await this.db
        .select()
        .from(environmentPresets)
        .orderBy(environmentPresets.sortOrder),
    };
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: unknown) {
    const schema = z.object({
      key: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/),
      name: z.string().min(1).max(120),
      category: z.string().min(1).max(60),
      description: z.string().max(500).optional(),
      promptFragment: z.string().min(1).max(2000),
      isEnabled: z.boolean().default(true),
      sortOrder: z.number().int().default(100),
    });
    const input = parseWith(schema, body);
    const [row] = await this.db
      .insert(environmentPresets)
      .values({ ...input, description: input.description ?? null })
      .returning();
    await this.admin.audit(req.user!.id, "environment.create", "environment", row.id, input);
    return { environment: row };
  }

  @Put("/:id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    const schema = z.object({
      name: z.string().min(1).max(120).optional(),
      category: z.string().min(1).max(60).optional(),
      description: z.string().max(500).nullable().optional(),
      promptFragment: z.string().min(1).max(2000).optional(),
      isEnabled: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
    });
    const input = parseWith(schema, body);
    const [row] = await this.db
      .update(environmentPresets)
      .set(input)
      .where(eq(environmentPresets.id, id))
      .returning();
    if (!row) throw new NotFoundException("Environment not found");
    await this.admin.audit(req.user!.id, "environment.update", "environment", id, input);
    return { environment: row };
  }
}

export {
  AdminJobsController,
  AdminCostsController,
  AdminOverviewController,
  AdminCharactersController,
  AdminEnvironmentsController,
};
