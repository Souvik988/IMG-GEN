/**
 * Worker-side database helpers.
 */

import { eq, and, ne, sql } from "drizzle-orm";
import type { Db } from "@shotlin/database";
import * as schema from "@shotlin/database";
import {
  assets,
  budgetRules,
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
  modelPriceVersions,
  modelRegistry,
  promptVersions,
  qualityReviews,
  retryPlans,
  skillRules,
  skillVersions,
  workflowNodeConfigs,
  workflowNodes,
  workflowVersions,
} from "@shotlin/database";
import type {
  Asset,
  BudgetRules,
  CostEvent,
  GenerationCandidate,
  JobAttempt,
  JobOutput,
  JobStepRun,
  ModelRegistry,
  QualityReviewRow,
  RetryPlan,
  WorkflowNode,
  WorkflowNodeConfig,
} from "@shotlin/database";
import type { ResolvedSkillRule } from "./context";
import type { QualityReview } from "@shotlin/core";

// ─── Job loading ──────────────────────────────────────────────────────────────

export async function loadJobData(db: Db, jobId: string) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) throw new Error(`Job ${jobId} not found`);

  const [wfVersion] = await db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.id, job.workflowVersionId))
    .limit(1);
  if (!wfVersion) throw new Error(`Workflow version ${job.workflowVersionId} not found`);

  const nodes = await db
    .select()
    .from(workflowNodes)
    .where(eq(workflowNodes.workflowVersionId, wfVersion.id))
    .orderBy(workflowNodes.sequence);

  const allConfigs = await db.select().from(workflowNodeConfigs);
  const configMap = new Map(allConfigs.map((c) => [c.nodeId, c]));
  const nodesWithConfig: Array<WorkflowNode & { config: WorkflowNodeConfig }> = nodes.map((n) => ({
    ...n,
    config: configMap.get(n.id) ?? {
      id: "",
      nodeId: n.id,
      modelId: null,
      promptVersionId: null,
      timeoutMs: 60000,
      maxRetries: 1,
      thresholds: {},
      settings: {},
      updatedAt: new Date(),
    },
  }));

  const [budget] = await db.select().from(budgetRules).limit(1);
  if (!budget) throw new Error("Budget rules not seeded");

  const [character] = job.characterId
    ? await db.select().from(characters).where(eq(characters.id, job.characterId)).limit(1)
    : [null];
  const [environment] = job.environmentPresetId
    ? await db
        .select()
        .from(environmentPresets)
        .where(eq(environmentPresets.id, job.environmentPresetId))
        .limit(1)
    : [null];

  const inputs = await db
    .select()
    .from(jobInputs)
    .where(eq(jobInputs.jobId, jobId));

  const allModels = await db.select().from(modelRegistry);
  const modelsByRole = new Map(
    allModels.filter((m) => m.isEnabled).map((m) => [m.role, m]),
  );
  // A customer's explicit image-model choice overrides whatever the
  // production workflow node is bound to. Fetched by ID directly (not
  // gated on isEnabled here) — the choice was already validated as
  // enabled at job-creation time, and an admin disabling a model later
  // shouldn't retroactively break jobs a customer already committed to.
  if (job.imageModelId) {
    const [chosen] = await db
      .select()
      .from(modelRegistry)
      .where(eq(modelRegistry.id, job.imageModelId))
      .limit(1);
    if (chosen) modelsByRole.set("image_generator", chosen);
  }

  const priceRows = await db
    .select()
    .from(modelPriceVersions)
    .where(eq(modelPriceVersions.isActive, true));
  const priceVersionsByModelId = new Map(
    priceRows.map((p) => [p.modelId, p]),
  );

  const promptVersionRows = await db.select().from(promptVersions);
  const promptVersionsById = new Map(promptVersionRows.map((p) => [p.id, p]));

  const skillVersionRows = await db
    .select()
    .from(skillVersions)
    .where(eq(skillVersions.status, "production"));
  const skillVersionsById = new Map(skillVersionRows.map((s) => [s.id, s]));

  const skillRuleRows = await db
    .select()
    .from(skillRules)
    .where(eq(skillRules.isEnabled, true));

  const skillRulesResolved: ResolvedSkillRule[] = [];
  for (const r of skillRuleRows) {
    // Find the production skill version for this skill
    const sv = Array.from(skillVersionsById.values()).find(
      (sv) => sv.skillId === r.skillId,
    );
    if (!sv) continue;
    skillRulesResolved.push({
      ...r,
      skillVersionId: sv.id,
      priority: sv.priority,
    });
  }

  return {
    job,
    workflowVersion: wfVersion,
    workflowNodes: nodesWithConfig,
    budgetRules: budget,
    fxRate: Number(budget.usdInrRate ?? 95.78),
    character: character ?? null,
    environment: environment ?? null,
    inputs,
    modelsByRole,
    priceVersionsByModelId,
    promptVersionsById,
    skillVersionsById,
    skillRules: skillRulesResolved,
  };
}

