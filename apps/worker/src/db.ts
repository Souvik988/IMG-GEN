/**
 * Worker-side database helpers.
 */

import { eq, and } from "drizzle-orm";
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
  QualityReviewRow,
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

  const allAssets = await db.select().from(assets);
  const assetsById = new Map(allAssets.map((a) => [a.id, a]));

  const allModels = await db.select().from(modelRegistry);
  const modelsByRole = new Map(
    allModels.filter((m) => m.isEnabled).map((m) => [m.role, m]),
  );

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
    assetsById,
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
