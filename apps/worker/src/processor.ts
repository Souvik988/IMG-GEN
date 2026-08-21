/**
 * Main generation job processor.
 */

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { jobAttempts } from "@shotlin/database";
import type { Db } from "@shotlin/database";
import { createGenerationQueue, createRedisConnection } from "@shotlin/platform";
import {
  evaluateRules,
  DEFAULT_RULE_CONFIG,
  estimateNextAttemptCost,
} from "@shotlin/core";

import {
  loadJobData,
  createAttempt,
  finalizeJobCost,
  updateJobState,
  updateAttempt,
  getPreviousAttempts,
} from "./db";
import { NODE_RUNNERS, runSkippedNode } from "./nodes";
import type { WorkflowContext } from "./context";

export type ProcessorDeps = {
  db: Db;
  storage: import("@shotlin/platform").Storage;
  providers: import("@shotlin/providers").ResolvedProviders;
  lockRedis: ReturnType<typeof createRedisConnection>;
};

export async function processGenerationJob(
  jobId: string,
  deps: ProcessorDeps,
): Promise<void> {
  const { db } = deps;

  // ── Load job + workflow data ────────────────────────────────────────────────
  const data = await loadJobData(db, jobId);

  // Check job is not terminal
  const terminalStates = [
    "ready",
    "input_rejected",
    "failed",
    "budget_stopped",
    "manual_review",
    "cancelled",
  ] as const;
  if (terminalStates.includes(data.job.state as (typeof terminalStates)[number])) {
    console.log(
      `[worker] job ${jobId} already terminal (${data.job.state}), skipping`,
    );
    return;
  }

  // BullMQ is at-least-once. A short distributed lock prevents duplicate queue
  // deliveries or two workers from creating two billable attempts for one job.
  const lockKey = `shotlin:generation-lock:${jobId}`;
  const lockToken = randomUUID();
  const acquired = await deps.lockRedis.set(lockKey, lockToken, "PX", 15 * 60 * 1000, "NX");
  if (acquired !== "OK") {
    console.log(`[worker] job ${jobId} already has an active worker lock, skipping duplicate delivery`);
    return;
  }
  const releaseLock = async () => {
    await deps.lockRedis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      lockKey,
      lockToken,
    );
  };

  // ── Load or create attempt ───────────────────────────────────────────────────
  const previousAttempts = await getPreviousAttempts(db, jobId);
  const attemptNumber = previousAttempts.length + 1;
  const maxAttempts = Number(data.budgetRules.maxAttempts ?? 3);

  // Budget check before starting a new attempt
  const currentSpendInr = Number(data.job.totalCostInr ?? 0);
  const hardStop = Number(data.budgetRules.hardStopInr ?? 20);
  const resolution = data.job.requestedResolution;

  const imageModel = data.modelsByRole.get("image_generator");
  const imagePriceVersion = imageModel
    ? data.priceVersionsByModelId.get(imageModel.id)
    : null;
  const qaModel = data.modelsByRole.get("quality_reviewer");
  const qaPriceVersion = qaModel
    ? data.priceVersionsByModelId.get(qaModel.id)
    : null;
  const imageGenPrices = {
    inputPricePerM: imagePriceVersion?.inputPricePerM
      ? Number(imagePriceVersion.inputPricePerM)
      : null,
    outputPricePerM: imagePriceVersion?.outputPricePerM
      ? Number(imagePriceVersion.outputPricePerM)
      : null,
    imagePrices: (imagePriceVersion?.imagePrices as Record<string, number> | null) ?? null,
  };
  const qaPrices = {
    inputPricePerM: qaPriceVersion?.inputPricePerM
      ? Number(qaPriceVersion.inputPricePerM)
      : null,
    outputPricePerM: qaPriceVersion?.outputPricePerM
      ? Number(qaPriceVersion.outputPricePerM)
      : null,
    imagePrices: null,
  };
  const nextAttemptCost = estimateNextAttemptCost(
    imageGenPrices,
    qaPrices,
    resolution,
    data.fxRate,
  );

  if (currentSpendInr + nextAttemptCost.inrCost > hardStop) {
    console.log(
      `[worker] job ${jobId}: budget stop (spent ₹${currentSpendInr.toFixed(2)}, hard stop ₹${hardStop}, next attempt ~₹${nextAttemptCost.inrCost.toFixed(2)})`,
    );
    await updateJobState(
      db,
      jobId,
      "budget_stopped",
      "Budget exceeded before attempt could start",
    );
    await releaseLock();
    return;
  }

  const attempt = await createAttempt(db, jobId, attemptNumber, null);

  // ── Build workflow context ────────────────────────────────────────────────────
  const ctx: WorkflowContext = {
    job: data.job,
    workflowVersion: data.workflowVersion,
    workflowNodes: data.workflowNodes,
    budgetRules: data.budgetRules,
    fxRate: data.fxRate,
    attempt,
    attemptNumber,
    selectedSkillVersionIds: [],
    skillInstructions: [],
    compiledPrompt: "",
    ruleDecision: null,
    ruleReasons: [],
    truthSheet: null,
    truthSheetPromptVersionId: null,
    truthSheetModelId: null,
    candidates: [],
    finalCandidate: null,
    totalCostUsd: currentSpendInr / data.fxRate,
    totalCostInr: currentSpendInr,
    costEvents: [],
    currentStep: null,
    character: data.character,
    environment: data.environment,
    modelsByRole: data.modelsByRole,
    priceVersionsByModelId: data.priceVersionsByModelId,
    promptVersionsById: data.promptVersionsById,
    skillVersionsById: data.skillVersionsById,
    skillRules: data.skillRules,
  };

  console.log(
    `[worker] job ${jobId} | attempt ${attemptNumber} | starting`,
  );

  try {
    await runConfiguredWorkflow({
      data,
      deps,
      jobId,
      attempt,
      attemptNumber,
      currentSpendInr,
      maxAttempts,
      hardStop,
      ctx,
    });
    return;
    /* legacy linear runner retained below as a readable fallback reference.
    // ── Node: input_check ───────────────────────────────────────────────────────
    const inputCheckNode = data.workflowNodes.find(
      (n: schema.WorkflowNode & { config: schema.WorkflowNodeConfig }) =>
        n.nodeKey === "input_check" && n.isEnabled,
    );
    if (inputCheckNode && NODE_RUNNERS.input_check) {
      await updateJobState(db, jobId, "validating");
      await NODE_RUNNERS.input_check(ctx, inputCheckNode as any, deps);
    }

    // ── Node: vision ───────────────────────────────────────────────────────────
    const visionNode = data.workflowNodes.find(
      (n: schema.WorkflowNode & { config: schema.WorkflowNodeConfig }) =>
        n.nodeKey === "vision" && n.isEnabled,
    );
    if (visionNode && NODE_RUNNERS.vision) {
      await updateJobState(db, jobId, "analyzing");
      await NODE_RUNNERS.vision(ctx, visionNode as any, deps);
    }

    // ── Node: skill_select ─────────────────────────────────────────────────────
    const skillNode = data.workflowNodes.find(
      (n: schema.WorkflowNode & { config: schema.WorkflowNodeConfig }) =>
        n.nodeKey === "skill_select" && n.isEnabled,
    );
    if (skillNode && NODE_RUNNERS.skill_select) {
      await updateJobState(db, jobId, "compiling");
      await NODE_RUNNERS.skill_select(ctx, skillNode as any, deps);
    }
    await updateAttempt(db, attempt.id, {
      selectedSkillVersionIds: ctx.selectedSkillVersionIds,
    });

    // ── Node: prompt_compile ────────────────────────────────────────────────────
    const compileNode = data.workflowNodes.find(
      (n: schema.WorkflowNode & { config: schema.WorkflowNodeConfig }) =>
        n.nodeKey === "prompt_compile" && n.isEnabled,
    );
    if (compileNode && NODE_RUNNERS.prompt_compile) {
      await NODE_RUNNERS.prompt_compile(ctx, compileNode as any, deps);
    }
    await updateAttempt(db, attempt.id, {
      compiledPrompt: ctx.compiledPrompt,
    });

    // ── Node: image_generate ────────────────────────────────────────────────────
    const genNode = data.workflowNodes.find(
      (n: schema.WorkflowNode & { config: schema.WorkflowNodeConfig }) =>
        n.nodeKey === "image_generate" && n.isEnabled,
    );
    if (genNode && NODE_RUNNERS.image_generate) {
      await updateJobState(db, jobId, "generating");
      await NODE_RUNNERS.image_generate(ctx, genNode as any, deps);
    }

    // ── Node: quality_review ───────────────────────────────────────────────────
    const qaNode = data.workflowNodes.find(
      (n: schema.WorkflowNode & { config: schema.WorkflowNodeConfig }) =>
        n.nodeKey === "quality_review" && n.isEnabled,
    );
    if (qaNode && NODE_RUNNERS.quality_review) {
      await updateJobState(db, jobId, "reviewing");
      await NODE_RUNNERS.quality_review(ctx, qaNode as any, deps);
    }

    // ── Rule engine — first evaluation ──────────────────────────────────────────
    const candidate = ctx.candidates[ctx.candidates.length - 1];
    if (!candidate?.qualityReview) {
      throw new Error("No quality review to evaluate");
    }

    const cfg = {
      minGarmentFidelity: Number(
        data.budgetRules.minGarmentFidelity ?? DEFAULT_RULE_CONFIG.minGarmentFidelity,
      ),
      minCharacterIdentity: Number(
        data.budgetRules.minCharacterIdentity ?? DEFAULT_RULE_CONFIG.minCharacterIdentity,
      ),
      minPhotorealism: Number(
        data.budgetRules.minPhotorealism ?? DEFAULT_RULE_CONFIG.minPhotorealism,
      ),
      minAnatomy: Number(
        data.budgetRules.minAnatomy ?? DEFAULT_RULE_CONFIG.minAnatomy,
      ),
      minTechnicalQuality: Number(
        data.budgetRules.minTechnicalQuality ?? DEFAULT_RULE_CONFIG.minTechnicalQuality,
      ),
      uncertaintyBand: Number(
        data.budgetRules.uncertaintyBand ?? DEFAULT_RULE_CONFIG.uncertaintyBand,
      ),
      minReviewerConfidence: Number(
        data.budgetRules.minReviewerConfidence ?? DEFAULT_RULE_CONFIG.minReviewerConfidence,
      ),
      hardFailDefectCodes: [] as string[],
    };

    const ruleNode = data.workflowNodes.find(
      (n: schema.WorkflowNode & { config: schema.WorkflowNodeConfig }) =>
        n.nodeKey === "rule_engine" && n.isEnabled,
    );
    let primaryResult: ReturnType<typeof evaluateRules>;
    if (ruleNode && NODE_RUNNERS.rule_engine) {
      await NODE_RUNNERS.rule_engine(ctx, ruleNode as any, deps);
      primaryResult = {
        decision: ctx.ruleDecision ?? "FAIL",
        reasons: ctx.ruleReasons,
        garmentScore: candidate.qualityReview.scores.garmentFidelity,
      };
    } else {
      primaryResult = evaluateRules(candidate.qualityReview, cfg);
    }
    let finalDecision = primaryResult.decision;

    await updateAttempt(db, attempt.id, {
      decision: primaryResult.decision,
      decisionReasons: primaryResult.reasons,
    });

    // ── UNCERTAIN → second_review ───────────────────────────────────────────────
    if (primaryResult.decision === "UNCERTAIN" && data.budgetRules.isSecondReviewEnabled) {
      const secondNode = data.workflowNodes.find(
        (n: schema.WorkflowNode & { config: schema.WorkflowNodeConfig }) =>
          n.nodeKey === "second_review" && n.isEnabled,
      );
      if (secondNode && NODE_RUNNERS.second_review) {
        await NODE_RUNNERS.second_review(ctx, secondNode as any, deps);

        const finalReview = candidate.secondReview ?? candidate.qualityReview;
        if (finalReview) {
          let secondResult: ReturnType<typeof evaluateRules>;
          if (ruleNode && NODE_RUNNERS.rule_engine) {
            await NODE_RUNNERS.rule_engine(ctx, ruleNode as any, deps);
            secondResult = {
              decision: ctx.ruleDecision ?? "FAIL",
              reasons: ctx.ruleReasons,
              garmentScore: finalReview.scores.garmentFidelity,
            };
          } else {
            secondResult = evaluateRules(finalReview, cfg);
          }
          finalDecision = secondResult.decision;
          await updateAttempt(db, attempt.id, {
            decision: secondResult.decision,
            decisionReasons: [...primaryResult.reasons, ...secondResult.reasons],
          });
        }
      }
    }

    // ── PASS → finalize ────────────────────────────────────────────────────────
    if (finalDecision === "PASS") {
      await updateAttempt(db, attempt.id, { status: "passed" });
      await updateJobState(db, jobId, "finalizing");
      const finalizeNode = data.workflowNodes.find(
        (n: schema.WorkflowNode & { config: schema.WorkflowNodeConfig }) =>
          n.nodeKey === "finalize" && n.isEnabled,
      );
      if (finalizeNode && NODE_RUNNERS.finalize) {
        await NODE_RUNNERS.finalize(ctx, finalizeNode as any, deps);
      }
      await updateJobState(db, jobId, "ready", "Generation complete");
      console.log(
        `[worker] job ${jobId} | ✓ READY | attempt ${attemptNumber} | cost ₹${ctx.totalCostInr.toFixed(2)}`,
      );
      return;
    }

    // ── FAIL → retry or budget stop ─────────────────────────────────────────────
    if (finalDecision === "FAIL") {
      const repairInstruction = candidate.qualityReview?.repairInstruction ?? "";
      await updateAttempt(db, attempt.id, {
        repairInstruction: repairInstruction || null,
        status: "failed",
      });

      const totalSpend = currentSpendInr + ctx.totalCostInr;
      if (totalSpend >= hardStop) {
        await updateJobState(
          db,
          jobId,
          "budget_stopped",
          "Budget exhausted after attempt",
        );
        console.log(
          `[worker] job ${jobId} | ✗ BUDGET STOP | ₹${totalSpend.toFixed(2)}`,
        );
        return;
      }

      if (attemptNumber >= maxAttempts) {
        await updateJobState(
          db,
          jobId,
          "failed",
          `Max attempts (${maxAttempts}) reached`,
        );
        console.log(`[worker] job ${jobId} | ✗ FAILED | max attempts`);
        return;
      }

      // Mark current attempt failed and re-enqueue
      await updateJobState(db, jobId, "retrying");
      await db
        .update(jobAttempts)
        .set({ status: "failed", finishedAt: new Date() })
        .where(eq(jobAttempts.id, attempt.id));

      const retryNode = data.workflowNodes.find(
        (n: schema.WorkflowNode & { config: schema.WorkflowNodeConfig }) =>
          n.nodeKey === "retry" && n.isEnabled,
      );
      if (retryNode && NODE_RUNNERS.retry) {
        await NODE_RUNNERS.retry(ctx, retryNode as any, deps);
      }

      const queue = createGenerationQueue(
        process.env.REDIS_URL ?? "redis://localhost:6381",
      );
      await queue.add(
        "generate",
        { jobId },
        { jobId: `retry-${jobId}-${attemptNumber + 1}` },
      );
      console.log(
        `[worker] job ${jobId} | retry ${attemptNumber + 1} enqueued`,
      );
      return;
    }

    // Still uncertain after second review → manual review
    await updateJobState(db, jobId, "manual_review");
    console.log(
      `[worker] job ${jobId} | → MANUAL_REVIEW (uncertain after second review)`,
    );
    */
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] job ${jobId} | ✗ ERROR: ${message}`);
    // Persist spend even when a provider returned billable usage but the
    // workflow could not safely continue. This keeps the cost ledger honest.
    await finalizeJobCost(db, jobId, ctx.totalCostUsd, ctx.totalCostInr);
    // Image generation is completed and persisted before quality review. If a
    // later infrastructure or reviewer error occurs, preserve that paid asset
    // for the customer under manual review instead of presenting it as lost.
    const terminalState = ctx.candidates.length > 0 ? "manual_review" : "failed";
    await updateJobState(db, jobId, terminalState, message);
    await db
      .update(jobAttempts)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(jobAttempts.id, attempt.id));
    throw err;
  } finally {
    await releaseLock();
  }
}

type ConfiguredWorkflowArgs = {
  data: Awaited<ReturnType<typeof loadJobData>>;
  deps: ProcessorDeps;
  jobId: string;
  attempt: Awaited<ReturnType<typeof createAttempt>>;
  attemptNumber: number;
  currentSpendInr: number;
  maxAttempts: number;
  hardStop: number;
  ctx: WorkflowContext;
};

async function runConfiguredWorkflow({
  data,
  deps,
  jobId,
  attempt,
  attemptNumber,
  currentSpendInr,
  maxAttempts,
  hardStop,
  ctx,
}: ConfiguredWorkflowArgs): Promise<void> {
  const { db } = deps;
  const cfg = {
    minGarmentFidelity: Number(data.budgetRules.minGarmentFidelity ?? DEFAULT_RULE_CONFIG.minGarmentFidelity),
    minCharacterIdentity: Number(data.budgetRules.minCharacterIdentity ?? DEFAULT_RULE_CONFIG.minCharacterIdentity),
    minPhotorealism: Number(data.budgetRules.minPhotorealism ?? DEFAULT_RULE_CONFIG.minPhotorealism),
    minAnatomy: Number(data.budgetRules.minAnatomy ?? DEFAULT_RULE_CONFIG.minAnatomy),
    minTechnicalQuality: Number(data.budgetRules.minTechnicalQuality ?? DEFAULT_RULE_CONFIG.minTechnicalQuality),
    uncertaintyBand: Number(data.budgetRules.uncertaintyBand ?? DEFAULT_RULE_CONFIG.uncertaintyBand),
    minReviewerConfidence: Number(data.budgetRules.minReviewerConfidence ?? DEFAULT_RULE_CONFIG.minReviewerConfidence),
    hardFailDefectCodes: [] as string[],
  };
  let finalDecision: ReturnType<typeof evaluateRules>["decision"] | null = null;
  let decisionReasons: string[] = [];
  const orderedNodes = data.workflowNodes
    .filter((node) => node.isEnabled)
    .sort((a, b) => a.sequence - b.sequence);
  const nodeByKey = (nodeKey: string) => orderedNodes.find((node) => node.nodeKey === nodeKey);

  const evaluateCurrentCandidate = async (ruleNode: (typeof data.workflowNodes)[number]) => {
    const candidate = ctx.candidates[ctx.candidates.length - 1];
    const review = candidate?.secondReview ?? candidate?.qualityReview;
    if (!candidate || !review) throw new Error("No quality review to evaluate");
    if (NODE_RUNNERS.rule_engine) {
      await NODE_RUNNERS.rule_engine(ctx, ruleNode as any, deps);
      return {
        decision: ctx.ruleDecision ?? "FAIL",
        reasons: ctx.ruleReasons,
        garmentScore: review.scores.garmentFidelity,
      } as ReturnType<typeof evaluateRules>;
    }
    return evaluateRules(review, cfg);
  };

  for (const node of orderedNodes) {
    const runner = NODE_RUNNERS[node.nodeKey];
    if (!runner) continue;

    switch (node.nodeKey) {
      case "input_check":
        await updateJobState(db, jobId, "validating");
        await runner(ctx, node as any, deps);
        break;
      case "vision":
        await updateJobState(db, jobId, "analyzing");
        await runner(ctx, node as any, deps);
        break;
      case "skill_select":
        await updateJobState(db, jobId, "compiling");
        await runner(ctx, node as any, deps);
        await updateAttempt(db, attempt.id, { selectedSkillVersionIds: ctx.selectedSkillVersionIds });
        break;
      case "prompt_compile":
        await runner(ctx, node as any, deps);
        await updateAttempt(db, attempt.id, { compiledPrompt: ctx.compiledPrompt });
        break;
      case "image_generate":
        await updateJobState(db, jobId, "generating");
        await runner(ctx, node as any, deps);
        break;
      case "quality_review":
        await updateJobState(db, jobId, "reviewing");
        await runner(ctx, node as any, deps);
        break;
      case "rule_engine": {
        const result = await evaluateCurrentCandidate(node);
        finalDecision = result.decision;
        decisionReasons = result.reasons;
        await updateAttempt(db, attempt.id, {
          decision: result.decision,
          decisionReasons: result.reasons,
        });
        break;
      }
      case "second_review":
        if (finalDecision === "UNCERTAIN" && data.budgetRules.isSecondReviewEnabled) {
          await runner(ctx, node as any, deps);
          const ruleNode = nodeByKey("rule_engine");
          if (ruleNode) {
            const result = await evaluateCurrentCandidate(ruleNode);
            finalDecision = result.decision;
            decisionReasons = [...decisionReasons, ...result.reasons];
            await updateAttempt(db, attempt.id, {
              decision: result.decision,
              decisionReasons,
            });
          }
        } else {
          await runSkippedNode(
            ctx,
            node as any,
            deps,
            finalDecision === "UNCERTAIN"
              ? "Second review disabled by budget rules"
              : `Skipped because rule decision was ${finalDecision ?? "not reached"}`,
          );
        }
        break;
      case "retry":
        if (finalDecision !== "FAIL") {
          await runSkippedNode(
            ctx,
            node as any,
            deps,
            `Skipped because rule decision was ${finalDecision ?? "not reached"}`,
          );
          break;
        }
        {
          const candidate = ctx.candidates[ctx.candidates.length - 1];
          await updateAttempt(db, attempt.id, {
            repairInstruction: candidate?.qualityReview?.repairInstruction ?? null,
            status: "failed",
          });
          const totalSpend = currentSpendInr + ctx.totalCostInr;
          if (totalSpend >= hardStop) {
            await updateJobState(db, jobId, "budget_stopped", "Budget exhausted after attempt");
            return;
          }
          if (attemptNumber >= maxAttempts) {
            await updateJobState(db, jobId, "failed", `Max attempts (${maxAttempts}) reached`);
            return;
          }
          await updateJobState(db, jobId, "retrying");
          await db.update(jobAttempts).set({ status: "failed", finishedAt: new Date() }).where(eq(jobAttempts.id, attempt.id));
          await runner(ctx, node as any, deps);
          const queue = createGenerationQueue(process.env.REDIS_URL ?? "redis://localhost:6381");
          await queue.add("generate", { jobId }, { jobId: `retry-${jobId}-${attemptNumber + 1}` });
          console.log(`[worker] job ${jobId} | retry ${attemptNumber + 1} enqueued`);
          return;
        }
      case "finalize":
        if (finalDecision === "PASS") {
          await updateAttempt(db, attempt.id, { status: "passed" });
          await updateJobState(db, jobId, "finalizing");
          await runner(ctx, node as any, deps);
          await updateJobState(db, jobId, "ready", "Generation complete");
          console.log(`[worker] job ${jobId} | ✓ READY | attempt ${attemptNumber} | cost ₹${ctx.totalCostInr.toFixed(2)}`);
          return;
        }
        break;
    }
  }

  if (finalDecision === "PASS") {
    await updateAttempt(db, attempt.id, { status: "passed" });
    await updateJobState(db, jobId, "ready", "Generation complete");
    return;
  }
  if (finalDecision === "FAIL") {
    await updateJobState(db, jobId, "failed", "Workflow ended without an enabled retry node");
    return;
  }
  await updateJobState(db, jobId, "manual_review");
  console.log(`[worker] job ${jobId} | → MANUAL_REVIEW (uncertain after second review)`);
}