// ─── Attempts ─────────────────────────────────────────────────────────────────

export async function createAttempt(
  db: Db,
  jobId: string,
  attemptNumber: number,
  promptVersionId: string | null,
): Promise<JobAttempt> {
  const [attempt] = await db
    .insert(jobAttempts)
    .values({
      jobId,
      attemptNumber,
      status: "running",
      promptVersionId,
      selectedSkillVersionIds: [],
    })
    .returning();
  return attempt;
}

export async function updateAttempt(
  db: Db,
  attemptId: string,
  input: {
    status?: schema.AttemptStatus;
    compiledPrompt?: string;
    selectedSkillVersionIds?: string[];
    repairInstruction?: string | null;
    decision?: string | null;
    decisionReasons?: string[];
    finishedAt?: Date;
  },
): Promise<void> {
  await db.update(jobAttempts).set(input as any).where(eq(jobAttempts.id, attemptId));
}

export async function getPreviousAttempts(db: Db, jobId: string): Promise<JobAttempt[]> {
  return db
    .select()
    .from(jobAttempts)
    .where(eq(jobAttempts.jobId, jobId))
    .orderBy(jobAttempts.attemptNumber);
}

/**
 * Mark any attempt for this job still stuck at status "running" past the
 * distributed lock's TTL as failed. Every normal exception path already
 * transitions its attempt to "failed" via a try/finally in
 * `processGenerationJob` — this only ever fires after a hard process crash
 * (OOM kill, container restart, power loss), where that finally block never
 * got to run and the attempt row is orphaned. Without this, `getPreviousAttempts`
 * would keep counting a dead attempt as "running" forever, and the job would
 * never surface as failed/retryable to an operator.
 */
export async function markStaleRunningAttemptsFailed(
  db: Db,
  jobId: string,
  olderThanMs: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const stale = await db
    .update(jobAttempts)
    .set({ status: "failed", finishedAt: new Date() })
    .where(
      and(
        eq(jobAttempts.jobId, jobId),
        eq(jobAttempts.status, "running"),
        sql`${jobAttempts.startedAt} < ${cutoff.toISOString()}`,
      ),
    )
    .returning({ id: jobAttempts.id });
  return stale.length;
}

// ─── Steps ────────────────────────────────────────────────────────────────────

export async function createStepRun(
  db: Db,
  input: {
    jobId: string;
    attemptId: string;
    nodeKey: string;
    modelId?: string | null;
    promptVersionId?: string | null;
  },
): Promise<JobStepRun> {
  const [step] = await db
    .insert(jobStepRuns)
    .values({
      jobId: input.jobId,
      attemptId: input.attemptId,
      nodeKey: input.nodeKey,
      modelId: input.modelId ?? null,
      promptVersionId: input.promptVersionId ?? null,
      status: "running",
    })
    .returning();
  return step;
}

export async function completeStepRun(
  db: Db,
  stepRunId: string,
  input: {
    status: "succeeded" | "failed" | "skipped";
    outputRef?: Record<string, unknown> | null;
    error?: string | null;
  },
): Promise<void> {
  const patch: Record<string, unknown> = {
    status: input.status,
    finishedAt: new Date(),
  };
  if (input.outputRef !== undefined) patch.outputRef = input.outputRef;
  if (input.error !== undefined) patch.error = input.error;
  await db
    .update(jobStepRuns)
    .set(patch)
    .where(eq(jobStepRuns.id, stepRunId));
}

// ─── Cost events ──────────────────────────────────────────────────────────────

