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
} from "@shotlin/database";
import {
  calculateCost,
  DEFAULT_RULE_CONFIG,
  compilePrompt,
  evaluateRules,
  validateImageInput,
  type GarmentTruthSheet,
  type QualityReview,
} from "@shotlin/core";
import { extractImageMeta } from "@shotlin/platform";
import { ProviderError, type ResolvedProviders, type Usage } from "@shotlin/providers";
import type { Storage } from "@shotlin/platform";
import { makePreview, toJpg } from "@shotlin/platform";
import type { WorkflowContext } from "./context";
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

function ruleConfigForContext(ctx: WorkflowContext) {
  return {
    minGarmentFidelity: Number(ctx.budgetRules.minGarmentFidelity ?? DEFAULT_RULE_CONFIG.minGarmentFidelity),
    minCharacterIdentity: Number(ctx.budgetRules.minCharacterIdentity ?? DEFAULT_RULE_CONFIG.minCharacterIdentity),
    minPhotorealism: Number(ctx.budgetRules.minPhotorealism ?? DEFAULT_RULE_CONFIG.minPhotorealism),
    minAnatomy: Number(ctx.budgetRules.minAnatomy ?? DEFAULT_RULE_CONFIG.minAnatomy),
    minTechnicalQuality: Number(ctx.budgetRules.minTechnicalQuality ?? DEFAULT_RULE_CONFIG.minTechnicalQuality),
    uncertaintyBand: Number(ctx.budgetRules.uncertaintyBand ?? DEFAULT_RULE_CONFIG.uncertaintyBand),
    minReviewerConfidence: Number(ctx.budgetRules.minReviewerConfidence ?? DEFAULT_RULE_CONFIG.minReviewerConfidence),
    hardFailDefectCodes: [] as string[],
  };
}

// ─── Node: input_check ────────────────────────────────────────────────────────

