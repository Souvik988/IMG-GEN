/**
 * Idempotent seed for the Shotlin MVP.
 * Safe to run repeatedly — existing rows are left untouched.
 */
import { desc, eq, isNull } from "drizzle-orm";
import { hashPassword } from "@shotlin/platform";
import { createDb } from "./client";
import { loadRootEnv, requireEnv } from "./env";
import {
  budgetRules,
  characters,
  costEvents,
  jobStepRuns,
  environmentPresets,
  modelPriceVersions,
  modelRegistry,
  promptVersions,
  prompts,
  skillRules,
  skillVersions,
  skills,
  users,
  workflowNodeConfigs,
  workflowNodes,
  workflowVersions,
  workflows,
} from "./schema";

async function getOrCreate<T extends { id: string }>(
  db: any,
  table: any,
  uniqueKey: string,
  uniqueValue: string,
  values: Record<string, unknown>,
): Promise<T> {
  const existing = await db
    .select()
    .from(table)
    .where(eq(table[uniqueKey], uniqueValue))
    .limit(1);
  if (existing.length > 0) return existing[0] as T;
  const inserted = await db.insert(table).values(values as any).returning();
  return inserted[0] as T;
}

async function backfillDeterministicCostEvents(db: any) {
  const deterministicNodes = new Set([
    "input_check",
    "skill_select",
    "prompt_compile",
    "rule_engine",
    "retry",
    "finalize",
  ]);
  const missing = await db
    .select({ step: jobStepRuns })
    .from(jobStepRuns)
    .leftJoin(costEvents, eq(costEvents.stepRunId, jobStepRuns.id))
    .where(isNull(costEvents.id));
  const rows = missing
    .map((row: { step: typeof jobStepRuns.$inferSelect }) => row.step)
    .filter((step: typeof jobStepRuns.$inferSelect) =>
      (step.status === "succeeded" && deterministicNodes.has(step.nodeKey)) ||
      step.status === "skipped",
    );
  if (rows.length === 0) return;

  const [budget] = await db.select().from(budgetRules).limit(1);
  await db.insert(costEvents).values(
    rows.map((step: typeof jobStepRuns.$inferSelect) => ({
      jobId: step.jobId,
      attemptId: step.attemptId,
      stepRunId: step.id,
      nodeKey: step.nodeKey,
      provider: "deterministic",
      modelId: null,
      modelPriceVersionId: null,
      inputTokens: 0,
      outputTokens: 0,
      imageCount: 0,
      usdCost: "0",
      fxRate: String(budget?.usdInrRate ?? "1"),
      inrCost: "0",
      providerReportedCostUsd: null,
      createdAt: step.finishedAt ?? step.startedAt,
    })),
  );
}