export async function recordCostEvent(
  db: Db,
  input: {
    jobId: string;
    attemptId: string;
    stepRunId: string;
    nodeKey: string;
    provider: string;
    modelId: string | null;
    modelPriceVersionId: string | null;
    inputTokens: number;
    outputTokens: number;
    imageCount: number;
    resolution?: string;
    usdCost: string;
    fxRate: string;
    inrCost: string;
    providerReportedCostUsd?: string | null;
  },
): Promise<CostEvent> {
  const [event] = await db.insert(costEvents).values(input as any).returning();
  return event;
}

// ─── Job state ────────────────────────────────────────────────────────────────

export async function updateJobState(
  db: Db,
  jobId: string,
  newState: schema.JobState,
  reason?: string,
): Promise<void> {
  const [current] = await db
    .select({ state: jobs.state })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  await db.insert(jobStateEvents).values({
    jobId,
    fromState: current?.state ?? null,
    toState: newState,
    reason: reason ?? null,
  });
  const updates: Record<string, unknown> = { state: newState, updatedAt: new Date() };
  if (newState === "failed") updates.error = reason ?? "Workflow failed";
  if (newState === "ready") updates.error = null;
  if (["ready", "failed", "budget_stopped", "input_rejected", "cancelled", "manual_review"].includes(newState)) {
    updates.completedAt = new Date();
  }
  await db.update(jobs).set(updates as any).where(eq(jobs.id, jobId));
}

// ─── Candidates ──────────────────────────────────────────────────────────────

export async function createGenerationCandidate(
  db: Db,
  input: {
    jobId: string;
    attemptId: string;
    assetId: string;
    sequence: number;
    isFinal?: boolean;
    cameraAngle?: string | null;
    isAnchor?: boolean;
  },
): Promise<GenerationCandidate> {
  const [candidate] = await db
    .insert(generationCandidates)
    .values({ ...input, isFinal: input.isFinal ?? false })
    .returning();
  return candidate;
}

export async function createQualityReview(
  db: Db,
  input: {
    candidateId: string;
    reviewType: "primary" | "second";
    reviewerModelId?: string | null;
    promptVersionId?: string | null;
    review: QualityReview;
    garmentFidelityScore?: number;
    characterIdentityScore?: number;
    photorealismScore?: number;
  },
): Promise<QualityReviewRow> {
  const [row] = await db
    .insert(qualityReviews)
    .values({
      candidateId: input.candidateId,
      reviewType: input.reviewType,
      reviewerModelId: input.reviewerModelId ?? null,
      promptVersionId: input.promptVersionId ?? null,
      review: input.review as any,
      garmentFidelityScore: input.garmentFidelityScore ?? null,
      characterIdentityScore: input.characterIdentityScore ?? null,
      photorealismScore: input.photorealismScore ?? null,
    })
    .returning();
  return row;
}

export async function createDefects(
  db: Db,
  qualityReviewId: string,
  candidateId: string,
  defectsList: Array<{
    severity: "critical" | "major" | "minor";
    code: string;
    description: string;
    repairHint?: string | null;
  }>,
): Promise<void> {
  if (defectsList.length === 0) return;
  await db.insert(defects).values(
    defectsList.map((d) => ({
      qualityReviewId,
      candidateId,
      severity: d.severity,
      code: d.code,
      description: d.description,
      repairHint: d.repairHint ?? null,
    })),
  );
}

// ─── Assets ───────────────────────────────────────────────────────────────────

export async function createAsset(
  db: Db,
  input: {
    userId?: string | null;
    kind: schema.AssetKind;
    bucket: string;
    objectKey: string;
    originalFilename?: string | null;
    mimeType: string;
    sizeBytes: number;
    width?: number | null;
    height?: number | null;
    validationStatus?: schema.AssetValidationStatus;
  },
): Promise<Asset> {
  const [asset] = await db
    .insert(assets)
    .values({
      ...input,
      validationStatus: input.validationStatus ?? "usable",
    })
    .returning();
  return asset;
}

// ─── Job output ────────────────────────────────────────────────────────────────

export async function createJobOutput(
  db: Db,
  input: {
    jobId: string;
    masterAssetId: string;
    previewAssetId?: string | null;
    jpgAssetId?: string | null;
    sequence?: number;
    cameraAngle?: string | null;
  },
): Promise<JobOutput> {
  const [output] = await db.insert(jobOutputs).values(input).returning();
  return output;
}

