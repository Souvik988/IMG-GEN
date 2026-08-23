/**
 * Individual node runners.
 * Each function receives the workflow context + node config and mutates context
 * in-place, returning nothing (errors propagate up to the processor).
 */

import { and, eq, ne } from "drizzle-orm";
import * as schema from "@shotlin/database";
import type { Db } from "@shotlin/database";
import {
  assets,
  jobInputs,
  characterIdentityReferences,
} from "@shotlin/database";
import {
  calculateCost,
  DEFAULT_RULE_CONFIG,
  compilePrompt,
  evaluateRules,
  validateImageInput,
  type GarmentTruthSheet,
  type QualityReview,
  type RuleResultDecision,
} from "@shotlin/core";
import { extractImageMeta, createLogger } from "@shotlin/platform";
import { ProviderError, type ResolvedProviders, type Usage } from "@shotlin/providers";
import type { Storage } from "@shotlin/platform";
import { makePreview, toJpg } from "@shotlin/platform";
import type { WorkflowContext } from "./context";

const log = createLogger("worker.nodes");
import type { WorkflowNode, WorkflowNodeConfig } from "@shotlin/database";
import {
  createStepRun,
  completeStepRun,
  recordCostEvent,
  createGenerationCandidate,
  createQualityReview,
  createDefects,
  createAsset,
  createJobOutput,
  updateJobTruthSheet,
  finalizeJobCost,
  createRetryPlan,
  resolveRetryPlan,
  countPriorAngleRetries,
  getFallbackImageModel,
} from "./db";