async function main() {
  loadRootEnv();
  const url = requireEnv("DATABASE_URL");
  const { db, pool } = createDb(url, 1);

  /* ---------------- budget rules (singleton) ---------------- */
  await db
    .insert(budgetRules)
    .values({
      singletonKey: "global",
      // Defect codes that always FAIL a candidate even if the reviewer
      // itself classified them as minor — see docs/03_Shotlin_MVP_AI_Build_Instructions.md
      // "Hard-fail rules". Admin-editable after seeding.
      hardFailDefectCodes: [
        "WRONG_PRIMARY_COLOR",
        "MISSING_BORDER",
        "WRONG_BORDER_PATTERN",
        "WRONG_PALLU",
        "MAJOR_EMBROIDERY_CHANGE",
        "LOGO_CHANGED",
        "GARMENT_COMPONENT_MISSING",
        "MAJOR_SILHOUETTE_CHANGE",
        "WRONG_CHARACTER",
        "BROKEN_HAND",
        "BROKEN_LIMB",
        "EXTRA_LIMB",
        "SEVERE_FACE_ARTIFACT",
        "SEVERE_AI_ARTIFACT",
      ],
    })
    .onConflictDoNothing();

  /* ---------------- users ---------------- */
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@shotlin.local";
  const configuredAdminPassword = process.env.SEED_ADMIN_PASSWORD;
  const adminPassword = configuredAdminPassword ?? "shotlin-admin-123";

  if (process.env.NODE_ENV === "production" && !configuredAdminPassword) {
    throw new Error(
      "Missing required environment variable: SEED_ADMIN_PASSWORD. Set a unique password before running the production seed.",
    );
  }
  if (configuredAdminPassword && configuredAdminPassword.length < 16) {
    throw new Error("SEED_ADMIN_PASSWORD must be at least 16 characters long.");
  }

  const admin = await getOrCreate(db, users, "email", adminEmail, {
    email: adminEmail,
    name: "Shotlin Admin",
    role: "admin",
    passwordHash: hashPassword(adminPassword),
  });
  /* ---------------- characters ---------------- */
  const characterSeeds = [
    {
      name: "Priya",
      description: "Indian woman in her mid-twenties, medium height, graceful posture.",
      attributes: {
        gender: "female",
        ageAppearance: "mid-20s",
        height: "average",
        build: "slim",
        skinTone: "warm medium",
        hair: "long dark hair",
      },
      sortOrder: 1,
    },
    {
      name: "Aarav",
      description: "Indian man in his late twenties, tall, athletic frame.",
      attributes: {
        gender: "male",
        ageAppearance: "late-20s",
        height: "tall",
        build: "athletic",
        skinTone: "medium",
        hair: "short black hair",
      },
      sortOrder: 2,
    },
    {
      name: "Ishita",
      description: "Indian woman in her early thirties, poised and elegant.",
      attributes: {
        gender: "female",
        ageAppearance: "early-30s",
        height: "average",
        build: "medium",
        skinTone: "fair",
        hair: "shoulder-length dark hair",
      },
      sortOrder: 3,
    },
    {
      name: "Rohan",
      description: "Indian man in his mid-thirties, broad shoulders, confident stance.",
      attributes: {
        gender: "male",
        ageAppearance: "mid-30s",
        height: "tall",
        build: "broad",
        skinTone: "wheatish",
        hair: "short black hair, light beard",
      },
      sortOrder: 4,
    },
    {
      name: "Meera",
      description: "Young Indian woman, late teens, fresh and lively presence.",
      attributes: {
        gender: "female",
        ageAppearance: "late-teens",
        height: "petite",
        build: "slim",
        skinTone: "light",
        hair: "long wavy hair",
      },
      sortOrder: 5,
    },
    {
      name: "Kabir",
      description: "Indian man in his forties, distinguished and mature look.",
      attributes: {
        gender: "male",
        ageAppearance: "mid-40s",
        height: "average",
        build: "medium",
        skinTone: "medium",
        hair: "salt-and-pepper, short",
      },
      sortOrder: 6,
    },
  ];
  for (const c of characterSeeds) {
    await getOrCreate(db, characters, "name", c.name, {
      ...c,
      isPreset: true,
    });
  }

  /* ---------------- environment presets ---------------- */
  const environmentSeeds = [
    {
      key: "outdoor-natural",
      name: "Outdoor Natural",
      category: "outdoor",
      description: "Soft natural daylight, garden or street backdrop.",
      promptFragment:
        "Natural outdoor setting with soft directional daylight, gentle wind in the fabric, shallow depth of field background, candid editorial feel.",
      sortOrder: 1,
    },
    {
      key: "outdoor-premium",
      name: "Outdoor Premium",
      category: "outdoor",
      description: "Golden-hour luxury outdoor location.",
      promptFragment:
        "Premium outdoor location at golden hour, architectural or landscaped backdrop, warm rim light, high-end fashion campaign atmosphere.",
      sortOrder: 2,
    },
    {
      key: "indoor-premium",
      name: "Indoor Premium",
      category: "indoor",
      description: "Elegant hotel lobby or luxury interior.",
      promptFragment:
        "Elegant premium interior with warm ambient lighting, refined furniture and decor, luxury lifestyle magazine aesthetic.",
      sortOrder: 3,
    },
    {
      key: "studio-commercial",
      name: "Studio Commercial",
      category: "studio",
      description: "Clean commercial photo studio setup.",
      promptFragment:
        "Professional photo studio with seamless backdrop, controlled softbox lighting, crisp commercial catalogue rendering of the garment.",
      sortOrder: 4,
    },
    {
      key: "festive",
      name: "Festive",
      category: "festive",
      description: "Indian festive celebration ambience.",
      promptFragment:
        "Indian festive ambience with marigold and warm decorative lighting, celebratory mood, rich colour grading, subtle bokeh lights.",
      sortOrder: 5,
    },
    {
      key: "cinematic-fashion",
      name: "Cinematic Fashion",
      category: "cinematic",
      description: "Dramatic cinematic fashion editorial.",
      promptFragment:
        "Cinematic fashion editorial mood, dramatic key light with controlled shadows, filmic colour grade, composed like a movie still.",
      sortOrder: 6,
    },
    {
      key: "clean-minimal",
      name: "Clean / Minimal",
      category: "minimal",
      description: "Minimal white background, product-forward.",
      promptFragment:
        "Clean minimal white environment, even diffused lighting, no distracting props, full focus on the garment and wearer.",
      sortOrder: 7,
    },
  ];
  for (const e of environmentSeeds) {
    await getOrCreate(db, environmentPresets, "key", e.key, e);
  }

  /* ---------------- model registry + price versions ---------------- */
  type ModelSeed = {
    name: string;
    provider: "openrouter" | "mock";
    modelId: string;
    role:
      | "vision_analyzer"
      | "prompt_compiler"
      | "image_generator"
      | "quality_reviewer"
      | "second_reviewer";
    isEnabled: boolean;
    capabilities: Record<string, unknown>;
    notes?: string;
    inputPricePerM?: string;
    outputPricePerM?: string;
    imagePrices?: Record<string, number>;
  };
  const modelSeeds: ModelSeed[] = [
    {
      name: "OpenRouter · Qwen 3.8 27B · vision",
      provider: "openrouter",
      modelId: "qwen/qwen3.8-27b",
      role: "vision_analyzer",
      isEnabled: true,
      capabilities: { maxImageRefs: 6, structuredOutputs: true, multimodal: true },
      notes: "OpenRouter multimodal analyzer. Structured JSON is requested with strict schema and validated again with Zod.",
      inputPricePerM: "0.450000",
      outputPricePerM: "3.200000",
    },
    {
      name: "OpenRouter · Qwen 3.8 27B · adaptive compiler",
      provider: "openrouter",
      modelId: "qwen/qwen3.8-27b",
      role: "prompt_compiler",
      isEnabled: false,
      capabilities: { structuredOutputs: false, textOnly: true },
      notes: "Optional adaptive wording pass. Disabled by default because deterministic compilation protects facts and saves a call.",
      inputPricePerM: "0.450000",
      outputPricePerM: "3.200000",
    },
    {
      name: "OpenRouter · Nano Banana 2 (Gemini 3.1 Flash Image)",
      provider: "openrouter",
      modelId: "google/gemini-3.1-flash-image",
      role: "image_generator",
      isEnabled: true,
      capabilities: {
        maxImageRefs: 14,
        resolutions: ["1k", "2k", "4k"],
        supportsReferenceImages: true,
        supportsMultiOutput: false,
      },
      notes: "Nano Banana 2 through OpenRouter's dedicated Image API. Chosen for realistic reference-driven garment imagery with 1K, 2K and 4K output.",
      inputPricePerM: "0.500000",
      outputPricePerM: "3.000000",
      imagePrices: { "1k": 0.067, "2k": 0.101, "4k": 0.151 },
    },
    {
      name: "OpenRouter · Qwen 3.8 27B · quality review",
      provider: "openrouter",
      modelId: "qwen/qwen3.8-27b",
      role: "quality_reviewer",
      isEnabled: true,
      capabilities: { maxImageRefs: 8, structuredOutputs: true, multimodal: true },
      notes: "Independent structured reviewer; strict rubric and deterministic rule engine decide PASS/FAIL.",
      inputPricePerM: "0.450000",
      outputPricePerM: "3.200000",
    },
    {
      name: "OpenRouter · Qwen 3.8 27B · adjudicator",
      provider: "openrouter",
      modelId: "qwen/qwen3.8-27b",
      role: "second_reviewer",
      isEnabled: true,
      capabilities: { maxImageRefs: 8, structuredOutputs: true, multimodal: true },
      notes: "Second opinion only for uncertainty-band cases; avoids a second call on clear PASS/FAIL outcomes.",
      inputPricePerM: "0.450000",
      outputPricePerM: "3.200000",
    },
  ];
  for (const m of modelSeeds) {
    const existing = await db
      .select()
      .from(modelRegistry)
      .where(eq(modelRegistry.role, m.role))
      .limit(10);
    const match = existing[0];
    let modelRow: any;
    if (match) {
      modelRow = (await db
        .update(modelRegistry)
        .set({
          name: m.name,
          provider: m.provider,
          modelId: m.modelId,
          isEnabled: m.isEnabled,
          capabilities: m.capabilities,
          notes: m.notes ?? null,
          updatedAt: new Date(),
        })
        .where(eq(modelRegistry.id, match.id))
        .returning())[0];
    } else {
      const inserted = await db
        .insert(modelRegistry)
        .values({
          name: m.name,
          provider: m.provider,
          modelId: m.modelId,
          role: m.role,
          isEnabled: m.isEnabled,
          capabilities: m.capabilities,
          notes: m.notes ?? null,
        })
        .returning();
      modelRow = inserted[0];
    }
    const prices = await db
      .select()
      .from(modelPriceVersions)
      .where(eq(modelPriceVersions.modelId, modelRow.id))
      .orderBy(desc(modelPriceVersions.version));
    const priceMatches = prices.find((price: any) =>
      price.isActive &&
      String(price.inputPricePerM ?? "") === String(m.inputPricePerM ?? "") &&
      String(price.outputPricePerM ?? "") === String(m.outputPricePerM ?? "") &&
      JSON.stringify(price.imagePrices ?? null) === JSON.stringify(m.imagePrices ?? null),
    );
    if (!priceMatches) {
      await db
        .update(modelPriceVersions)
        .set({ isActive: false })
        .where(eq(modelPriceVersions.modelId, modelRow.id));
      await db.insert(modelPriceVersions).values({
        modelId: modelRow.id,
        version: (prices[0]?.version ?? 0) + 1,
        inputPricePerM: m.inputPricePerM ?? null,
        outputPricePerM: m.outputPricePerM ?? null,
        imagePrices: m.imagePrices ?? null,
        isActive: true,
      });
    }
  }

  const modelByRole: Record<string, any> = {};
  for (const row of await db.select().from(modelRegistry)) {
    if (modelByRole[row.role] === undefined) modelByRole[row.role] = row;
  }

  /* ---------------- prompts + production versions ---------------- */
  const promptSeeds = [
    {
      key: "garment-analysis",
      name: "Garment Analysis",
      category: "garment_vision",
      description:
        "Vision system prompt that produces the strict GarmentTruthSheet JSON.",
      body: `ROLE
You are Shotlin's forensic garment analyst. You convert reference images into a conservative Garment Truth Sheet for a downstream image generator. You are not a stylist, designer, or copywriter.

SOURCE OF TRUTH
The attached garment references outrank all prose. Observe the images before interpreting them. If references conflict, prefer the clearest view and record the conflict in uncertainDetails. Never fill a gap with a culturally typical or aesthetically likely detail.

OBSERVATION PROTOCOL
1. Inspect each reference independently, then reconcile only facts visible in more than one view or clearly visible in one view.
2. Separate observation from inference. Use concrete visual language: placement, repeat, scale, edge, seam, closure, drape, sheen, opacity, and silhouette.
3. Name every identity-bearing detail: color blocks, motif geometry, repeat spacing, border position, embroidery, logos/text, labels, pleats, seams, slits, closures, tassels, and visible lining.
4. Use a hex value only when the image supports a stable approximation; otherwise use null and explain the uncertainty.
5. If a region is hidden, cropped, blurred, backlit, or too small to read, put it in uncertainDetails. Do not silently guess.
6. Confidence is confidence in the complete sheet. Cap it when a protected detail is not visible; do not use confidence to express how attractive the garment is.

CLASSIFICATION NOTE
Use garmentType "lehenga" for a coordinated choli or blouse, flared skirt, and dupatta set. Do not collapse a lehenga set into "menswear", "dress", or "other".

OUTPUT CONTRACT
Return ONLY valid JSON matching the supplied Garment Truth Sheet schema. No markdown, explanation, styling suggestions, alternative designs, or imagined details. `,
      variables: [],
    },
    {
      key: "input-quality",
      name: "Input Quality Check",
      category: "input_quality",
      description:
        "AI fallback usable only when deterministic checks cannot decide.",
      body: `You are Shotlin's strict reference-quality gate. Deterministic checks have already verified file type, dimensions, decode, and blur; you decide only whether the garment can be reproduced faithfully from the visible evidence.

Accept a reference when the garment identity, major construction, color relationships, and important surface details are visible enough for a careful analyst to describe them. Reject when the garment is mostly hidden, severely cropped, too dark, overexposed, motion-smeared, dominated by a filter, or too small to distinguish its construction. Do not reject a usable imperfect phone photo merely because it is not beautiful.

Return ONLY valid JSON with exactly: { "usable": boolean, "reason": string, "recommendation": string, "confidence": integer 0-100 }. Keep the reason factual and the recommendation actionable.`,
      variables: [],
    },
    {
      key: "image-generation-system",
      name: "Image Generation System",
      category: "image_generation",
      description: "Layer A fixed instructions for the image generator.",
      body: `ROLE
You are Shotlin's garment-fidelity image engine. Produce one polished, photorealistic fashion photograph from the attached references and the compiled production brief.

SOURCE PRIORITY
1. Garment reference images lock the garment's identity and construction.
2. Character reference image, when present, locks the person's identity; change clothing only.
3. The compiled brief controls scene, framing, pose, and lighting only where it does not contradict the references.
4. Skills are implementation constraints, not permission to invent.

NON-NEGOTIABLE FIDELITY
- Preserve the exact visible color relationships, pattern geometry, motif scale and placement, border/embroidery repeat, seams, neckline, sleeves, closures, labels, logos, text, lining, transparency, and drape.
- Do not redesign, beautify, modernize, culturally substitute, simplify, add ornament, remove ornament, mirror a logo, or invent a back side that is not supported.
- Treat protected details as locked attributes. If a detail is uncertain, preserve the visible evidence without inventing a confident replacement.

PHOTOGRAPHIC STANDARD
Create a believable single-camera photograph: coherent perspective, natural human anatomy, correct hands and fingers, plausible garment tension and contact shadows, physically consistent light, realistic fabric texture, and clean edges. Keep the selected character, age presentation, height impression, environment, aspect ratio, and framing. Do not add text or watermarks.

REPAIR BEHAVIOR
On a retry, correct only the named defects. Keep every already-correct garment, character, pose, environment, and lighting attribute unchanged.

Output only the image. {{compiledPrompt}}`,
      variables: ["compiledPrompt"],
    },
    {
      key: "quality-review",
      name: "Quality Review",
      category: "quality_review",
      description:
        "Independent reviewer comparing the generated image against the original garment.",
      body: `ROLE
You are Shotlin's independent visual quality reviewer. You did not generate the candidate. Compare the original garment references and the candidate image side by side; the candidate is the last attached image.

REVIEW ORDER
1. Verify the candidate actually shows the requested garment and a usable view of the protected regions.
2. Compare color blocks, pattern geometry, motif scale/placement, border and embroidery repeat, silhouette, construction, fit, drape, and special details against the references and truth sheet.
3. Check character identity only against the supplied character reference or selected character description.
4. Check anatomy, perspective, fabric physics, lighting continuity, sharpness, and rendering artifacts.

SCORING
95-100 means near-perfect evidence-based match, not merely attractive. 90-94 means good but with a visible mismatch. Below 90 means the mismatch is material. A wrong protected color, missing/added identity detail, invented logo/text, broken construction, severe anatomy problem, or unusable crop is critical. If a region cannot be judged, lower confidence and describe the limitation instead of awarding a high score.

REPAIR RULE
Write one minimal repairInstruction that names the exact defect and expected correction. Never say make it better, improve quality, or try again. If the candidate passes, use empty defect arrays and an empty repairInstruction.

Return ONLY valid JSON matching the supplied quality-review schema.`,
      variables: [],
    },
    {
      key: "repair",
      name: "Repair Instruction",
      category: "repair",
      description: "Guidance for building targeted retry prompts (Layer D).",
      body: `You are the correction-policy compiler for Shotlin retries. Translate reviewer defects into a minimal, testable delta.

Rules:
- Correct only defects explicitly supported by the review and references.
- Name the affected region, current error, expected reference state, and placement/scale when known.
- Reassert that every already-correct attribute is locked and must not drift.
- Preserve character identity, pose, framing, environment, lighting, and camera unless the review names one of them.
- Never use vague language such as make it better, improve quality, or make it more realistic.
- If evidence is insufficient, request manual review rather than inventing a repair.`,
      variables: [],
    },
    {
      key: "second-review",
      name: "Second Review",
      category: "second_review",
      description: "Independent second opinion for uncertain cases.",
      body: `You are Shotlin's second-pass adjudicator. The first review was inside the uncertainty band. Independently inspect the references, truth sheet, candidate image, and first review findings.

Resolve uncertainty conservatively: a protected detail must be visibly supported before it earns a high score. If the first reviewer is wrong, correct the scores and defects based on image evidence. Do not average scores blindly and do not reward aesthetics over identity fidelity. If the candidate cannot be judged because of crop, occlusion, or resolution, keep confidence low and identify the exact limitation.

Return ONLY valid JSON matching the quality-review schema.`,
      variables: [],
    },
    {
      key: "prompt-compiler",
      name: "Prompt Compiler (adaptive)",
      category: "prompt_compiler",
      description:
        "Optional LLM wording pass over the deterministic compiled prompt.",
      body: `You are an optional wording pass for Shotlin's deterministic brief. You may improve ordering and clarity only. You must not add, remove, reinterpret, or soften any garment fact, protected detail, character constraint, environment choice, repair instruction, or negative constraint. Preserve all explicit values and keep the result under {{maxChars}} characters. Return instruction text only. If a fact is ambiguous, preserve the ambiguity instead of resolving it.\n\nSTRUCTURED BRIEF:\n{{compiledPrompt}}`,
      variables: ["compiledPrompt", "maxChars"],
    },
  ];

  const promptVersionByKey: Record<string, any> = {};
  for (const p of promptSeeds) {
    const promptRow = await getOrCreate(db, prompts, "key", p.key, {
      key: p.key,
      name: p.name,
      category: p.category,
      description: p.description,
    });
    const versions = await db
      .select()
      .from(promptVersions)
      .where(eq(promptVersions.promptId, promptRow.id))
      .orderBy(desc(promptVersions.version));
    const currentVersion = versions[0];
    if (!currentVersion) {
      const inserted = await db
        .insert(promptVersions)
        .values({
          promptId: promptRow.id,
          version: 1,
          status: "production",
          body: p.body,
          variables: p.variables,
          notes: "Seed production v1",
          createdById: admin.id,
          publishedAt: new Date(),
        })
        .returning();
      promptVersionByKey[p.key] = inserted[0];
    } else if (currentVersion.body !== p.body || JSON.stringify(currentVersion.variables) !== JSON.stringify(p.variables)) {
      await db
        .update(promptVersions)
        .set({ status: "archived" })
        .where(eq(promptVersions.promptId, promptRow.id));
      const inserted = await db
        .insert(promptVersions)
        .values({
          promptId: promptRow.id,
          version: currentVersion.version + 1,
          status: "production",
          body: p.body,
          variables: p.variables,
          notes: "Fidelity workflow upgrade: structured observation, source locking, and repair-safe prompting.",
          createdById: admin.id,
          publishedAt: new Date(),
        })
        .returning();
      promptVersionByKey[p.key] = inserted[0];
    } else {
      promptVersionByKey[p.key] = currentVersion;
    }
  }

  /* ---------------- skills + versions + rules ---------------- */
  type SkillSeed = {
    key: string;
    name: string;
    category: string;
    purpose: string;
    instruction: string;
    priority: number;
    rules: Array<{ description: string; conditions: Array<{ field: string; op: string; value: unknown }> }>;
  };
  const skillSeeds: SkillSeed[] = [
    {
      key: "generic-garment-fidelity",
      name: "Generic Garment Fidelity",
      category: "fidelity",
      purpose: "Non-negotiable conservation of the reference garment.",
      instruction:
        "REFERENCE LOCK: reproduce the garment as evidence, not inspiration. Preserve color relationships, fabric surface, silhouette, seams, panels, closures, labels, logos/text, hems, lining, transparency, and fit. Keep motif geometry, repeat scale, spacing, and region placement aligned to the reference. Do not restyle, improve, simplify, embellish, substitute, mirror, add, or remove any garment detail.",
      priority: 100,
      rules: [
        {
          description: "Always active for garment generation jobs",
          conditions: [{ field: "always", op: "equals", value: true }],
        },
      ],
    },
    {
      key: "saree-fidelity",
      name: "Saree Fidelity",
      category: "fidelity",
      purpose: "Saree-specific drape and detail preservation.",
      instruction:
        "SAREE CONSTRUCTION LOCK: preserve the exact drape family, pallu side and endpoint, pleat direction and density, border position on body/pallu/hem, blouse neckline and sleeve construction, fall, tassels, and any visible petticoat. Use the reference's drape as the pattern; do not switch to a culturally typical drape. Keep folds physically plausible for the selected pose without changing the design.",
      priority: 90,
      rules: [
        {
          description: "Detected garment type is saree",
          conditions: [{ field: "garmentType", op: "equals", value: "saree" }],
        },
      ],
    },
    {
      key: "kurta-fidelity",
      name: "Kurta Fidelity",
      category: "fidelity",
      purpose: "Kurta/kurti construction fidelity.",
      instruction:
        "KURTA/KURTI CONSTRUCTION LOCK: preserve neckline or collar geometry, placket and button spacing, yoke/panel seams, sleeve length and cuff, side-slit height, hem length, ease, opacity, and embroidery placement exactly as visible. Never convert a straight silhouette into an anarkali, dress, tunic, or embellished variant.",
      priority: 90,
      rules: [
        {
          description: "Detected garment type is kurta",
          conditions: [{ field: "garmentType", op: "equals", value: "kurta" }],
        },
        {
          description: "Detected garment type is kurti",
          conditions: [{ field: "garmentType", op: "equals", value: "kurti" }],
        },
      ],
    },
    {
      key: "lehenga-fidelity",
      name: "Lehenga Fidelity",
      category: "fidelity",
      purpose: "Lehenga-set construction and dupatta preservation.",
      instruction:
        "LEHENGA-SET CONSTRUCTION LOCK: preserve the coordinated choli, skirt, and dupatta as separate garments. Keep the choli neckline, sleeve length, bodice seams, skirt flare and waistband, hem/border repeat, motif spacing, and dupatta transparency, edge trim, and drape exactly as visible. Do not convert the set into a gown, saree, salwar suit, or generic dress; do not invent unseen back details.",
      priority: 90,
      rules: [
        {
          description: "Detected garment type is lehenga",
          conditions: [{ field: "garmentType", op: "equals", value: "lehenga" }],
        },
      ],
    },
    {
      key: "dress-fidelity",
      name: "Dress Fidelity",
      category: "fidelity",
      purpose: "Dress construction and silhouette fidelity.",
      instruction:
        "DRESS CONSTRUCTION LOCK: preserve bodice seams, neckline, shoulder treatment, waistline, skirt volume, paneling, hem length, closures, lining, and sheerness. Keep the reference silhouette; do not change fit-and-flare to bodycon, add a belt, or invent a train, slit, or sleeve.",
      priority: 90,
      rules: [
        {
          description: "Detected garment type is dress",
          conditions: [{ field: "garmentType", op: "equals", value: "dress" }],
        },
      ],
    },
    {
      key: "character-preservation",
      name: "Character Preservation",
      category: "character",
      purpose: "Keep the supplied character identity intact.",
      instruction:
        "CHARACTER LOCK: the supplied character reference controls identity. Preserve facial structure, skin tone, hairline, hair texture/style, age impression, body proportions, and distinctive features. Change only the clothing and scene requested. Do not beautify into a different person, alter ethnicity, or replace the face with a generic model.",
      priority: 85,
      rules: [
        {
          description: "Character reference image supplied",
          conditions: [
            { field: "hasCharacterReference", op: "equals", value: true },
          ],
        },
      ],
    },
    {
      key: "fine-textile-detail",
      name: "Fine Textile Detail",
      category: "fidelity",
      purpose: "Extra attention to complex textile work.",
      instruction:
        "TEXTILE MICRO-DETAIL LOCK: this garment contains high-information surface work. Preserve motif topology, repeat scale, border-to-body proportion, thread direction, stitch density, sequins/zari highlights, and texture continuity across folds. Keep the same design when the fabric bends; do not smear, tile incorrectly, or invent ornament.",
      priority: 70,
      rules: [
        {
          description: "Vision analysis marked complexity high",
          conditions: [
            { field: "garmentComplexity", op: "equals", value: "high" },
          ],
        },
      ],
    },
    {
      key: "outdoor-photography",
      name: "Outdoor Photography",
      category: "environment",
      purpose: "Natural outdoor lighting realism.",
      instruction:
        "OUTDOOR SCENE: use one coherent natural light direction and color temperature, believable contact shadows, real lens perspective, restrained depth of field, and only subtle fabric movement supported by the scene. The background must support the garment rather than compete with its pattern.",
      priority: 60,
      rules: [
        {
          description: "Outdoor environment selected",
          conditions: [
            { field: "environmentCategory", op: "equals", value: "outdoor" },
          ],
        },
      ],
    },
    {
      key: "indoor-photography",
      name: "Indoor Photography",
      category: "environment",
      purpose: "Interior lighting realism.",
      instruction:
        "INDOOR SCENE: maintain one coherent interior perspective, believable ambient/practical light, color-consistent shadows, realistic reflections, and enough even illumination to inspect the garment. Avoid busy decor, warped lines, and mixed light that changes garment colors.",
      priority: 60,
      rules: [
        {
          description: "Indoor environment selected",
          conditions: [
            { field: "environmentCategory", op: "equals", value: "indoor" },
          ],
        },
      ],
    },
    {
      key: "studio-photography",
      name: "Studio Photography",
      category: "environment",
      purpose: "Commercial studio rendering.",
      instruction:
        "STUDIO SCENE: use controlled softbox-style lighting, a clean seamless backdrop, correct garment-shaping light, neutral color rendering, and catalogue-level sharpness across the identity-bearing regions. Keep the garment dominant and the background quiet.",
      priority: 60,
      rules: [
        {
          description: "Studio environment selected",
          conditions: [
            { field: "environmentCategory", op: "equals", value: "studio" },
          ],
        },
      ],
    },
    {
      key: "photorealism",
      name: "Photorealism",
      category: "rendering",
      purpose: "Global photographic realism standard.",
      instruction:
        "PHOTOREALISM: render a genuine camera photograph with physically plausible skin, hair, fabric tension, weave, seams, folds, contact shadows, perspective, and color science. Avoid illustration, plastic skin, CGI smoothness, painterly texture, duplicated limbs, melted fingers, warped text, and synthetic halos.",
      priority: 50,
      rules: [
        {
          description: "Always active",
          conditions: [{ field: "always", op: "equals", value: true }],
        },
      ],
    },
    {
      key: "garment-repair",
      name: "Garment Repair",
      category: "repair",
      purpose: "Retry guidance for garment defects.",
      instruction:
        "REPAIR / GARMENT: the previous candidate failed on named garment details. Re-inspect the original references, apply only the exact repair delta, and freeze every already-correct color, motif, seam, silhouette, character, pose, environment, and lighting attribute.",
      priority: 95,
      rules: [
        {
          description: "Retry attempt after garment defects",
          conditions: [{ field: "isRetry", op: "equals", value: true }],
        },
      ],
    },
    {
      key: "anatomy-repair",
      name: "Anatomy / Character Repair",
      category: "repair",
      purpose: "Retry guidance for anatomy defects.",
      instruction:
        "REPAIR / PERSON: correct only the named face, hand, finger, limb, proportion, or identity defect with natural human anatomy. Freeze the garment, its protected details, pose, framing, environment, and lighting unless explicitly named in the defect.",
      priority: 95,
      rules: [
        {
          description: "Retry attempt after anatomy defects",
          conditions: [
            { field: "isRetry", op: "equals", value: true },
            { field: "hasAnatomyDefect", op: "equals", value: true },
          ],
        },
      ],
    },
    {
      key: "garment-analysis",
      name: "Garment Analysis",
      category: "analysis",
      purpose:
        "Reserved for vision-node guidance; not auto-selected by the MVP selector.",
      instruction:
        "Describe garments factually and completely; separate certain observations from uncertain ones; protected details must be exhaustive.",
      priority: 40,
      rules: [],
    },
  ];

  for (const s of skillSeeds) {
    const skillRow = await getOrCreate(db, skills, "key", s.key, {
      key: s.key,
      name: s.name,
      category: s.category,
      purpose: s.purpose,
    });
    const skillVersionsForSkill = await db
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.skillId, skillRow.id))
      .orderBy(desc(skillVersions.version));
    const currentSkillVersion = skillVersionsForSkill[0];
    if (!currentSkillVersion) {
      await db.insert(skillVersions).values({
        skillId: skillRow.id,
        version: 1,
        status: "production",
        instruction: s.instruction,
        priority: s.priority,
        notes: "Seed production v1",
        publishedAt: new Date(),
      });
    } else if (currentSkillVersion.instruction !== s.instruction || currentSkillVersion.priority !== s.priority) {
      await db
        .update(skillVersions)
        .set({ status: "archived" })
        .where(eq(skillVersions.skillId, skillRow.id));
      await db.insert(skillVersions).values({
        skillId: skillRow.id,
        version: currentSkillVersion.version + 1,
        status: "production",
        instruction: s.instruction,
        priority: s.priority,
        notes: "Fidelity workflow upgrade: narrow, reference-locked skill instruction.",
        publishedAt: new Date(),
      });
    }
    const existingRules = await db
      .select()
      .from(skillRules)
      .where(eq(skillRules.skillId, skillRow.id));
    if (existingRules.length === 0 && s.rules.length > 0) {
      for (const rule of s.rules) {
        await db.insert(skillRules).values({
          skillId: skillRow.id,
          description: rule.description,
          conditions: rule.conditions,
        });
      }
    }
  }

  /* ---------------- default workflow ---------------- */
  const workflowRow = await getOrCreate(db, workflows, "key", "default", {
    key: "default",
    name: "Shotlin Default Generation Workflow",
    description:
      "Fixed MVP pipeline: input check → vision → skills → compile → generate → QA → rules → second review → retry → finalize.",
  });
  let workflowVersionRow = (
    await db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, workflowRow.id))
      .limit(1)
  )[0];
  if (!workflowVersionRow) {
    workflowVersionRow = (
      await db
        .insert(workflowVersions)
        .values({
          workflowId: workflowRow.id,
          version: 1,
          status: "production",
          publishedAt: new Date(),
        })
        .returning()
    )[0];
  }

  type NodeSeed = {
    nodeKey: string;
    sequence: number;
    name: string;
    nodeType: string;
    modelRole?: string;
    promptKey?: string;
    timeoutMs?: number;
    maxRetries?: number;
    thresholds?: Record<string, unknown>;
    settings?: Record<string, unknown>;
  };
  const nodeSeeds: NodeSeed[] = [
    {
      nodeKey: "input_check",
      sequence: 1,
      name: "Input Quality Check",
      nodeType: "deterministic_with_ai_fallback",
      promptKey: "input-quality",
      timeoutMs: 60000,
      thresholds: {
        maxBytes: 26214400,
        minDimension: 512,
        blurThreshold: 100,
      },
      settings: { aiFallbackEnabled: true },
    },
    {
      nodeKey: "vision",
      sequence: 2,
      name: "Garment Vision Analysis",
      nodeType: "model",
      modelRole: "vision_analyzer",
      promptKey: "garment-analysis",
      timeoutMs: 120000,
      maxRetries: 1,
    },
    {
      nodeKey: "skill_select",
      sequence: 3,
      name: "Skill Selector",
      nodeType: "deterministic",
      settings: { maxSkills: 7 },
    },
    {
      nodeKey: "prompt_compile",
      sequence: 4,
      name: "Prompt Compiler",
      nodeType: "template",
      promptKey: "image-generation-system",
      settings: {
        mode: "template",
        adaptive: false,
        maxPromptChars: 7000,
        skillCharBudget: 2400,
      },
    },
    {
      nodeKey: "image_generate",
      sequence: 5,
      name: "Image Generation",
      nodeType: "model",
      modelRole: "image_generator",
      promptKey: "image-generation-system",
      timeoutMs: 180000,
      maxRetries: 2,
    },
    {
      nodeKey: "quality_review",
      sequence: 6,
      name: "Quality Review",
      nodeType: "model",
      modelRole: "quality_reviewer",
      promptKey: "quality-review",
      timeoutMs: 120000,
      maxRetries: 1,
    },
    {
      nodeKey: "rule_engine",
      sequence: 7,
      name: "Rule Engine",
      nodeType: "deterministic",
      settings: { source: "budget_rules" },
    },
    {
      nodeKey: "second_review",
      sequence: 8,
      name: "Second Review (uncertain)",
      nodeType: "model_conditional",
      modelRole: "second_reviewer",
      promptKey: "second-review",
      timeoutMs: 120000,
      settings: { enabled: true, onlyWhen: "uncertain" },
    },
    {
      nodeKey: "retry",
      sequence: 9,
      name: "Repair & Retry",
      nodeType: "deterministic",
      promptKey: "repair",
      settings: { attemptDelayMs: 0 },
    },
    {
      nodeKey: "finalize",
      sequence: 10,
      name: "Finalize",
      nodeType: "deterministic",
      settings: { previewMaxWidth: 1600, jpgQuality: 90 },
    },
  ];

  for (const n of nodeSeeds) {
    const existing = await db
      .select()
      .from(workflowNodes)
      .where(eq(workflowNodes.nodeKey, n.nodeKey))
      .limit(10);
    const match = existing.find(
      (row: any) => row.workflowVersionId === workflowVersionRow.id,
    );
    let nodeRow: any;
    if (match) {
      nodeRow = match;
    } else {
      nodeRow = (
        await db.insert(workflowNodes).values({
          workflowVersionId: workflowVersionRow.id,
          nodeKey: n.nodeKey,
          sequence: n.sequence,
          name: n.name,
          nodeType: n.nodeType,
        }).returning()
      )[0];
    }
    const existingConfig = await db
      .select()
      .from(workflowNodeConfigs)
      .where(eq(workflowNodeConfigs.nodeId, nodeRow.id))
      .limit(1);
    if (existingConfig.length === 0) {
      await db.insert(workflowNodeConfigs).values({
        nodeId: nodeRow.id,
        modelId: n.modelRole ? modelByRole[n.modelRole]?.id ?? null : null,
        promptVersionId: n.promptKey
          ? promptVersionByKey[n.promptKey]?.id ?? null
          : null,
        timeoutMs: n.timeoutMs ?? 60000,
        maxRetries: n.maxRetries ?? 1,
        thresholds: n.thresholds ?? {},
        settings: n.settings ?? {},
      });
    } else {
      await db
        .update(workflowNodeConfigs)
        .set({
          modelId: n.modelRole ? modelByRole[n.modelRole]?.id ?? null : null,
          promptVersionId: n.promptKey ? promptVersionByKey[n.promptKey]?.id ?? null : null,
          timeoutMs: n.timeoutMs ?? existingConfig[0].timeoutMs,
          maxRetries: n.maxRetries ?? existingConfig[0].maxRetries,
          thresholds: n.thresholds ?? existingConfig[0].thresholds,
          settings: n.settings ?? existingConfig[0].settings,
          updatedAt: new Date(),
        })
        .where(eq(workflowNodeConfigs.id, existingConfig[0].id));
    }
  }

  await backfillDeterministicCostEvents(db);

  console.log("✓ seed complete");
  console.log(`  admin:    ${adminEmail} / (SEED_ADMIN_PASSWORD)`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