export async function updateJobTruthSheet(
  db: Db,
  jobId: string,
  truthSheet: Record<string, unknown>,
  promptVersionId: string,
  modelId: string,
): Promise<void> {
  await db
    .update(jobs)
    .set({
      truthSheet: truthSheet as any,
      truthSheetPromptVersionId: promptVersionId,
      truthSheetModelId: modelId,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, jobId));
}

export async function finalizeJobCost(
  db: Db,
  jobId: string,
  totalCostUsd: number,
  totalCostInr: number,
): Promise<void> {
  await db
    .update(jobs)
    .set({
      totalCostUsd: String(totalCostUsd),
      totalCostInr: String(totalCostInr),
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, jobId));
}

/**
 * The true cumulative spend for a job, summed directly from the cost_events
 * ledger rather than read from `jobs.total_cost_inr`. This is the source of
 * truth: `jobs.total_cost_inr` is only ever a materialized cache of this sum
 * and must never be trusted on its own for budget enforcement — a job that
 * has gone through a retry (or any exit path that doesn't call
 * `finalizeJobCost`) can have a stale cached total that understates real
 * spend by the full cost of every earlier attempt.
 */
export async function sumCostEventsForJob(
  db: Db,
  jobId: string,
): Promise<{ usd: number; inr: number }> {
  const [row] = await db
    .select({
      usd: sql<string>`coalesce(sum(${costEvents.usdCost}), 0)`,
      inr: sql<string>`coalesce(sum(${costEvents.inrCost}), 0)`,
    })
    .from(costEvents)
    .where(eq(costEvents.jobId, jobId));
  return { usd: Number(row?.usd ?? 0), inr: Number(row?.inr ?? 0) };
}

/**
 * Persist a repair plan before acting on it — retry intelligence (which
 * defects, what to preserve, what to fix) survives attempt/process
 * boundaries instead of living only in worker memory.
 */
export async function createRetryPlan(
  db: Db,
  input: {
    jobId: string;
    sourceAttemptId: string;
    sourceCandidateId: string;
    scope: "full_set" | "single_angle";
    failedAngle: string | null;
    criticalDefectCodes: string[];
    minorDefectCodes: string[];
    reviewerExplanation: string | null;
    repairInstruction: string;
    protectedAttributes: string[];
    generationModelId: string | null;
  },
): Promise<RetryPlan> {
  const [plan] = await db.insert(retryPlans).values(input).returning();
  return plan;
}

/** Mark a retry plan resolved once the repair attempt has been reviewed. */
export async function resolveRetryPlan(
  db: Db,
  retryPlanId: string,
  input: { resultCandidateId: string | null; resultDecision: string | null; status: string },
): Promise<void> {
  await db
    .update(retryPlans)
    .set({
      resultCandidateId: input.resultCandidateId,
      resultDecision: input.resultDecision,
      status: input.status,
      resolvedAt: new Date(),
    })
    .where(eq(retryPlans.id, retryPlanId));
}

/** How many times a specific candidate's angle has already had a single-angle retry attempted for this job. */
export async function countPriorAngleRetries(
  db: Db,
  jobId: string,
  cameraAngle: string | null,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(retryPlans)
    .where(
      and(
        eq(retryPlans.jobId, jobId),
        eq(retryPlans.scope, "single_angle"),
        cameraAngle === null ? sql`${retryPlans.failedAngle} is null` : eq(retryPlans.failedAngle, cameraAngle),
      ),
    );
  return Number(row?.count ?? 0);
}

/**
 * Another enabled image_generator model to try when the configured one
 * declines to generate (e.g. Gemini's opaque IMAGE_OTHER refusal) rather
 * than failing the whole job outright. Deterministic (oldest-other-enabled
 * wins), not random — a job retried twice should pick the same fallback
 * both times.
 */
export async function getFallbackImageModel(
  db: Db,
  excludeModelId: string,
): Promise<ModelRegistry | null> {
  const [row] = await db
    .select()
    .from(modelRegistry)
    .where(
      and(
        eq(modelRegistry.role, "image_generator"),
        eq(modelRegistry.isEnabled, true),
        ne(modelRegistry.id, excludeModelId),
      ),
    )
    .orderBy(modelRegistry.createdAt)
    .limit(1);
  return row ?? null;
}