export const runInputCheck: NodeRunner = async (ctx, node, deps) => {
  await runStep(ctx, node, deps, async (stepRunId) => {
    const thresholds = node.config.thresholds as {
      maxBytes?: number;
      minDimension?: number;
      blurThreshold?: number;
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
      const validation = validateImageInput(meta, {
        maxBytes: thresholds.maxBytes ?? 26_214_400,
        minDimension: thresholds.minDimension ?? 512,
        maxDimension: 10_000,
        blurThreshold: thresholds.blurThreshold ?? 100,
        allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
      });

      if (!validation.usable) {
        const { updateJobState } = await import("./db");
        await updateJobState(deps.db, ctx.job.id, "input_rejected", validation.reasons.join("; "));
        throw new Error(`Input rejected: ${validation.reasons.join("; ")}`);
      }

      await deps.db
        .update(assets)
        .set({
          validationStatus: "usable",
          validationReport: { usable: true, reasons: validation.reasons, width: meta.width, height: meta.height } as any,
          width: meta.width,
          height: meta.height,
          sizeBytes: buf.length,
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

    const inputs = await deps.db
      .select()
      .from(jobInputs)
      .where(and(eq(jobInputs.jobId, ctx.job.id), ne(jobInputs.role, "character")));

    const refs = await Promise.all(
      inputs.map(async (i) => {
        const [asset] = await deps.db
          .select()
          .from(assets)
          .where(eq(assets.id, i.assetId))
          .limit(1);
        if (!asset) throw new Error(`Asset ${i.assetId} not found`);
        const buf = await deps.storage.getObject(asset.bucket, asset.objectKey);
        return { data: buf, mimeType: asset.mimeType };
      }),
    );

    const systemPrompt =
      promptVersion?.body ??
      "You are a garment analysis expert. Return only valid JSON.";

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

    await completeStepRun(deps.db, stepRunId, {
      status: "succeeded",
      outputRef: {
        layerSizes: compiled.layerSizes,
        truncated: compiled.truncated,
        promptLength: compiled.prompt.length,
      },
    });
  });
};

// ─── Node: image_generate ─────────────────────────────────────────────────────

export const runImageGenerate: NodeRunner = async (ctx, node, deps) => {
  const model = ctx.modelsByRole.get("image_generator");
  if (!model) throw new Error("No image_generator model configured");
  const priceVersion = ctx.priceVersionsByModelId.get(model.id);

  await runStep(ctx, node, deps, async (stepRunId) => {
    const inputs = await deps.db
      .select()
      .from(jobInputs)
      .where(and(eq(jobInputs.jobId, ctx.job.id), ne(jobInputs.role, "character")));

    const refs = await Promise.all(
      inputs.map(async (i) => {
        const [asset] = await deps.db
          .select()
          .from(assets)
          .where(eq(assets.id, i.assetId))
          .limit(1);
        if (!asset) throw new Error(`Asset ${i.assetId} not found`);
        const buf = await deps.storage.getObject(asset.bucket, asset.objectKey);
        return { data: buf, mimeType: asset.mimeType };
      }),
    );

    let characterRef: { data: Buffer; mimeType: string } | undefined;
    if (ctx.job.characterAssetId) {
      const [charAsset] = await deps.db
        .select()
        .from(assets)
        .where(eq(assets.id, ctx.job.characterAssetId))
        .limit(1);
      if (charAsset) {
        const buf = await deps.storage.getObject(charAsset.bucket, charAsset.objectKey);
        characterRef = { data: buf, mimeType: charAsset.mimeType };
      }
    }

    const { CAMERA_ANGLES, resolveAngleSet, buildAngleInstruction } = await import(
      "@shotlin/core"
    );
    const angleKeys = resolveAngleSet(ctx.job.outputCount, ctx.job.cameraAngles);
    const isMultiAngle = angleKeys.length > 1;

    const imgPrices = priceVersion?.imagePrices as Record<string, number> | null;
    const modelRef = {
      id: model.id,
      provider: model.provider as "openrouter" | "mock",
      modelId: model.modelId,
      role: model.role,
    };

    /** Record the spend for one provider call and fold it into the running total. */
    const chargeUsage = async (usage: Parameters<typeof calculateCost>[0]) => {
      const cost = calculateCost(
        usage,
        { inputPricePerM: null, outputPricePerM: null, imagePrices: imgPrices },
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

      ctx.candidates.push({ candidate, qualityReview: null, secondReview: null });
      return { candidate, image: img };
    };

    /** One provider call for a single angle. */
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

      const result = await deps.providers.generateImage({
        references: angleRefs,
        characterReference: characterRef,
        prompt,
        resolution: ctx.job.requestedResolution,
        aspectRatio: ctx.job.aspectRatio,
        count: 1,
        model: modelRef,
        timeoutMs: node.config.timeoutMs,
        attemptNumber: ctx.attemptNumber,
        jobId: ctx.job.id,
      });
      await chargeUsage(result.usage);
      const image = result.images[0];
      if (!image) {
        throw new Error(`No image returned for camera angle ${angleKey}`);
      }
      return image;
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
      await persistCandidate(anchorImage, {
        sequence: 1,
        angleKey: angleKeys[0],
        isAnchor: true,
      });

      // Pass 2 — remaining angles in parallel, every one locked to the same
      // anchor so identity drift cannot compound across the set.
      const fanOut = angleKeys.slice(1);
      const settled = await Promise.allSettled(
        fanOut.map((angleKey) =>
          generateAngle(angleKey, { isAnchor: false, anchorImage }),
        ),
      );

      for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i];
        if (outcome.status === "fulfilled") {
          await persistCandidate(outcome.value, {
            sequence: i + 2,
            angleKey: fanOut[i],
            isAnchor: false,
          });
        } else {
          // A single angle failing must not lose the angles that succeeded.
          console.error(
            `[worker] job ${ctx.job.id} angle ${fanOut[i]} failed:`,
            outcome.reason instanceof Error ? outcome.reason.message : outcome.reason,
          );
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

    const candidateToReview = ctx.candidates[ctx.candidates.length - 1];
    if (!candidateToReview) throw new Error("No candidate to review");

    const [asset] = await deps.db
      .select()
      .from(assets)
      .where(eq(assets.id, candidateToReview.candidate.assetId))
      .limit(1);
    if (!asset) throw new Error(`Candidate asset ${candidateToReview.candidate.assetId} not found`);

    const inputs = await deps.db
      .select()
      .from(jobInputs)
      .where(eq(jobInputs.jobId, ctx.job.id));
    const refs = await Promise.all(
      inputs.map(async (i) => {
        const [a] = await deps.db
          .select()
          .from(assets)
          .where(eq(assets.id, i.assetId))
          .limit(1);
        if (!a) throw new Error(`Asset ${i.assetId} not found`);
        const buf = await deps.storage.getObject(a.bucket, a.objectKey);
        return { data: buf, mimeType: a.mimeType };
      }),
    );

    const candidateBuf = await deps.storage.getObject(asset.bucket, asset.objectKey);
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

    /*
     * A malformed review response is recorded above and then fails this job.
     * It can never reach the retry node, so it cannot buy a second image.
     */
    const review = qualityReviewSchema.parse(result.data) as QualityReview;
    candidateToReview.qualityReview = review;

    const reviewRow = await createQualityReview(deps.db, {
      candidateId: candidateToReview.candidate.id,
      reviewType: "primary",
      reviewerModelId: model.id,
      promptVersionId: promptVersion?.id ?? null,
      review,
      garmentFidelityScore: review.scores.garmentFidelity,
      characterIdentityScore: review.scores.characterIdentity,
      photorealismScore: review.scores.photorealism,
    });

    await createDefects(deps.db, reviewRow.id, candidateToReview.candidate.id, [
      ...review.criticalDefects.map((d) => ({ ...d, severity: "critical" as const })),
      ...review.minorDefects.map((d) => ({ ...d, severity: "minor" as const })),
    ]);

    await completeStepRun(deps.db, stepRunId, {
      status: "succeeded",
      outputRef: {
        decision: "reviewed",
        garmentFidelity: review.scores.garmentFidelity,
        confidence: review.confidence,
        defectCount: review.criticalDefects.length + review.minorDefects.length,
      },
    });
  });
};

// ─── Node: rule_engine ────────────────────────────────────────────────────────

export const runRuleEngine: NodeRunner = async (ctx, node, deps) => {
  await runStep(ctx, node, deps, async (stepRunId) => {
    const candidate = ctx.candidates[ctx.candidates.length - 1];
    const review = candidate?.secondReview ?? candidate?.qualityReview;
    if (!review) throw new Error("No quality review to evaluate");
    const result = evaluateRules(review, ruleConfigForContext(ctx));
    ctx.ruleDecision = result.decision;
    ctx.ruleReasons = result.reasons;
    await completeStepRun(deps.db, stepRunId, {
      status: "succeeded",
      outputRef: {
        decision: result.decision,
        reasons: result.reasons,
        garmentScore: result.garmentScore,
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

    const candidate = ctx.candidates[ctx.candidates.length - 1];
    if (!candidate) throw new Error("No candidate for second review");

    const [asset] = await deps.db
      .select()
      .from(assets)
      .where(eq(assets.id, candidate.candidate.assetId))
      .limit(1);
    if (!asset) throw new Error("Asset not found");

    const inputs = await deps.db
      .select()
      .from(jobInputs)
      .where(eq(jobInputs.jobId, ctx.job.id));
    const refs = await Promise.all(
      inputs.map(async (i) => {
        const [a] = await deps.db
          .select()
          .from(assets)
          .where(eq(assets.id, i.assetId))
          .limit(1);
        if (!a) throw new Error(`Asset ${i.assetId} not found`);
        const buf = await deps.storage.getObject(a.bucket, a.objectKey);
        return { data: buf, mimeType: a.mimeType };
      }),
    );

    const candidateBuf = await deps.storage.getObject(asset.bucket, asset.objectKey);
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
    candidate.secondReview = review;

    const reviewRow = await createQualityReview(deps.db, {
      candidateId: candidate.candidate.id,
      reviewType: "second",
      reviewerModelId: model.id,
      promptVersionId: promptVersion?.id ?? null,
      review,
      garmentFidelityScore: review.scores.garmentFidelity,
      characterIdentityScore: review.scores.characterIdentity,
      photorealismScore: review.scores.photorealism,
    });

    await createDefects(deps.db, reviewRow.id, candidate.candidate.id, [
      ...review.criticalDefects.map((d) => ({ ...d, severity: "critical" as const })),
      ...review.minorDefects.map((d) => ({ ...d, severity: "minor" as const })),
    ]);

    await completeStepRun(deps.db, stepRunId, {
      status: "succeeded",
      outputRef: {
        decision: "second_reviewed",
        garmentFidelity: review.scores.garmentFidelity,
        confidence: review.confidence,
      },
    });
  });
};

// ─── Node: retry / correction skill ──────────────────────────────────────────

export const runRetry: NodeRunner = async (ctx, node, deps) => {
  await runStep(ctx, node, deps, async (stepRunId) => {
    const candidate = ctx.candidates[ctx.candidates.length - 1];
    const repairInstruction = candidate?.qualityReview?.repairInstruction?.trim() ||
      "Re-run with stricter garment fidelity and correct every failed quality rule.";
    ctx.attempt.repairInstruction = repairInstruction;
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

    // Deliver every candidate that is not a confirmed quality failure. A single
    // angle failing review must not withhold the angles that passed.
    const deliverable = ctx.candidates.filter((c) => {
      const review = c.secondReview ?? c.qualityReview;
      return !review || review.criticalDefects.length === 0;
    });
    // Never deliver nothing: fall back to the anchor so the customer still gets
    // the frame the rule engine judged the set on.
    const finalists = deliverable.length > 0 ? deliverable : [ctx.candidates[0]];

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