type NodeRunner = (
  ctx: WorkflowContext,
  node: WorkflowNode & { config: WorkflowNodeConfig },
  deps: {
    db: Db;
    storage: Storage;
    providers: ResolvedProviders;
  },
) => Promise<void>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function runStep(
  ctx: WorkflowContext,
  node: WorkflowNode & { config: WorkflowNodeConfig },
  deps: { db: Db; storage: Storage; providers: ResolvedProviders },
  fn: (stepRunId: string) => Promise<void>,
): Promise<void> {
  const step = await createStepRun(deps.db, {
    jobId: ctx.job.id,
    attemptId: ctx.attempt.id,
    nodeKey: node.nodeKey,
    modelId: node.config.modelId,
    promptVersionId: node.config.promptVersionId,
  });
  ctx.currentStep = { stepRunId: step.id, nodeKey: node.nodeKey, startedAt: new Date() };
  try {
    await fn(step.id);
    await ensureDeterministicCostEvent(ctx, deps.db, step.id, node.nodeKey);
    await completeStepRun(deps.db, step.id, { status: "succeeded" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await completeStepRun(deps.db, step.id, { status: "failed", error: message });
    throw err;
  }
}

async function ensureDeterministicCostEvent(
  ctx: WorkflowContext,
  db: Db,
  stepRunId: string,
  nodeKey: string,
): Promise<void> {
  const [existing] = await db
    .select({ id: schema.costEvents.id })
    .from(schema.costEvents)
    .where(eq(schema.costEvents.stepRunId, stepRunId))
    .limit(1);
  if (existing) return;

  const event = await recordCostEvent(db, {
    jobId: ctx.job.id,
    attemptId: ctx.attempt.id,
    stepRunId,
    nodeKey,
    provider: "deterministic",
    modelId: null,
    modelPriceVersionId: null,
    inputTokens: 0,
    outputTokens: 0,
    imageCount: 0,
    usdCost: "0",
    fxRate: String(ctx.fxRate),
    inrCost: "0",
    providerReportedCostUsd: null,
  });
  ctx.costEvents.push(event);
}

/** Record a conditional node that was intentionally skipped without billing. */
export async function runSkippedNode(
  ctx: WorkflowContext,
  node: WorkflowNode & { config: WorkflowNodeConfig },
  deps: { db: Db; storage: Storage; providers: ResolvedProviders },
  reason: string,
): Promise<void> {
  const step = await createStepRun(deps.db, {
    jobId: ctx.job.id,
    attemptId: ctx.attempt.id,
    nodeKey: node.nodeKey,
    modelId: node.config.modelId,
    promptVersionId: node.config.promptVersionId,
  });
  ctx.currentStep = { stepRunId: step.id, nodeKey: node.nodeKey, startedAt: new Date() };
  await completeStepRun(deps.db, step.id, {
    status: "skipped",
    outputRef: { reason },
  });
  await ensureDeterministicCostEvent(ctx, deps.db, step.id, node.nodeKey);
}

/**
 * Distinguishes a provider's opaque "declined to generate" response
 * (Gemini's IMAGE_OTHER catch-all, an explicit safety block, a null-content
 * refusal) from every other kind of failure. Only this narrow class is
 * worth retrying against a different image model — a capability rejection,
 * auth error, timeout, or rate limit would fail identically on any model
 * and a fallback attempt would just waste the spend.
 */
function isGenerationRefusal(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  return /IMAGE_OTHER|block_reason|"finish_reason"\s*:\s*"(SAFETY|PROHIBITED_CONTENT|IMAGE_SAFETY)"|could not generate an image/i.test(
    err.message,
  );
}

/**
 * A transient infrastructure failure (gateway error, dropped connection,
 * request timeout) worth one immediate retry — as opposed to a permanent
 * failure (insufficient OpenRouter credits, invalid auth, a capability
 * rejection) that will fail identically on retry and would just waste the
 * round trip. Distinguishing these matters because an angle that never
 * became a candidate at all (it threw before any image was produced) is
 * invisible to the single-angle retry in `runFinalize`, which only sees
 * candidates that generated successfully but failed *review* — without a
 * retry here, a 502 or a dropped connection permanently drops that angle
 * from the delivered set with no second attempt at all.
 */
function isRetryableInfraError(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  if (/HTTP 40[123]\b/.test(err.message)) return false; // auth / insufficient credits — retry can't fix this
  return /HTTP 5\d\d\b|aborted|ECONNRESET|socket hang up|network|timed? ?out/i.test(err.message);
}

function ruleConfigForContext(ctx: WorkflowContext) {
  return {
    minGarmentFidelity: Number(ctx.budgetRules.minGarmentFidelity ?? DEFAULT_RULE_CONFIG.minGarmentFidelity),
    minCharacterIdentity: Number(ctx.budgetRules.minCharacterIdentity ?? DEFAULT_RULE_CONFIG.minCharacterIdentity),
    minPhotorealism: Number(ctx.budgetRules.minPhotorealism ?? DEFAULT_RULE_CONFIG.minPhotorealism),
    minAnatomy: Number(ctx.budgetRules.minAnatomy ?? DEFAULT_RULE_CONFIG.minAnatomy),
    minTechnicalQuality: Number(ctx.budgetRules.minTechnicalQuality ?? DEFAULT_RULE_CONFIG.minTechnicalQuality),
    uncertaintyBand: Number(ctx.budgetRules.uncertaintyBand ?? DEFAULT_RULE_CONFIG.uncertaintyBand),
    minReviewerConfidence: Number(ctx.budgetRules.minReviewerConfidence ?? DEFAULT_RULE_CONFIG.minReviewerConfidence),
    hardFailDefectCodes: ctx.budgetRules.hardFailDefectCodes ?? [],
  };
}

// ─── Node: input_check ────────────────────────────────────────────────────────

/**
 * Input quality gate. Hard-rejects only what's genuinely unusable (wrong
 * file type, corrupted, oversized, or too small to carry any real signal —
 * `absoluteMinDimension`, not admin-configurable, since no amount of
 * upscaling rescues that). Everything else proceeds:
 *
 * - Decodable but below the *ideal* size (`minDimension`, default 512px):
 *   upscaled via Lanczos3 interpolation and stored as a separate derived
 *   asset (`assets.enhancedAssetId`) — originals are never mutated. Every
 *   downstream reader of job reference images goes through
 *   `resolveReferenceImages`, which prefers the enhanced version when one
 *   exists.
 * - Blurry (variance below `blurThreshold`): no longer a rejection at all —
 *   just a warning recorded on the asset. `runVision` reads it and tells
 *   the vision model the source is soft, so it reports lower confidence and
 *   flags uncertain details instead of the pipeline either blocking outright
 *   or silently pretending a blurry photo is pixel-perfect. A vision model
 *   that's actually looked at the photo is a much better judge of "is this
 *   usable" than a blind pixel heuristic.
 */
export const runInputCheck: NodeRunner = async (ctx, node, deps) => {
  await runStep(ctx, node, deps, async (stepRunId) => {
    const thresholds = node.config.thresholds as {
      maxBytes?: number;
      minDimension?: number;
      blurThreshold?: number;
    };
    const { upscaleToMinDimension } = await import("@shotlin/platform");
    const config = {
      maxBytes: thresholds.maxBytes ?? 26_214_400,
      minDimension: thresholds.minDimension ?? 512,
      absoluteMinDimension: 128,
      maxDimension: 10_000,
      blurThreshold: thresholds.blurThreshold ?? 100,
      allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    };

    const inputs = await deps.db
      .select()
      .from(jobInputs)
      .where(eq(jobInputs.jobId, ctx.job.id));

    for (const input of inputs) {
      const [asset] = await deps.db
        .select()
        .from(assets)
        .where(eq(assets.id, input.assetId))
        .limit(1);
      if (!asset) throw new Error(`Asset ${input.assetId} not found`);

      const buf = await deps.storage.getObject(asset.bucket, asset.objectKey);

      // Extract deterministic metadata first, then validate
      const meta = await extractImageMeta(buf);
      const validation = validateImageInput(meta, config);

      if (!validation.usable) {
        const { updateJobState } = await import("./db");
        await updateJobState(deps.db, ctx.job.id, "input_rejected", validation.reasons.join("; "));
        throw new Error(`Input rejected: ${validation.reasons.join("; ")}`);
      }

      let enhancedAssetId: string | null = null;
      if (validation.needsUpscale) {
        const upscaled = await upscaleToMinDimension(buf, meta.mimeType, config.minDimension);
        if (upscaled) {
          const ext = meta.mimeType === "image/png" ? "png" : meta.mimeType === "image/webp" ? "webp" : "jpg";
          const objectKey = `enhanced/${asset.id}/${crypto.randomUUID()}.${ext}`;
          await deps.storage.putObject(deps.storage.uploadsBucket, objectKey, upscaled.data, meta.mimeType);
          const enhancedAsset = await createAsset(deps.db, {
            userId: ctx.job.userId,
            kind: asset.kind,
            bucket: deps.storage.uploadsBucket,
            objectKey,
            originalFilename: asset.originalFilename ? `upscaled-${asset.originalFilename}` : null,
            mimeType: meta.mimeType,
            sizeBytes: upscaled.data.length,
            width: upscaled.width,
            height: upscaled.height,
          });
          enhancedAssetId = enhancedAsset.id;
        }
      }

      await deps.db
        .update(assets)
        .set({
          validationStatus: "usable",
          validationReport: {
            usable: true,
            reasons: validation.reasons,
            warnings: validation.warnings,
            width: meta.width,
            height: meta.height,
            blurVariance: meta.blurVariance,
          } as any,
          width: meta.width,
          height: meta.height,
          sizeBytes: buf.length,
          enhancedAssetId,
        })
        .where(eq(assets.id, asset.id));
    }

    await completeStepRun(deps.db, stepRunId, {
      status: "succeeded",
      outputRef: { passed: true, inputCount: inputs.length },
    });
  });
};

// ─── Node: vision ────────────────────────────────────────────────────────────

export const runVision: NodeRunner = async (ctx, node, deps) => {
  const model = ctx.modelsByRole.get("vision_analyzer");
  if (!model) throw new Error("No vision_analyzer model configured");
  const priceVersion = ctx.priceVersionsByModelId.get(model.id);
  const promptVersion = node.config.promptVersionId
    ? ctx.promptVersionsById.get(node.config.promptVersionId)
    : null;

  await runStep(ctx, node, deps, async (stepRunId) => {
    const { garmentTruthSheetSchema } = await import("@shotlin/core");

    const { images: refs, warnings: qualityWarnings } = await resolveReferenceImages(
      deps.db,
      deps.storage,
      ctx.job.id,
      { excludeCharacter: true },
    );

    const basePrompt =
      promptVersion?.body ??
      "You are a garment analysis expert. Return only valid JSON.";
    // A blind pixel heuristic already let this reference through (see
    // input_check) — it's soft, not unusable. Telling the vision model
    // directly means it reports lower confidence and flags uncertain
    // details honestly, instead of the pipeline either blocking the job or
    // silently treating a blurry photo as pixel-perfect.
    const systemPrompt = qualityWarnings.length > 0
      ? `${basePrompt}\n\nNOTE ON SOURCE IMAGE QUALITY: ${qualityWarnings.join("; ")}. Use your best judgment for any detail this affects, report it under uncertainDetails, and lower your confidence score accordingly rather than guessing with false certainty.`
      : basePrompt;

    const result = await deps.providers.analyzeGarment({
      references: refs,
      systemPrompt,
      model: {
        id: model.id,
        provider: model.provider as "openrouter" | "mock",
        modelId: model.modelId,
        role: model.role,
      },
      timeoutMs: node.config.timeoutMs,
    });

    // Record cost
    const cost = calculateCost(
      result.usage,
      {
        inputPricePerM: priceVersion ? Number(priceVersion.inputPricePerM) : null,
        outputPricePerM: priceVersion ? Number(priceVersion.outputPricePerM) : null,
        imagePrices: null,
      },
      ctx.fxRate,
    );
    await recordCostEvent(deps.db, {
      jobId: ctx.job.id,
      attemptId: ctx.attempt.id,
      stepRunId: stepRunId,
      nodeKey: node.nodeKey,
      provider: model.provider,
      modelId: model.id,
      modelPriceVersionId: priceVersion?.id ?? null,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      imageCount: 0,
      usdCost: String(cost.usdCost),
      fxRate: String(cost.fxRate),
      inrCost: String(cost.inrCost),
      providerReportedCostUsd: result.usage.providerReportedCostUsd == null
        ? null
        : String(result.usage.providerReportedCostUsd),
    });
    ctx.totalCostUsd += cost.usdCost;
    ctx.totalCostInr += cost.inrCost;

    // Parse + store truth sheet
    const parsed = garmentTruthSheetSchema.parse(result.data) as GarmentTruthSheet;
    ctx.truthSheet = parsed;
    ctx.truthSheetPromptVersionId = promptVersion?.id ?? null;
    ctx.truthSheetModelId = model.id;

    await updateJobTruthSheet(
      deps.db,
      ctx.job.id,
      parsed as unknown as Record<string, unknown>,
      ctx.truthSheetPromptVersionId ?? "",
      ctx.truthSheetModelId ?? "",
    );

    await completeStepRun(deps.db, stepRunId, {
      status: "succeeded",
      outputRef: { garmentType: parsed.garmentType, confidence: parsed.confidence },
    });
  });
};

// ─── Node: skill_select ────────────────────────────────────────────────────────

export const runSkillSelect: NodeRunner = async (ctx, node, deps) => {
  await runStep(ctx, node, deps, async (stepRunId) => {
    const settings = node.config.settings as { maxSkills?: number };
    const maxSkills = settings.maxSkills ?? 6;

    const truthSheet = ctx.truthSheet as Record<string, unknown>;
    const selections = ctx.job.selections as Record<string, unknown>;

    // Enrich context with derived flags for rule evaluation
    const enrichedSelections = {
      ...selections,
      hasCharacterReference: !!ctx.job.characterAssetId,
      environmentCategory: ctx.environment?.category ?? null,
      garmentComplexity: (truthSheet?.["complexity"] as string) ?? "medium",
      isRetry: ctx.attemptNumber > 1,
      hasAnatomyDefect: ctx.candidates.some((c) =>
        c.qualityReview?.criticalDefects.some(
          (d) =>
            d.code.includes("anatomy") ||
            d.code.includes("face") ||
            d.code.includes("hand") ||
            d.code.includes("finger"),
        ),
      ),
    };

    const { selectSkills } = await import("@shotlin/core");
    const selectedIds = selectSkills(ctx.skillRules, {
      truthSheet,
      selections: enrichedSelections,
    }, maxSkills);

    const instructions = selectedIds
      .map((id) => ctx.skillVersionsById.get(id)?.instruction ?? "")
      .filter(Boolean);

    ctx.selectedSkillVersionIds = selectedIds;
    ctx.skillInstructions = instructions;

    await completeStepRun(deps.db, stepRunId, {
      status: "succeeded",
      outputRef: {
        selectedSkillIds: selectedIds,
        count: selectedIds.length,
        garmentType: truthSheet?.["garmentType"],
      },
    });
  });
};

// ─── Node: prompt_compile ─────────────────────────────────────────────────────

export const runPromptCompile: NodeRunner = async (ctx, node, deps) => {
  const generationNode = ctx.workflowNodes.find((candidate) => candidate.nodeKey === "image_generate");
  const generationPromptVersionId = generationNode?.config?.promptVersionId ?? null;
  const promptVersionId = node.config.promptVersionId ?? generationPromptVersionId;
  const promptVersion = promptVersionId
    ? ctx.promptVersionsById.get(promptVersionId)
    : null;
  const settings = node.config.settings as {
    maxPromptChars?: number;
    skillCharBudget?: number;
  };
  const maxChars = settings.maxPromptChars ?? 7000;
  const skillCharBudget = settings.skillCharBudget ?? 2400;

  await runStep(ctx, node, deps, async (stepRunId) => {
    const { compilePrompt: doCompile } = await import("@shotlin/core");

    const systemPrompt = promptVersion?.body ?? "You are Shotlin's garment-fidelity image engine. Preserve every supported garment fact and return only the image.";

    const ts = ctx.truthSheet;
    const sel = ctx.job.selections as Record<string, unknown>;
    const env = ctx.environment;
    const char = ctx.character;

    const facts = [
      ts ? `GARMENT TYPE: ${(ts.garmentType ?? "unknown").toUpperCase()}` : null,
      ts?.inputType ? `REFERENCE TYPE: ${ts.inputType}` : null,
      ts?.colors?.length
        ? `COLOURS: ${(ts.colors as Array<{ name: string; hex?: string | null }>)
            .map((c) => `${c.name} (${c.hex ?? "no hex"})`)
            .join(", ")}`
        : null,
      ts?.material ? `MATERIAL: ${ts.material}` : null,
      ts?.pattern ? `PATTERN / WEAVE: ${ts.pattern}` : null,
      ts?.border ? `BORDER / TRIM: ${ts.border}` : null,
      ts?.embroidery ? `EMBROIDERY / DECORATION: ${ts.embroidery}` : null,
      ts?.neckline ? `NECKLINE / COLLAR: ${ts.neckline}` : null,
      ts?.sleeves ? `SLEEVES / CUFFS: ${ts.sleeves}` : null,
      ts?.lengthSilhouette ? `LENGTH / SILHOUETTE: ${ts.lengthSilhouette}` : null,
      ts?.drapePallu ? `DRAPE / PALLU: ${ts.drapePallu}` : null,
      ts?.protectedDetails?.length
        ? `PROTECTED DETAILS (preserve exactly): ${(ts.protectedDetails as string[]).join("; ")}`
        : null,
      ts?.specialDetails?.length
        ? `SPECIAL DETAILS: ${(ts.specialDetails as string[]).join("; ")}`
        : null,
      ts?.uncertainDetails?.length
        ? `UNCERTAIN / DO NOT INVENT: ${(ts.uncertainDetails as string[]).join("; ")}`
        : null,
      ts?.confidence !== undefined ? `ANALYSIS CONFIDENCE: ${ts.confidence}/100` : null,
      char ? `CHARACTER LOCK: ${char.name} — ${char.description} — ${JSON.stringify(char.attributes ?? {})}` : null,
      sel?.genderPresentation
        ? `GENDER PRESENTATION: ${sel.genderPresentation}`
        : null,
      sel?.ageAppearance ? `APPEARANCE AGE: ${sel.ageAppearance}` : null,
      sel?.heightAppearance ? `HEIGHT: ${sel.heightAppearance}` : null,
      sel?.pose && sel.pose !== "auto" ? `POSE: ${sel.pose}` : null,
      env ? `ENVIRONMENT: ${env.name} — ${env.promptFragment}` : null,
      `NEGATIVE CONSTRAINTS: no garment redesign, no invented motifs, no extra accessories, no logos or text unless visible in the reference, no anatomy errors, no background competing with the garment`,
      `RESOLUTION: ${ctx.job.requestedResolution}`,
      `ASPECT RATIO: ${ctx.job.aspectRatio}`,
    ]
      .filter(Boolean)
      .join("\n");

    const compiled = doCompile({
      systemPrompt,
      skillInstructions: ctx.skillInstructions,
      facts,
      repairInstruction: ctx.attempt.repairInstruction ?? undefined,
      maxChars,
      skillCharBudget,
    });

    ctx.compiledPrompt = compiled.prompt;

    if (!compiled.budget.mandatoryLayerPreserved) {
      // Facts and/or the repair instruction had to be cut to fit — this
      // should be rare (it means those layers alone exceeded maxChars) and
      // is worth a loud log line since it can silently degrade fidelity or
      // stall a retry loop that never sees its own correction.
      log.warn("prompt_compile could not preserve facts/repair within budget", {
        jobId: ctx.job.id,
        attemptId: ctx.attempt.id,
        stepRunId,
        maxChars,
      });
    }

    await completeStepRun(deps.db, stepRunId, {
      status: "succeeded",
      outputRef: {
        layerSizes: compiled.layerSizes,
        truncated: compiled.truncated,
        promptLength: compiled.prompt.length,
        budget: compiled.budget,
      },
    });
  });
};

/**
 * Resolve a job's reference images for generation/review — always the
 * enhanced (auto-upscaled) version of an asset when `input_check` produced
 * one, falling back to the original otherwise. Originals are never
 * mutated, so every reader needs to make this same choice; centralizing it
 * here means that choice can't drift between the vision step, the
 * generator, and the QA reviewers.
 *
 * Also surfaces the soft quality warnings `input_check` recorded (blurry,
 * upscaled) so callers — `runVision` in particular — can tell the model
 * the source is imperfect instead of either blocking on it or silently
 * treating it as pixel-perfect.
 */
async function resolveReferenceImages(
  db: Db,
  storage: Storage,
  jobId: string,
  opts: { excludeCharacter: boolean },
): Promise<{ images: { data: Buffer; mimeType: string }[]; warnings: string[] }> {
  const inputs = opts.excludeCharacter
    ? await db.select().from(jobInputs).where(and(eq(jobInputs.jobId, jobId), ne(jobInputs.role, "character")))
    : await db.select().from(jobInputs).where(eq(jobInputs.jobId, jobId));

  const warnings = new Set<string>();
  const images = await Promise.all(
    inputs.map(async (i) => {
      const [asset] = await db.select().from(assets).where(eq(assets.id, i.assetId)).limit(1);
      if (!asset) throw new Error(`Asset ${i.assetId} not found`);
      const report = asset.validationReport as { warnings?: string[] } | null;
      for (const w of report?.warnings ?? []) warnings.add(w);

      let source = asset;
      if (asset.enhancedAssetId) {
        const [enhanced] = await db.select().from(assets).where(eq(assets.id, asset.enhancedAssetId)).limit(1);
        if (enhanced) source = enhanced;
      }
      const data = await storage.getObject(source.bucket, source.objectKey);
      return { data, mimeType: source.mimeType };
    }),
  );

  return { images, warnings: [...warnings] };
}

/**
 * Resolve the character identity reference photo(s) for the job, if any.
 *
 * Priority:
 * 1. A customer-uploaded character photo (`job.characterAssetId`) always
 *    wins when present — it's the more specific, intentional choice.
 * 2. Else, if the selected catalog character has a structured identity
 *    pack (`character_identity_references` — front/¾/full-body), send all
 *    of those photos. Multiple angles of the same person are meant to hold
 *    identity steadier across generated angles than one photo can.
 * 3. Else, fall back to the character's single `previewAssetId`.
 *
 * Before the single-photo version of this fix (earlier this session), a
 * catalog character selection sent only a text description
 * ("CHARACTER LOCK: Priya — Indian woman in her mid-twenties...") to the
 * image generator — no photo at all, even though `previewAssetId` already
 * existed in the schema unused. This identity-pack version extends that:
 * a character with multiple reference angles now gets all of them sent,
 * not just one.
 */
async function resolveCharacterReferences(
  ctx: WorkflowContext,
  deps: { db: Db; storage: Storage },
): Promise<{ data: Buffer; mimeType: string }[]> {
  const fetchAsset = async (assetId: string) => {
    const [asset] = await deps.db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
    if (!asset) return null;
    return { data: await deps.storage.getObject(asset.bucket, asset.objectKey), mimeType: asset.mimeType };
  };

  if (ctx.job.characterAssetId) {
    const single = await fetchAsset(ctx.job.characterAssetId);
    return single ? [single] : [];
  }

  if (ctx.character) {
    const packRows = await deps.db
      .select()
      .from(characterIdentityReferences)
      .where(eq(characterIdentityReferences.characterId, ctx.character.id));
    if (packRows.length > 0) {
      const resolved = await Promise.all(packRows.map((row) => fetchAsset(row.assetId)));
      const usable = resolved.filter((r): r is { data: Buffer; mimeType: string } => r !== null);
      if (usable.length > 0) return usable;
    }
    if (ctx.character.previewAssetId) {
      const single = await fetchAsset(ctx.character.previewAssetId);
      if (single) return [single];
    }
  }

  return [];
}

/**
 * Anchor QA gate — reviews the anchor candidate immediately after it
 * generates, before any fan-out angle is requested. Returns true only when
 * the anchor did not fail outright, i.e. it is safe to spend on the
 * remaining angles.
 *
 * This intentionally does not gate on UNCERTAIN — resolving an uncertain
 * anchor may need a second opinion, and looping back into this step to fan
 * out afterward is a larger control-flow change (see
 * docs/REMAINING_MVP_EXECUTION_PLAN.md Phase 3). Gating on a confident FAIL
 * still captures the common wasteful case: a clearly wrong garment or
 * character in the anchor would have produced four more wrong images.
 *
 * The review this performs is the candidate's real primary review — it sets
 * `entry.qualityReview`/`entry.decision` directly, so the later
 * `quality_review` workflow step recognizes the anchor is already reviewed
 * and skips it rather than reviewing (and billing for) it twice.
 */
async function gateOnAnchorReview(
  ctx: WorkflowContext,
  deps: { db: Db; storage: Storage; providers: ResolvedProviders },
  entry: WorkflowContext["candidates"][number],
): Promise<boolean> {
  const model = ctx.modelsByRole.get("quality_reviewer");
  if (!model) {
    // No reviewer configured — nothing to gate on, proceed as before.
    return true;
  }
  const priceVersion = ctx.priceVersionsByModelId.get(model.id);
  // Reuse the configured quality_review node's prompt version so the anchor
  // is judged by the exact same rubric every other candidate is judged by.
  const qaNodeConfig = ctx.workflowNodes.find((n) => n.nodeKey === "quality_review")?.config;
  const promptVersion = qaNodeConfig?.promptVersionId
    ? ctx.promptVersionsById.get(qaNodeConfig.promptVersionId)
    : null;

  const { qualityReviewSchema } = await import("@shotlin/core");

  const { images: refs } = await resolveReferenceImages(deps.db, deps.storage, ctx.job.id, {
    excludeCharacter: false,
  });

  const [anchorAsset] = await deps.db
    .select()
    .from(assets)
    .where(eq(assets.id, entry.candidate.assetId))
    .limit(1);
  if (!anchorAsset) throw new Error(`Anchor asset ${entry.candidate.assetId} not found`);
  const anchorBuf = await deps.storage.getObject(anchorAsset.bucket, anchorAsset.objectKey);

  const systemPrompt = promptVersion?.body ?? "You are an independent quality reviewer.";

  let result;
  try {
    result = await deps.providers.reviewCandidate({
      originalReferences: refs,
      candidate: { data: anchorBuf, mimeType: anchorAsset.mimeType },
      truthSheet: ctx.truthSheet as GarmentTruthSheet,
      userSelections: ctx.job.selections as Record<string, unknown>,
      systemPrompt,
      model: {
        id: model.id,
        provider: model.provider as "openrouter" | "mock",
        modelId: model.modelId,
        role: model.role,
      },
      timeoutMs: qaNodeConfig?.timeoutMs ?? 60_000,
      attemptNumber: ctx.attemptNumber,
      jobId: ctx.job.id,
    });
  } catch (err) {
    // If the anchor can't even be reviewed, don't silently proceed to spend
    // on fan-out angles for an unverified anchor — but don't crash the whole
    // job here either; let the normal quality_review step retry the review
    // and surface the failure through the usual error path.
    log.error("anchor QA gate failed, proceeding without gating", {
      jobId: ctx.job.id,
      attemptId: ctx.attempt.id,
      candidateId: entry.candidate.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }

  const cost = calculateCost(
    result.usage,
    {
      inputPricePerM: priceVersion ? Number(priceVersion.inputPricePerM) : null,
      outputPricePerM: priceVersion ? Number(priceVersion.outputPricePerM) : null,
      imagePrices: null,
    },
    ctx.fxRate,
  );
  await recordCostEvent(deps.db, {
    jobId: ctx.job.id,
    attemptId: ctx.attempt.id,
    stepRunId: ctx.currentStep?.stepRunId ?? "",
    nodeKey: "quality_review",
    provider: model.provider,
    modelId: model.id,
    modelPriceVersionId: priceVersion?.id ?? null,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    imageCount: 0,
    usdCost: String(cost.usdCost),
    fxRate: String(cost.fxRate),
    inrCost: String(cost.inrCost),
    providerReportedCostUsd:
      result.usage.providerReportedCostUsd == null ? null : String(result.usage.providerReportedCostUsd),
  });
  ctx.totalCostUsd += cost.usdCost;
  ctx.totalCostInr += cost.inrCost;

  const review = qualityReviewSchema.parse(result.data) as QualityReview;
  entry.qualityReview = review;
  const ruled = evaluateRules(review, ruleConfigForContext(ctx));
  entry.decision = ruled.decision;
  entry.decisionReasons = ruled.reasons;

  const reviewRow = await createQualityReview(deps.db, {
    candidateId: entry.candidate.id,
    reviewType: "primary",
    reviewerModelId: model.id,
    promptVersionId: promptVersion?.id ?? null,
    review,
    garmentFidelityScore: review.scores.garmentFidelity,
    characterIdentityScore: review.scores.characterIdentity,
    photorealismScore: review.scores.photorealism,
  });
  await createDefects(deps.db, reviewRow.id, entry.candidate.id, [
    ...review.criticalDefects.map((d) => ({ ...d, severity: "critical" as const })),
    ...review.minorDefects.map((d) => ({ ...d, severity: "minor" as const })),
  ]);
  await deps.db
    .update(schema.generationCandidates)
    .set({ decision: ruled.decision, decisionReasons: ruled.reasons })
    .where(eq(schema.generationCandidates.id, entry.candidate.id));

  return ruled.decision !== "FAIL";
}

/**
 * Regenerate one specific angle that failed review, using the job's already
 * approved anchor as the identity reference and the reviewer's own repair
 * instruction as extra guidance — the passed angles are never touched. Used
 * by `runFinalize`'s single-angle retry: an anchor that already passed means
 * the rest of the set doesn't need to be redone wholesale just because one
 * angle came back wrong.
 *
 * Returns the new candidate entry (already reviewed, with its own decision
 * set) so the caller can decide whether the retry actually fixed it.
 */
async function retryFailedAngle(
  ctx: WorkflowContext,
  deps: { db: Db; storage: Storage; providers: ResolvedProviders },
  failed: WorkflowContext["candidates"][number],
  anchor: WorkflowContext["candidates"][number],
  repairInstruction: string,
): Promise<WorkflowContext["candidates"][number] | null> {
  const imageModel = ctx.modelsByRole.get("image_generator");
  const qaModel = ctx.modelsByRole.get("quality_reviewer");
  if (!imageModel || !qaModel) return null;
  const imagePriceVersion = ctx.priceVersionsByModelId.get(imageModel.id);
  const qaPriceVersion = ctx.priceVersionsByModelId.get(qaModel.id);

  const { CAMERA_ANGLES, buildAngleInstruction, qualityReviewSchema } = (await import(
    "@shotlin/core"
  )) as typeof import("@shotlin/core") & { qualityReviewSchema: typeof import("@shotlin/core").qualityReviewSchema };
  const angleKey = failed.candidate.cameraAngle;
  const angle = angleKey ? CAMERA_ANGLES[angleKey as keyof typeof CAMERA_ANGLES] : null;
  if (!angle) return null;

  const { images: refs } = await resolveReferenceImages(deps.db, deps.storage, ctx.job.id, {
    excludeCharacter: true,
  });
  const characterRefs = await resolveCharacterReferences(ctx, deps);
  const [anchorAsset] = await deps.db.select().from(assets).where(eq(assets.id, anchor.candidate.assetId)).limit(1);
  if (!anchorAsset) return null;
  const anchorImage = {
    data: await deps.storage.getObject(anchorAsset.bucket, anchorAsset.objectKey),
    mimeType: anchorAsset.mimeType,
  };

  const prompt = `${ctx.compiledPrompt}\n\n${buildAngleInstruction(angle, { isAnchor: false })}\n\nREPAIR INSTRUCTION: ${repairInstruction}`;

  const { checkModelCapabilities, parseModelCapabilities } = await import("@shotlin/core");
  const capabilityCheck = checkModelCapabilities(parseModelCapabilities(imageModel.capabilities), {
    referenceCount: refs.length + 1 + characterRefs.length,
    resolution: ctx.job.requestedResolution,
    count: 1,
  });
  if (!capabilityCheck.valid) {
    log.error("single-angle retry rejected by pre-flight model capability check", {
      jobId: ctx.job.id,
      attemptId: ctx.attempt.id,
      candidateId: failed.candidate.id,
      angleKey,
      reason: capabilityCheck.reason,
    });
    return null;
  }

  let genResult;
  try {
    genResult = await deps.providers.generateImage({
      references: [...refs, anchorImage],
      characterReferences: characterRefs,
      prompt,
      resolution: ctx.job.requestedResolution,
      aspectRatio: ctx.job.aspectRatio,
      count: 1,
      model: {
        id: imageModel.id,
        provider: imageModel.provider as "openrouter" | "mock",
        modelId: imageModel.modelId,
        role: imageModel.role,
      },
      timeoutMs: 60_000,
      attemptNumber: ctx.attemptNumber,
      jobId: ctx.job.id,
    });
  } catch (err) {
    log.error("single-angle retry failed to generate", {
      jobId: ctx.job.id,
      attemptId: ctx.attempt.id,
      candidateId: failed.candidate.id,
      angleKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const genCost = calculateCost(
    genResult.usage,
    {
      inputPricePerM: null,
      outputPricePerM: null,
      imagePrices: imagePriceVersion?.imagePrices as Record<string, number> | null,
    },
    ctx.fxRate,
  );
  await recordCostEvent(deps.db, {
    jobId: ctx.job.id,
    attemptId: ctx.attempt.id,
    stepRunId: ctx.currentStep?.stepRunId ?? "",
    nodeKey: "image_generate",
    provider: imageModel.provider,
    modelId: imageModel.id,
    modelPriceVersionId: imagePriceVersion?.id ?? null,
    inputTokens: genResult.usage.inputTokens,
    outputTokens: genResult.usage.outputTokens,
    imageCount: genResult.usage.imageCount,
    resolution: genResult.usage.resolution ?? ctx.job.requestedResolution,
    usdCost: String(genCost.usdCost),
    fxRate: String(genCost.fxRate),
    inrCost: String(genCost.inrCost),
    providerReportedCostUsd:
      genResult.usage.providerReportedCostUsd == null ? null : String(genResult.usage.providerReportedCostUsd),
  });
  ctx.totalCostUsd += genCost.usdCost;
  ctx.totalCostInr += genCost.inrCost;

  const image = genResult.images[0];
  if (!image) return null;

  const nextSequence = Math.max(0, ...ctx.candidates.map((c) => c.candidate.sequence)) + 1;
  const key = `outputs/${ctx.job.id}/${ctx.attempt.id}/${ctx.attemptNumber}-retry-${nextSequence}.png`;
  await deps.storage.putObject(deps.storage.outputsBucket, key, image.data, image.mimeType);
  const asset = await createAsset(deps.db, {
    userId: ctx.job.userId,
    kind: "generated_candidate",
    bucket: deps.storage.outputsBucket,
    objectKey: key,
    originalFilename: `retry-${nextSequence}.png`,
    mimeType: image.mimeType,
    sizeBytes: image.data.length,
  });
  const candidateRow = await createGenerationCandidate(deps.db, {
    jobId: ctx.job.id,
    attemptId: ctx.attempt.id,
    assetId: asset.id,
    sequence: nextSequence,
    isFinal: false,
    cameraAngle: angleKey,
    isAnchor: false,
  });
  const entry: WorkflowContext["candidates"][number] = {
    candidate: candidateRow,
    qualityReview: null,
    secondReview: null,
    decision: null,
    decisionReasons: [],
  };
  ctx.candidates.push(entry);

  // Review the repaired image with the same reviewer every other candidate
  // in this job was judged by.
  let reviewResult;
  try {
    reviewResult = await deps.providers.reviewCandidate({
      originalReferences: refs,
      candidate: image,
      truthSheet: ctx.truthSheet as GarmentTruthSheet,
      userSelections: ctx.job.selections as Record<string, unknown>,
      systemPrompt: "You are an independent quality reviewer.",
      model: {
        id: qaModel.id,
        provider: qaModel.provider as "openrouter" | "mock",
        modelId: qaModel.modelId,
        role: qaModel.role,
      },
      timeoutMs: 60_000,
      attemptNumber: ctx.attemptNumber,
      jobId: ctx.job.id,
    });
  } catch (err) {
    log.error("single-angle retry failed to review", {
      jobId: ctx.job.id,
      attemptId: ctx.attempt.id,
      candidateId: entry.candidate.id,
      angleKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return entry;
  }

  const qaCost = calculateCost(
    reviewResult.usage,
    { inputPricePerM: null, outputPricePerM: null, imagePrices: null },
    ctx.fxRate,
  );
  await recordCostEvent(deps.db, {
    jobId: ctx.job.id,
    attemptId: ctx.attempt.id,
    stepRunId: ctx.currentStep?.stepRunId ?? "",
    nodeKey: "quality_review",
    provider: qaModel.provider,
    modelId: qaModel.id,
    modelPriceVersionId: qaPriceVersion?.id ?? null,
    inputTokens: reviewResult.usage.inputTokens,
    outputTokens: reviewResult.usage.outputTokens,
    imageCount: 0,
    usdCost: String(qaCost.usdCost),
    fxRate: String(qaCost.fxRate),
    inrCost: String(qaCost.inrCost),
    providerReportedCostUsd:
      reviewResult.usage.providerReportedCostUsd == null ? null : String(reviewResult.usage.providerReportedCostUsd),
  });
  ctx.totalCostUsd += qaCost.usdCost;
  ctx.totalCostInr += qaCost.inrCost;

  const review = qualityReviewSchema.parse(reviewResult.data) as QualityReview;
  entry.qualityReview = review;
  const ruled = evaluateRules(review, ruleConfigForContext(ctx));
  entry.decision = ruled.decision;
  entry.decisionReasons = ruled.reasons;

  const reviewRow = await createQualityReview(deps.db, {
    candidateId: entry.candidate.id,
    reviewType: "primary",
    reviewerModelId: qaModel.id,
    promptVersionId: null,
    review,
    garmentFidelityScore: review.scores.garmentFidelity,
    characterIdentityScore: review.scores.characterIdentity,
    photorealismScore: review.scores.photorealism,
  });
  await createDefects(deps.db, reviewRow.id, entry.candidate.id, [
    ...review.criticalDefects.map((d) => ({ ...d, severity: "critical" as const })),
    ...review.minorDefects.map((d) => ({ ...d, severity: "minor" as const })),
  ]);
  await deps.db
    .update(schema.generationCandidates)
    .set({ decision: ruled.decision, decisionReasons: ruled.reasons })
    .where(eq(schema.generationCandidates.id, entry.candidate.id));

  return entry;
}

// ─── Node: image_generate ─────────────────────────────────────────────────────

export const runImageGenerate: NodeRunner = async (ctx, node, deps) => {
  const model = ctx.modelsByRole.get("image_generator");
  if (!model) throw new Error("No image_generator model configured");
  const priceVersion = ctx.priceVersionsByModelId.get(model.id);

  await runStep(ctx, node, deps, async (stepRunId) => {
    const { images: refs } = await resolveReferenceImages(deps.db, deps.storage, ctx.job.id, {
      excludeCharacter: true,
    });

    const characterRefs = await resolveCharacterReferences(ctx, deps);

    const { CAMERA_ANGLES, resolveAngleSet, buildAngleInstruction } = await import(
      "@shotlin/core"
    );
    const angleKeys = resolveAngleSet(ctx.job.outputCount, ctx.job.cameraAngles);
    const isMultiAngle = angleKeys.length > 1;

    const toModelRef = (m: typeof model) => ({
      id: m.id,
      provider: m.provider as "openrouter" | "mock",
      modelId: m.modelId,
      role: m.role,
    });
    const modelRef = toModelRef(model);

    // Resolved lazily, at most once per job attempt — a different enabled
    // image_generator model to fall back to if the configured one declines
    // to generate. `undefined` means "not looked up yet", `null` means
    // "looked up, none available".
    let fallbackModel: typeof model | null | undefined;
    const resolveFallbackModel = async () => {
      if (fallbackModel === undefined) {
        fallbackModel = await getFallbackImageModel(deps.db, model.id);
      }
      return fallbackModel;
    };

    /** Record the spend for one provider call and fold it into the running total. */
    const chargeUsage = async (
      usage: Parameters<typeof calculateCost>[0],
      billModel: typeof model,
    ) => {
      const billPriceVersion = ctx.priceVersionsByModelId.get(billModel.id);
      const cost = calculateCost(
        usage,
        {
          inputPricePerM: null,
          outputPricePerM: null,
          imagePrices: billPriceVersion?.imagePrices as Record<string, number> | null,
        },
        ctx.fxRate,
      );
      await recordCostEvent(deps.db, {
        jobId: ctx.job.id,
        attemptId: ctx.attempt.id,
        stepRunId: stepRunId,
        nodeKey: node.nodeKey,
        provider: billModel.provider,
        modelId: billModel.id,
        modelPriceVersionId: billPriceVersion?.id ?? null,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        imageCount: usage.imageCount,
        resolution: usage.resolution ?? ctx.job.requestedResolution,
        usdCost: String(cost.usdCost),
        fxRate: String(cost.fxRate),
        inrCost: String(cost.inrCost),
        providerReportedCostUsd: usage.providerReportedCostUsd == null
          ? null
          : String(usage.providerReportedCostUsd),
      });
      ctx.totalCostUsd += cost.usdCost;
      ctx.totalCostInr += cost.inrCost;
    };

    /** Persist one generated image as an asset + candidate row. */
    const persistCandidate = async (
      img: { data: Buffer; mimeType: string },
      opts: { sequence: number; angleKey: string | null; isAnchor: boolean },
    ) => {
      const key = `outputs/${ctx.job.id}/${ctx.attempt.id}/${ctx.attemptNumber}-${opts.sequence}.png`;
      await deps.storage.putObject(
        deps.storage.outputsBucket,
        key,
        img.data,
        img.mimeType,
      );

      const asset = await createAsset(deps.db, {
        userId: ctx.job.userId,
        kind: "generated_candidate",
        bucket: deps.storage.outputsBucket,
        objectKey: key,
        originalFilename: `candidate-${opts.sequence}.png`,
        mimeType: img.mimeType,
        sizeBytes: img.data.length,
      });

      const candidate = await createGenerationCandidate(deps.db, {
        jobId: ctx.job.id,
        attemptId: ctx.attempt.id,
        assetId: asset.id,
        sequence: opts.sequence,
        isFinal: false,
        cameraAngle: opts.angleKey,
        isAnchor: opts.isAnchor,
      });

      const entry: WorkflowContext["candidates"][number] = {
        candidate,
        qualityReview: null,
        secondReview: null,
        decision: null,
        decisionReasons: [],
      };
      ctx.candidates.push(entry);
      return entry;
    };

    /** One provider call for a single angle against one specific model. */
    const tryOneModel = async (
      genModel: typeof model,
      angleKey: (typeof angleKeys)[number],
      angleRefs: Array<{ data: Buffer; mimeType: string }>,
      prompt: string,
    ) => {
      const { checkModelCapabilities, parseModelCapabilities } = await import("@shotlin/core");
      const capabilityCheck = checkModelCapabilities(parseModelCapabilities(genModel.capabilities), {
        referenceCount: angleRefs.length + characterRefs.length,
        resolution: ctx.job.requestedResolution,
        count: 1,
      });
      if (!capabilityCheck.valid) {
        throw new ProviderError(capabilityCheck.reason, genModel.provider);
      }

      const result = await deps.providers.generateImage({
        references: angleRefs,
        characterReferences: characterRefs,
        prompt,
        resolution: ctx.job.requestedResolution,
        aspectRatio: ctx.job.aspectRatio,
        count: 1,
        model: toModelRef(genModel),
        timeoutMs: node.config.timeoutMs,
        attemptNumber: ctx.attemptNumber,
        jobId: ctx.job.id,
      });
      await chargeUsage(result.usage, genModel);
      const image = result.images[0];
      if (!image) {
        throw new Error(`No image returned for camera angle ${angleKey}`);
      }
      return image;
    };

    /**
     * One angle, with one automatic fallback: if the configured model
     * declines to generate at all (Gemini's opaque IMAGE_OTHER refusal and
     * similar), retry once against a different enabled image_generator
     * model before giving up on the angle. Any other failure (capability
     * rejection, timeout, auth, rate limit) fails identically on any model,
     * so it is not retried here — that would just double the spend on a
     * doomed request.
     */
    const generateAngle = async (
      angleKey: (typeof angleKeys)[number],
      opts: { isAnchor: boolean; anchorImage?: { data: Buffer; mimeType: string } },
    ) => {
      const angle = CAMERA_ANGLES[angleKey];
      // The anchor frame is appended last so it is the closest reference to the
      // identity-lock instruction that names it.
      const angleRefs = opts.anchorImage ? [...refs, opts.anchorImage] : refs;
      const prompt = isMultiAngle
        ? `${ctx.compiledPrompt}\n\n${buildAngleInstruction(angle, { isAnchor: opts.isAnchor })}`
        : ctx.compiledPrompt;

      try {
        return await tryOneModel(model, angleKey, angleRefs, prompt);
      } catch (err) {
        if (!isGenerationRefusal(err)) throw err;
        const fallback = await resolveFallbackModel();
        if (!fallback) throw err;
        log.error("image model declined to generate, retrying with fallback model", {
          jobId: ctx.job.id,
          attemptId: ctx.attempt.id,
          angleKey,
          primaryModelId: model.id,
          fallbackModelId: fallback.id,
          reason: err instanceof Error ? err.message : String(err),
        });
        return await tryOneModel(fallback, angleKey, angleRefs, prompt);
      }
    };

    if (!isMultiAngle) {
      const image = await generateAngle(angleKeys[0], { isAnchor: true });
      await persistCandidate(image, {
        sequence: 1,
        angleKey: null,
        isAnchor: true,
      });
    } else {
      // Pass 1 — anchor. Establishes the person and the garment.
      const anchorImage = await generateAngle(angleKeys[0], { isAnchor: true });
      const anchorEntry = await persistCandidate(anchorImage, {
        sequence: 1,
        angleKey: angleKeys[0],
        isAnchor: true,
      });

      // Anchor QA gate — review the anchor before spending on any fan-out
      // angle. A clearly-failed anchor means every fan-out angle would have
      // inherited the same wrong garment/identity, so generating them would
      // just be paying for images the set is going to fail anyway. This is
      // the anchor-first cost gate; it does not gate on UNCERTAIN (only a
      // confident FAIL stops fan-out) because resolving UNCERTAIN may require
      // a second opinion, and re-entering this step to fan out afterward is
      // a larger control-flow change than this pass makes — see
      // docs/REMAINING_MVP_EXECUTION_PLAN.md Phase 3.
      const anchorPassedGate = await gateOnAnchorReview(ctx, deps, anchorEntry);

      if (anchorPassedGate) {
        // Pass 2 — remaining angles in parallel, every one locked to the same
        // anchor so identity drift cannot compound across the set.
        const fanOut = angleKeys.slice(1);
        const settled = await Promise.allSettled(
          fanOut.map((angleKey) =>
            generateAngle(angleKey, { isAnchor: false, anchorImage }),
          ),
        );

        // An angle that threw here never became a candidate at all, which
        // makes it invisible to runFinalize's single-angle retry (that only
        // sees candidates that generated but failed review). A transient
        // infra failure (gateway error, dropped connection, timeout) gets
        // one immediate retry so it isn't silently dropped from the
        // delivered set just because of a hiccup unrelated to quality.
        const retryableIdx: number[] = [];
        for (let i = 0; i < settled.length; i++) {
          if (settled[i].status === "rejected") {
            const outcome = settled[i] as PromiseRejectedResult;
            if (isRetryableInfraError(outcome.reason)) retryableIdx.push(i);
          }
        }
        let retrySettled: PromiseSettledResult<{ data: Buffer; mimeType: string }>[] = [];
        if (retryableIdx.length > 0) {
          log.error("retrying fan-out angle(s) after a transient failure", {
            jobId: ctx.job.id,
            attemptId: ctx.attempt.id,
            angleKeys: retryableIdx.map((i) => fanOut[i]),
          });
          retrySettled = await Promise.allSettled(
            retryableIdx.map((i) =>
              generateAngle(fanOut[i], { isAnchor: false, anchorImage }),
            ),
          );
        }

        for (let i = 0; i < settled.length; i++) {
          let outcome = settled[i];
          const retryPos = retryableIdx.indexOf(i);
          if (retryPos !== -1) outcome = retrySettled[retryPos];

          if (outcome.status === "fulfilled") {
            await persistCandidate(outcome.value, {
              sequence: i + 2,
              angleKey: fanOut[i],
              isAnchor: false,
            });
          } else {
            // A single angle failing must not lose the angles that succeeded.
            log.error("fan-out angle failed to generate", {
              jobId: ctx.job.id,
              attemptId: ctx.attempt.id,
              angleKey: fanOut[i],
              retried: retryPos !== -1,
              error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
            });
          }
        }
      }
    }

    if (ctx.candidates.length === 0) {
      throw new Error("Image generation produced no candidates");
    }

    await completeStepRun(deps.db, stepRunId, {
      status: "succeeded",
      outputRef: {
        candidateCount: ctx.candidates.length,
        requestedAngles: angleKeys,
        deliveredAngles: ctx.candidates.map((c) => c.candidate.cameraAngle),
        assetIds: ctx.candidates.map((c) => c.candidate.assetId),
      },
    });
  });
};

// ─── Node: quality_review ─────────────────────────────────────────────────────

export const runQualityReview: NodeRunner = async (ctx, node, deps) => {
  const model = ctx.modelsByRole.get("quality_reviewer");
  if (!model) throw new Error("No quality_reviewer model configured");
  const priceVersion = ctx.priceVersionsByModelId.get(model.id);
  const promptVersion = node.config.promptVersionId
    ? ctx.promptVersionsById.get(node.config.promptVersionId)
    : null;

  await runStep(ctx, node, deps, async (stepRunId) => {
    const { qualityReviewSchema } = await import("@shotlin/core");

    // Every candidate this attempt produced must be reviewed — a multi-angle
    // set is only as trustworthy as its least-reviewed image. Candidates that
    // already carry a review are skipped, never re-billed. This includes the
    // anchor when image_generate's own QA gate already reviewed it before
    // deciding whether to spend on fan-out angles at all.
    if (ctx.candidates.length === 0) throw new Error("No candidate to review");
    const pending = ctx.candidates.filter((c) => !c.qualityReview);
    if (pending.length === 0) {
      await completeStepRun(deps.db, stepRunId, {
        status: "succeeded",
        outputRef: { reviewed: 0, alreadyReviewed: ctx.candidates.length },
      });
      return;
    }

    const { images: refs } = await resolveReferenceImages(deps.db, deps.storage, ctx.job.id, {
      excludeCharacter: false,
    });

    const systemPrompt =
      promptVersion?.body ?? "You are an independent quality reviewer.";

    const recordUsage = async (usage: Usage) => {
      const cost = calculateCost(
        usage,
        {
          inputPricePerM: priceVersion ? Number(priceVersion.inputPricePerM) : null,
          outputPricePerM: priceVersion ? Number(priceVersion.outputPricePerM) : null,
          imagePrices: null,
        },
        ctx.fxRate,
      );
      await recordCostEvent(deps.db, {
        jobId: ctx.job.id,
        attemptId: ctx.attempt.id,
        stepRunId,
        nodeKey: node.nodeKey,
        provider: model.provider,
        modelId: model.id,
        modelPriceVersionId: priceVersion?.id ?? null,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        imageCount: 0,
        usdCost: String(cost.usdCost),
        fxRate: String(cost.fxRate),
        inrCost: String(cost.inrCost),
        providerReportedCostUsd: usage.providerReportedCostUsd == null
          ? null
          : String(usage.providerReportedCostUsd),
      });
      ctx.totalCostUsd += cost.usdCost;
      ctx.totalCostInr += cost.inrCost;
    };

    const reviewOne = async (entry: WorkflowContext["candidates"][number]) => {
      const [asset] = await deps.db
        .select()
        .from(assets)
        .where(eq(assets.id, entry.candidate.assetId))
        .limit(1);
      if (!asset) throw new Error(`Candidate asset ${entry.candidate.assetId} not found`);
      const candidateBuf = await deps.storage.getObject(asset.bucket, asset.objectKey);

      let result;
      try {
        result = await deps.providers.reviewCandidate({
          originalReferences: refs,
          candidate: { data: candidateBuf, mimeType: asset.mimeType },
          truthSheet: ctx.truthSheet as GarmentTruthSheet,
          userSelections: ctx.job.selections as Record<string, unknown>,
          systemPrompt,
          model: {
            id: model.id,
            provider: model.provider as "openrouter" | "mock",
            modelId: model.modelId,
            role: model.role,
          },
          timeoutMs: node.config.timeoutMs,
          attemptNumber: ctx.attemptNumber,
          jobId: ctx.job.id,
        });
      } catch (err) {
        if (err instanceof ProviderError && err.usage) await recordUsage(err.usage);
        throw err;
      }

      await recordUsage(result.usage);

      const review = qualityReviewSchema.parse(result.data) as QualityReview;
      entry.qualityReview = review;

      // The LLM's verdict is advisory only — the deterministic rule engine
      // makes the actual PASS/FAIL/UNCERTAIN call for this specific candidate.
      const ruled = evaluateRules(review, ruleConfigForContext(ctx));
      entry.decision = ruled.decision;
      entry.decisionReasons = ruled.reasons;

      const reviewRow = await createQualityReview(deps.db, {
        candidateId: entry.candidate.id,
        reviewType: "primary",
        reviewerModelId: model.id,
        promptVersionId: promptVersion?.id ?? null,
        review,
        garmentFidelityScore: review.scores.garmentFidelity,
        characterIdentityScore: review.scores.characterIdentity,
        photorealismScore: review.scores.photorealism,
      });

      await createDefects(deps.db, reviewRow.id, entry.candidate.id, [
        ...review.criticalDefects.map((d) => ({ ...d, severity: "critical" as const })),
        ...review.minorDefects.map((d) => ({ ...d, severity: "minor" as const })),
      ]);

      await deps.db
        .update(schema.generationCandidates)
        .set({ decision: ruled.decision, decisionReasons: ruled.reasons })
        .where(eq(schema.generationCandidates.id, entry.candidate.id));

      return { angle: entry.candidate.cameraAngle, decision: ruled.decision };
    };

    // Independent per-image reviews — one candidate's provider error must not
    // block review of the others.
    const settled = await Promise.allSettled(pending.map(reviewOne));
    const failures = settled.filter(
      (s): s is PromiseRejectedResult => s.status === "rejected",
    );
    if (failures.length === settled.length) {
      // Every review call failed: nothing was evaluated, so nothing may ship.
      throw failures[0].reason;
    }

    await completeStepRun(deps.db, stepRunId, {
      status: "succeeded",
      outputRef: {
        reviewed: settled.filter((s) => s.status === "fulfilled").length,
        failed: failures.length,
        decisions: settled
          .filter((s): s is PromiseFulfilledResult<{ angle: string | null; decision: RuleResultDecision }> => s.status === "fulfilled")
          .map((s) => s.value),
      },
    });
  });
};

// ─── Node: rule_engine ────────────────────────────────────────────────────────

export const runRuleEngine: NodeRunner = async (ctx, node, deps) => {
  await runStep(ctx, node, deps, async (stepRunId) => {
    // Every candidate already carries its own decision from quality_review
    // (or second_review, once that has run). This rolls those per-image
    // decisions up into the single job-level decision that drives the state
    // machine's retry / second-review / finalize branches. The roll-up logic
    // itself lives in @shotlin/core with dedicated unit tests, since it is
    // the safety invariant that stops an unreviewed candidate from shipping.
    const { rollUpSetDecision } = await import("@shotlin/core");
    const outcomes = ctx.candidates.map((c) => ({
      isAnchor: c.candidate.isAnchor,
      cameraAngle: c.candidate.cameraAngle,
      decision: c.decision,
      decisionReasons: c.decisionReasons,
    }));
    const { decision, reasons } = rollUpSetDecision(outcomes);

    ctx.ruleDecision = decision;
    ctx.ruleReasons = reasons;
    await completeStepRun(deps.db, stepRunId, {
      status: "succeeded",
      outputRef: {
        decision,
        reasons,
        candidateDecisions: ctx.candidates.map((c) => ({
          angle: c.candidate.cameraAngle,
          isAnchor: c.candidate.isAnchor,
          decision: c.decision,
        })),
      },
    });
  });
};

// ─── Node: second_review ───────────────────────────────────────────────────────

export const runSecondReview: NodeRunner = async (ctx, node, deps) => {
  const model = ctx.modelsByRole.get("second_reviewer");
  if (!model) throw new Error("No second_reviewer model configured");
  const priceVersion = ctx.priceVersionsByModelId.get(model.id);
  const promptVersion = node.config.promptVersionId
    ? ctx.promptVersionsById.get(node.config.promptVersionId)
    : null;

  await runStep(ctx, node, deps, async (stepRunId) => {
    const { qualityReviewSchema } = await import("@shotlin/core");

    // Only candidates the primary review couldn't confidently call get a
    // second opinion — a confidently-passed or confidently-failed candidate
    // does not need re-litigating.
    const uncertain = ctx.candidates.filter((c) => c.decision === "UNCERTAIN");
    if (uncertain.length === 0) throw new Error("No uncertain candidate for second review");

    const { images: refs } = await resolveReferenceImages(deps.db, deps.storage, ctx.job.id, {
      excludeCharacter: false,
    });

    const systemPrompt =
      promptVersion?.body ?? "You are a second independent quality reviewer.";

    const recordUsage = async (usage: Usage) => {
      const cost = calculateCost(
        usage,
        {
          inputPricePerM: priceVersion ? Number(priceVersion.inputPricePerM) : null,
          outputPricePerM: priceVersion ? Number(priceVersion.outputPricePerM) : null,
          imagePrices: null,
        },
        ctx.fxRate,
      );
      await recordCostEvent(deps.db, {
        jobId: ctx.job.id,
        attemptId: ctx.attempt.id,
        stepRunId,
        nodeKey: node.nodeKey,
        provider: model.provider,
        modelId: model.id,
        modelPriceVersionId: priceVersion?.id ?? null,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        imageCount: 0,
        usdCost: String(cost.usdCost),
        fxRate: String(cost.fxRate),
        inrCost: String(cost.inrCost),
        providerReportedCostUsd: usage.providerReportedCostUsd == null
          ? null
          : String(usage.providerReportedCostUsd),
      });
      ctx.totalCostUsd += cost.usdCost;
      ctx.totalCostInr += cost.inrCost;
    };

    const reviewOne = async (entry: WorkflowContext["candidates"][number]) => {
      const [asset] = await deps.db
        .select()
        .from(assets)
        .where(eq(assets.id, entry.candidate.assetId))
        .limit(1);
      if (!asset) throw new Error("Asset not found");
      const candidateBuf = await deps.storage.getObject(asset.bucket, asset.objectKey);

      let result;
      try {
        result = await deps.providers.secondReview({
          originalReferences: refs,
          candidate: { data: candidateBuf, mimeType: asset.mimeType },
          truthSheet: ctx.truthSheet as GarmentTruthSheet,
          userSelections: ctx.job.selections as Record<string, unknown>,
          systemPrompt,
          model: {
            id: model.id,
            provider: model.provider as "openrouter" | "mock",
            modelId: model.modelId,
            role: model.role,
          },
          timeoutMs: node.config.timeoutMs,
          attemptNumber: ctx.attemptNumber,
          jobId: ctx.job.id,
        });
      } catch (err) {
        if (err instanceof ProviderError && err.usage) await recordUsage(err.usage);
        throw err;
      }

      await recordUsage(result.usage);

      const review = qualityReviewSchema.parse(result.data) as QualityReview;
      entry.secondReview = review;

      // The second opinion's ruled decision replaces the uncertain primary
      // decision — this is now the candidate's decision of record.
      const ruled = evaluateRules(review, ruleConfigForContext(ctx));
      entry.decision = ruled.decision;
      entry.decisionReasons = ruled.reasons;

      const reviewRow = await createQualityReview(deps.db, {
        candidateId: entry.candidate.id,
        reviewType: "second",
        reviewerModelId: model.id,
        promptVersionId: promptVersion?.id ?? null,
        review,
        garmentFidelityScore: review.scores.garmentFidelity,
        characterIdentityScore: review.scores.characterIdentity,
        photorealismScore: review.scores.photorealism,
      });

      await createDefects(deps.db, reviewRow.id, entry.candidate.id, [
        ...review.criticalDefects.map((d) => ({ ...d, severity: "critical" as const })),
        ...review.minorDefects.map((d) => ({ ...d, severity: "minor" as const })),
      ]);

      await deps.db
        .update(schema.generationCandidates)
        .set({ decision: ruled.decision, decisionReasons: ruled.reasons })
        .where(eq(schema.generationCandidates.id, entry.candidate.id));

      return { angle: entry.candidate.cameraAngle, decision: ruled.decision };
    };

    const settled = await Promise.allSettled(uncertain.map(reviewOne));
    const failures = settled.filter(
      (s): s is PromiseRejectedResult => s.status === "rejected",
    );
    if (failures.length === settled.length) throw failures[0].reason;

    await completeStepRun(deps.db, stepRunId, {
      status: "succeeded",
      outputRef: {
        reviewed: settled.filter((s) => s.status === "fulfilled").length,
        failed: failures.length,
      },
    });
  });
};

// ─── Node: retry / correction skill ──────────────────────────────────────────

export const runRetry: NodeRunner = async (ctx, node, deps) => {
  await runStep(ctx, node, deps, async (stepRunId) => {
    // A whole-set retry is only triggered when the anchor itself failed (see
    // rollUpSetDecision) — the anchor's review is what carries the actual
    // repair intelligence, regardless of which candidate was pushed last.
    const anchor = ctx.candidates.find((c) => c.candidate.isAnchor) ?? ctx.candidates[ctx.candidates.length - 1];
    const review = anchor?.secondReview ?? anchor?.qualityReview;
    const repairInstruction = review?.repairInstruction?.trim() ||
      "Re-run with stricter garment fidelity and correct every failed quality rule.";
    ctx.attempt.repairInstruction = repairInstruction;

    if (anchor && review) {
      const imageModel = ctx.modelsByRole.get("image_generator");
      await createRetryPlan(deps.db, {
        jobId: ctx.job.id,
        sourceAttemptId: ctx.attempt.id,
        sourceCandidateId: anchor.candidate.id,
        scope: "full_set",
        failedAngle: anchor.candidate.cameraAngle,
        criticalDefectCodes: review.criticalDefects.map((d) => d.code),
        minorDefectCodes: review.minorDefects.map((d) => d.code),
        reviewerExplanation: [...review.criticalDefects, ...review.minorDefects]
          .map((d) => d.description)
          .join(" "),
        repairInstruction,
        protectedAttributes: ["character identity", "garment base identity", "environment", "lighting"],
        generationModelId: imageModel?.id ?? null,
      });
    }

    await completeStepRun(deps.db, stepRunId, {
      status: "succeeded",
      outputRef: {
        branch: "FAIL",
        correctionSkill: "repair",
        instruction: repairInstruction,
        next: "image_generate",
      },
    });
  });
};

// ─── Node: finalize ────────────────────────────────────────────────────────────

export const runFinalize: NodeRunner = async (ctx, node, deps) => {
  const settings = node.config.settings as { previewMaxWidth?: number; jpgQuality?: number };
  const previewMaxWidth = settings.previewMaxWidth ?? 1600;
  const jpgQuality = settings.jpgQuality ?? 90;

  await runStep(ctx, node, deps, async (_stepRunId) => {
    if (ctx.candidates.length === 0) throw new Error("No candidates to finalize");

    // Single-angle retry: the anchor already passed (that's the only way
    // finalize is reached), but a non-anchor angle may have failed. Rather
    // than permanently withholding it, try regenerating just that one angle
    // once — the passed angles are never touched or re-billed. Each angle
    // gets at most one such retry per job, and only within remaining budget.
    const anchor = ctx.candidates.find((c) => c.candidate.isAnchor);
    const failedNonAnchor = ctx.candidates.filter(
      (c) => !c.candidate.isAnchor && c.decision === "FAIL",
    );
    if (anchor && failedNonAnchor.length > 0) {
      const imagesRequested = Math.max(Number(ctx.job.outputCount ?? 1), 1);
      const hardStop = Number(ctx.budgetRules.hardStopInr ?? 20) * imagesRequested;

      for (const failed of failedNonAnchor) {
        const review = failed.qualityReview;
        if (!review) continue;

        const alreadyRetried = await countPriorAngleRetries(
          deps.db,
          ctx.job.id,
          failed.candidate.cameraAngle,
        );
        if (alreadyRetried > 0) continue; // one retry per angle per job, ever
        if (ctx.totalCostInr >= hardStop) break; // no budget left for more attempts

        const repairInstruction = review.repairInstruction?.trim() ||
          "Correct every failed quality rule for this angle while keeping everything else identical to the anchor.";

        const plan = await createRetryPlan(deps.db, {
          jobId: ctx.job.id,
          sourceAttemptId: ctx.attempt.id,
          sourceCandidateId: failed.candidate.id,
          scope: "single_angle",
          failedAngle: failed.candidate.cameraAngle,
          criticalDefectCodes: review.criticalDefects.map((d) => d.code),
          minorDefectCodes: review.minorDefects.map((d) => d.code),
          reviewerExplanation: [...review.criticalDefects, ...review.minorDefects]
            .map((d) => d.description)
            .join(" "),
          repairInstruction,
          protectedAttributes: ["character identity", "garment base identity", "environment", "lighting", "approved anchor framing"],
          generationModelId: ctx.modelsByRole.get("image_generator")?.id ?? null,
        });

        const retried = await retryFailedAngle(ctx, deps, failed, anchor, repairInstruction);
        await resolveRetryPlan(deps.db, plan.id, {
          resultCandidateId: retried?.candidate.id ?? null,
          resultDecision: retried?.decision ?? null,
          status: retried?.decision === "PASS" ? "resolved" : "exhausted",
        });
      }
    }

    // Deliver only candidates the rule engine explicitly PASSed. A candidate
    // with decision === null (never reviewed) or "UNCERTAIN" (never resolved
    // by a second opinion) must never reach the customer — an unreviewed
    // image is not an approved image, no matter how the pipeline got here.
    // selectDeliverableCandidates is the same tested function that enforces
    // this invariant in @shotlin/core's unit tests.
    const { selectDeliverableCandidates } = await import("@shotlin/core");
    const finalists = selectDeliverableCandidates(ctx.candidates);
    if (finalists.length === 0) {
      // finalize only runs when the job-level decision is PASS, which requires
      // the anchor to have individually passed — so this should be unreachable.
      // Treat it as a hard invariant violation rather than silently shipping
      // an unapproved candidate.
      throw new Error(
        "finalize reached with zero PASS candidates — refusing to deliver an unreviewed or unapproved image",
      );
    }

    let sequence = 0;
    for (const entry of finalists) {
      sequence += 1;

      await deps.db
        .update(schema.generationCandidates)
        .set({ isFinal: true })
        .where(eq(schema.generationCandidates.id, entry.candidate.id));

      const [masterAsset] = await deps.db
        .select()
        .from(assets)
        .where(eq(assets.id, entry.candidate.assetId))
        .limit(1);
      if (!masterAsset) throw new Error("Master asset not found");

      const masterBuf = await deps.storage.getObject(
        masterAsset.bucket,
        masterAsset.objectKey,
      );
      const previewBuf = await makePreview(masterBuf, previewMaxWidth);
      const previewKey = `outputs/${ctx.job.id}/${entry.candidate.id}/preview.webp`;
      await deps.storage.putObject(
        deps.storage.outputsBucket,
        previewKey,
        previewBuf,
        "image/webp",
      );

      const previewAsset = await createAsset(deps.db, {
        userId: ctx.job.userId,
        kind: "preview",
        bucket: deps.storage.outputsBucket,
        objectKey: previewKey,
        mimeType: "image/webp",
        sizeBytes: previewBuf.length,
      });

      const jpgBuf = await toJpg(masterBuf, jpgQuality);
      const jpgKey = `outputs/${ctx.job.id}/${entry.candidate.id}/output.jpg`;
      await deps.storage.putObject(
        deps.storage.outputsBucket,
        jpgKey,
        jpgBuf,
        "image/jpeg",
      );

      const jpgAsset = await createAsset(deps.db, {
        userId: ctx.job.userId,
        kind: "jpg_variant",
        bucket: deps.storage.outputsBucket,
        objectKey: jpgKey,
        mimeType: "image/jpeg",
        sizeBytes: jpgBuf.length,
      });

      await createJobOutput(deps.db, {
        jobId: ctx.job.id,
        masterAssetId: masterAsset.id,
        previewAssetId: previewAsset.id,
        jpgAssetId: jpgAsset.id,
        sequence,
        cameraAngle: entry.candidate.cameraAngle,
      });
    }

    await finalizeJobCost(
      deps.db,
      ctx.job.id,
      ctx.totalCostUsd,
      ctx.totalCostInr,
    );
  });
};

// ─── Registry ────────────────────────────────────────────────────────────────

export const NODE_RUNNERS: Record<string, NodeRunner> = {
  input_check: runInputCheck,
  vision: runVision,
  skill_select: runSkillSelect,
  prompt_compile: runPromptCompile,
  image_generate: runImageGenerate,
  quality_review: runQualityReview,
  rule_engine: runRuleEngine,
  second_review: runSecondReview,
  retry: runRetry,
  finalize: runFinalize,
};
