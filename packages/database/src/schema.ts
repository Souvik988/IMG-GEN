import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ */
/* Enums                                                               */
/* ------------------------------------------------------------------ */

export const userRoleEnum = pgEnum("user_role", ["customer", "admin"]);
export const versionStatusEnum = pgEnum("version_status", [
  "draft",
  "test",
  "production",
  "archived",
]);
export const workflowVersionStatusEnum = pgEnum("workflow_version_status", [
  "draft",
  "production",
  "archived",
]);
export const modelProviderEnum = pgEnum("model_provider", [
  "openrouter",
  // Retained for historical rows; active production seed uses OpenRouter only.
  "gemini",
  "mock",
]);
export const modelRoleEnum = pgEnum("model_role", [
  "vision_analyzer",
  "prompt_compiler",
  "image_generator",
  "quality_reviewer",
  "second_reviewer",
]);
export const assetKindEnum = pgEnum("asset_kind", [
  "garment_reference",
  "detail_reference",
  "character_reference",
  "generated_candidate",
  "preview",
  "master",
  "jpg_variant",
]);
export const assetValidationStatusEnum = pgEnum("asset_validation_status", [
  "pending",
  "usable",
  "rejected",
]);
export const inputRoleEnum = pgEnum("input_role", [
  "main_garment",
  "detail",
  "character",
]);
export const jobStateEnum = pgEnum("job_state", [
  "created",
  "validating",
  "analyzing",
  "compiling",
  "generating",
  "reviewing",
  "retrying",
  "finalizing",
  "ready",
  "input_rejected",
  "failed",
  "budget_stopped",
  "manual_review",
  "cancelled",
]);
export const attemptStatusEnum = pgEnum("attempt_status", [
  "running",
  "passed",
  "failed",
  "skipped",
]);
export const stepStatusEnum = pgEnum("step_status", [
  "running",
  "succeeded",
  "failed",
  "skipped",
]);
export const defectSeverityEnum = pgEnum("defect_severity", [
  "critical",
  "major",
  "minor",
]);
export const reviewTypeEnum = pgEnum("review_type", ["primary", "second"]);
export const resolutionEnum = pgEnum("resolution", ["1k", "2k", "4k"]);
export const feedbackRatingEnum = pgEnum("feedback_rating", [
  "good",
  "needs_improvement",
]);

/* ------------------------------------------------------------------ */
/* Core identity                                                       */
/* ------------------------------------------------------------------ */

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  role: userRoleEnum("role").notNull().default("customer"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const userSessions = pgTable(
  "user_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("user_sessions_user_idx").on(t.userId)],
);

/* ------------------------------------------------------------------ */
/* Assets                                                              */
/* ------------------------------------------------------------------ */

/** Binary files live in object storage; this is the metadata record.
 *  Uploaded originals are immutable: only validation status/report may change. */
export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    kind: assetKindEnum("kind").notNull(),
    bucket: text("bucket").notNull(),
    objectKey: text("object_key").notNull(),
    originalFilename: text("original_filename"),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    width: integer("width"),
    height: integer("height"),
    checksum: text("checksum"),
    validationStatus: assetValidationStatusEnum("validation_status")
      .notNull()
      .default("pending"),
    validationReport: jsonb("validation_report").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("assets_user_idx").on(t.userId),
    uniqueIndex("assets_bucket_key_idx").on(t.bucket, t.objectKey),
  ],
);

export const characters = pgTable("characters", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  /** { gender, ageAppearance, height, build, skinTone, notes } */
  attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
  previewAssetId: uuid("preview_asset_id").references(() => assets.id, {
    onDelete: "set null",
  }),
  isPreset: boolean("is_preset").notNull().default(false),
  ownerId: uuid("owner_id").references(() => users.id, { onDelete: "cascade" }),
  isEnabled: boolean("is_enabled").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const environmentPresets = pgTable("environment_presets", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  /** outdoor | indoor | studio | festive | cinematic | minimal */
  category: text("category").notNull(),
  promptFragment: text("prompt_fragment").notNull(),
  previewAssetId: uuid("preview_asset_id").references(() => assets.id, {
    onDelete: "set null",
  }),
  isEnabled: boolean("is_enabled").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/* ------------------------------------------------------------------ */
/* AI configuration: models, prompts, skills                           */
/* ------------------------------------------------------------------ */

export const modelRegistry = pgTable(
  "model_registry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    provider: modelProviderEnum("provider").notNull(),
    modelId: text("model_id").notNull(),
    role: modelRoleEnum("role").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
    /** { maxImageRefs, resolutions: ["1k","2k","4k"], supportsMultiOutput } */
    capabilities: jsonb("capabilities")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    notes: text("notes"),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("model_registry_unique").on(t.provider, t.modelId, t.role),
    index("model_registry_role_idx").on(t.role),
  ],
);

export const modelPriceVersions = pgTable(
  "model_price_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    modelId: uuid("model_id")
      .notNull()
      .references(() => modelRegistry.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    /** USD per 1M input/output tokens; null when not a token-priced model */
    inputPricePerM: numeric("input_price_per_m", { precision: 12, scale: 6 }),
    outputPricePerM: numeric("output_price_per_m", { precision: 12, scale: 6 }),
    /** { "1k": 0.03, "2k": 0.101, "4k": 0.151 } USD per generated image */
    imagePrices: jsonb("image_prices").$type<Record<string, number>>(),
    currency: text("currency").notNull().default("USD"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("model_price_versions_unique").on(t.modelId, t.version),
    index("model_price_versions_model_idx").on(t.modelId),
  ],
);

export const prompts = pgTable("prompts", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  /** input_quality | garment_vision | prompt_compiler | image_generation | quality_review | repair | second_review */
  category: text("category").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    promptId: uuid("prompt_id")
      .notNull()
      .references(() => prompts.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    status: versionStatusEnum("status").notNull().default("draft"),
    body: text("body").notNull(),
    /** variable names referenced by this prompt body */
    variables: jsonb("variables").$type<string[]>().notNull().default([]),
    notes: text("notes"),
    createdById: uuid("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("prompt_versions_unique").on(t.promptId, t.version),
    uniqueIndex("prompt_versions_one_production")
      .on(t.promptId)
      .where(sql`status = 'production'`),
  ],
);

export const skills = pgTable("skills", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  purpose: text("purpose"),
  isEnabled: boolean("is_enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const skillVersions = pgTable(
  "skill_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    status: versionStatusEnum("status").notNull().default("draft"),
    instruction: text("instruction").notNull(),
    priority: integer("priority").notNull().default(50),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("skill_versions_unique").on(t.skillId, t.version),
    uniqueIndex("skill_versions_one_production")
      .on(t.skillId)
      .where(sql`status = 'production'`),
  ],
);

export const skillRules = pgTable(
  "skill_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    description: text("description"),
    /** Deterministic condition list, all must match (AND):
     *  [{ field: "garmentType", op: "equals", value: "saree" }, ...] */
    conditions: jsonb("conditions")
      .$type<Array<{ field: string; op: string; value: unknown }>>()
      .notNull()
      .default([]),
    isEnabled: boolean("is_enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("skill_rules_skill_idx").on(t.skillId)],
);

/* ------------------------------------------------------------------ */
/* Workflow                                                            */
/* ------------------------------------------------------------------ */

export const workflows = pgTable("workflows", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const workflowVersions = pgTable(
  "workflow_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    status: workflowVersionStatusEnum("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("workflow_versions_unique").on(t.workflowId, t.version)],
);

export const workflowNodes = pgTable(
  "workflow_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowVersionId: uuid("workflow_version_id")
      .notNull()
      .references(() => workflowVersions.id, { onDelete: "cascade" }),
    /** input_check | vision | skill_select | prompt_compile | image_generate |
     *  quality_review | rule_engine | second_review | retry | finalize */
    nodeKey: text("node_key").notNull(),
    sequence: integer("sequence").notNull(),
    name: text("name").notNull(),
    nodeType: text("node_type").notNull().default("standard"),
    isEnabled: boolean("is_enabled").notNull().default(true),
  },
  (t) => [
    uniqueIndex("workflow_nodes_unique").on(t.workflowVersionId, t.nodeKey),
    index("workflow_nodes_version_idx").on(t.workflowVersionId),
  ],
);

export const workflowNodeConfigs = pgTable(
  "workflow_node_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => workflowNodes.id, { onDelete: "cascade" })
      .unique(),
    modelId: uuid("model_id").references(() => modelRegistry.id, {
      onDelete: "set null",
    }),
    promptVersionId: uuid("prompt_version_id").references(
      () => promptVersions.id,
      { onDelete: "set null" },
    ),
    timeoutMs: integer("timeout_ms").notNull().default(60000),
    maxRetries: integer("max_retries").notNull().default(1),
    /** node-specific thresholds, e.g. { minScore: 70 } for AI input check */
    thresholds: jsonb("thresholds").$type<Record<string, unknown>>().notNull().default({}),
    /** node-specific settings, e.g. { maxSkills: 6, adaptiveCompile: false } */
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("workflow_node_configs_node_idx").on(t.nodeId)],
);

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workflowVersionId: uuid("workflow_version_id")
      .notNull()
      .references(() => workflowVersions.id),
    state: jobStateEnum("state").notNull().default("created"),
    requestedResolution: resolutionEnum("requested_resolution")
      .notNull()
      .default("2k"),
    aspectRatio: text("aspect_ratio").notNull().default("portrait"),
    outputCount: integer("output_count").notNull().default(1),
    /** Client-supplied key that makes a generate request safe to retry. */
    idempotencyKey: text("idempotency_key"),
    /** Hash of the normalized request; key reuse with another payload is rejected. */
    idempotencyFingerprint: text("idempotency_fingerprint"),
    characterId: uuid("character_id").references(() => characters.id, {
      onDelete: "set null",
    }),
    characterAssetId: uuid("character_asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    environmentPresetId: uuid("environment_preset_id").references(
      () => environmentPresets.id,
      { onDelete: "set null" },
    ),
    /** customer selections snapshot: { ageAppearance, heightAppearance, pose, inputType, genderPresentation } */
    selections: jsonb("selections")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Garment Truth Sheet — analyzed once, reused across attempts */
    truthSheet: jsonb("truth_sheet"),
    truthSheetPromptVersionId: uuid("truth_sheet_prompt_version_id").references(
      () => promptVersions.id,
      { onDelete: "set null" },
    ),
    truthSheetModelId: uuid("truth_sheet_model_id").references(
      () => modelRegistry.id,
      { onDelete: "set null" },
    ),
    finalDecision: text("final_decision"),
    error: text("error"),
    totalCostUsd: numeric("total_cost_usd", { precision: 14, scale: 8 })
      .notNull()
      .default("0"),
    totalCostInr: numeric("total_cost_inr", { precision: 14, scale: 4 })
      .notNull()
      .default("0"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("jobs_user_created_idx").on(t.userId, t.createdAt),
    index("jobs_state_idx").on(t.state),
    uniqueIndex("jobs_user_idempotency_unique").on(t.userId, t.idempotencyKey),
  ],
);

export const jobInputs = pgTable(
  "job_inputs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "restrict" }),
    role: inputRoleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("job_inputs_job_idx").on(t.jobId)],
);

export const jobStateEvents = pgTable(
  "job_state_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    fromState: jobStateEnum("from_state"),
    toState: jobStateEnum("to_state").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("job_state_events_job_idx").on(t.jobId)],
);

export const jobAttempts = pgTable(
  "job_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    status: attemptStatusEnum("status").notNull().default("running"),
    promptVersionId: uuid("prompt_version_id").references(
      () => promptVersions.id,
      { onDelete: "set null" },
    ),
    compiledPrompt: text("compiled_prompt"),
    /** ordered selected skill_version ids */
    selectedSkillVersionIds: jsonb("selected_skill_version_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    /** targeted repair instruction for retry attempts (Layer D) */
    repairInstruction: text("repair_instruction"),
    decision: text("decision"),
    decisionReasons: jsonb("decision_reasons").$type<string[]>().default([]),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("job_attempts_unique").on(t.jobId, t.attemptNumber),
    index("job_attempts_job_idx").on(t.jobId),
  ],
);

export const jobStepRuns = pgTable(
  "job_step_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    attemptId: uuid("attempt_id").references(() => jobAttempts.id, {
      onDelete: "cascade",
    }),
    nodeKey: text("node_key").notNull(),
    status: stepStatusEnum("status").notNull().default("running"),
    modelId: uuid("model_id").references(() => modelRegistry.id, {
      onDelete: "set null",
    }),
    promptVersionId: uuid("prompt_version_id").references(
      () => promptVersions.id,
      { onDelete: "set null" },
    ),
    inputRef: jsonb("input_ref"),
    outputRef: jsonb("output_ref"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
  },
  (t) => [
    index("job_step_runs_job_idx").on(t.jobId),
    index("job_step_runs_attempt_idx").on(t.attemptId),
  ],
);

export const generationCandidates = pgTable(
  "generation_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => jobAttempts.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull().default(1),
    isFinal: boolean("is_final").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("generation_candidates_job_idx").on(t.jobId)],
);

export const qualityReviews = pgTable(
  "quality_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => generationCandidates.id, { onDelete: "cascade" }),
    reviewType: reviewTypeEnum("review_type").notNull().default("primary"),
    reviewerModelId: uuid("reviewer_model_id").references(
      () => modelRegistry.id,
      { onDelete: "set null" },
    ),
    promptVersionId: uuid("prompt_version_id").references(
      () => promptVersions.id,
      { onDelete: "set null" },
    ),
    /** full strict-schema QualityReview JSON */
    review: jsonb("review").$type<Record<string, unknown>>().notNull(),
    repairInstruction: text("repair_instruction"),
    /** extracted scores for dashboards (0-100) */
    garmentFidelityScore: integer("garment_fidelity_score"),
    characterIdentityScore: integer("character_identity_score"),
    photorealismScore: integer("photorealism_score"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("quality_reviews_candidate_idx").on(t.candidateId)],
);

export const defects = pgTable(
  "defects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    qualityReviewId: uuid("quality_review_id")
      .notNull()
      .references(() => qualityReviews.id, { onDelete: "cascade" }),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => generationCandidates.id, { onDelete: "cascade" }),
    severity: defectSeverityEnum("severity").notNull(),
    code: text("code").notNull(),
    description: text("description").notNull(),
    repairHint: text("repair_hint"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("defects_review_idx").on(t.qualityReviewId),
    index("defects_candidate_idx").on(t.candidateId),
  ],
);

export const jobOutputs = pgTable(
  "job_outputs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" })
      .unique(),
    masterAssetId: uuid("master_asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "restrict" }),
    previewAssetId: uuid("preview_asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    jpgAssetId: uuid("jpg_asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("job_outputs_job_idx").on(t.jobId)],
);

/* ------------------------------------------------------------------ */
/* Cost & budget                                                       */
/* ------------------------------------------------------------------ */

export const costEvents = pgTable(
  "cost_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "cascade" }),
    attemptId: uuid("attempt_id").references(() => jobAttempts.id, {
      onDelete: "set null",
    }),
    stepRunId: uuid("step_run_id").references(() => jobStepRuns.id, {
      onDelete: "set null",
    }),
    nodeKey: text("node_key").notNull(),
    provider: text("provider").notNull(),
    modelId: uuid("model_id").references(() => modelRegistry.id, {
      onDelete: "set null",
    }),
    modelPriceVersionId: uuid("model_price_version_id").references(
      () => modelPriceVersions.id,
      { onDelete: "set null" },
    ),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    imageCount: integer("image_count").notNull().default(0),
    resolution: text("resolution"),
    providerReportedCostUsd: numeric("provider_reported_cost_usd", {
      precision: 14,
      scale: 8,
    }),
    usdCost: numeric("usd_cost", { precision: 14, scale: 8 })
      .notNull()
      .default("0"),
    fxRate: numeric("fx_rate", { precision: 10, scale: 4 })
      .notNull()
      .default("1"),
    inrCost: numeric("inr_cost", { precision: 14, scale: 4 })
      .notNull()
      .default("0"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("cost_events_job_idx").on(t.jobId),
    index("cost_events_created_idx").on(t.createdAt),
    index("cost_events_model_idx").on(t.modelId),
  ],
);

export const budgetRules = pgTable("budget_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  singletonKey: text("singleton_key").notNull().unique().default("global"),
  warnInr: numeric("warn_inr", { precision: 12, scale: 4 })
    .notNull()
    .default("15"),
  hardStopInr: numeric("hard_stop_inr", { precision: 12, scale: 4 })
    .notNull()
    .default("20"),
  maxAttempts: integer("max_attempts").notNull().default(3),
  planningBudget1kInr: numeric("planning_budget_1k_inr", {
    precision: 12,
    scale: 4,
  })
    .notNull()
    .default("8"),
  planningBudget2kInr: numeric("planning_budget_2k_inr", {
    precision: 12,
    scale: 4,
  })
    .notNull()
    .default("20"),
  planningBudget4kInr: numeric("planning_budget_4k_inr", {
    precision: 12,
    scale: 4,
  })
    .notNull()
    .default("30"),
  usdInrRate: numeric("usd_inr_rate", { precision: 10, scale: 4 })
    .notNull()
    .default("95.78"),
  perUserDailyJobLimit: integer("per_user_daily_job_limit")
    .notNull()
    .default(20),
  /** quality thresholds mirrored for the rule engine */
  minGarmentFidelity: integer("min_garment_fidelity").notNull().default(94),
  minCharacterIdentity: integer("min_character_identity").notNull().default(90),
  minPhotorealism: integer("min_photorealism").notNull().default(92),
  minAnatomy: integer("min_anatomy").notNull().default(90),
  minTechnicalQuality: integer("min_technical_quality").notNull().default(88),
  uncertaintyBand: integer("uncertainty_band").notNull().default(3),
  minReviewerConfidence: integer("min_reviewer_confidence").notNull().default(70),
  isSecondReviewEnabled: boolean("is_second_review_enabled")
    .notNull()
    .default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/* ------------------------------------------------------------------ */
/* Improvement & evaluation                                            */
/* ------------------------------------------------------------------ */

export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" })
      .unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rating: feedbackRatingEnum("rating").notNull(),
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("feedback_user_idx").on(t.userId)],
);

export const benchmarkCases = pgTable("benchmark_cases", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  category: text("category").notNull(),
  name: text("name").notNull(),
  referenceAssetKeys: jsonb("reference_asset_keys").$type<string[]>()
    .notNull()
    .default([]),
  expectedProtectedDetails: jsonb("expected_protected_details").$type<string[]>()
    .notNull()
    .default([]),
  humanPass: boolean("human_pass"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const benchmarkRuns = pgTable(
  "benchmark_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => benchmarkCases.id, { onDelete: "cascade" }),
    workflowVersionId: uuid("workflow_version_id").references(
      () => workflowVersions.id,
    ),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    passed: boolean("passed"),
    scores: jsonb("scores").$type<Record<string, unknown>>(),
    costInr: numeric("cost_inr", { precision: 14, scale: 4 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("benchmark_runs_case_idx").on(t.caseId)],
);

export const adminAuditEvents = pgTable(
  "admin_audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("admin_audit_entity_idx").on(t.entityType, t.entityId),
    index("admin_audit_created_idx").on(t.createdAt),
  ],
);

/* ------------------------------------------------------------------ */
/* Inferred types                                                      */
/* ------------------------------------------------------------------ */

export type User = typeof users.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type Character = typeof characters.$inferSelect;
export type EnvironmentPreset = typeof environmentPresets.$inferSelect;
export type ModelRegistry = typeof modelRegistry.$inferSelect;
export type ModelPriceVersion = typeof modelPriceVersions.$inferSelect;
export type Prompt = typeof prompts.$inferSelect;
export type PromptVersion = typeof promptVersions.$inferSelect;
export type Skill = typeof skills.$inferSelect;
export type SkillVersion = typeof skillVersions.$inferSelect;
export type SkillRule = typeof skillRules.$inferSelect;
export type Workflow = typeof workflows.$inferSelect;
export type WorkflowVersion = typeof workflowVersions.$inferSelect;
export type WorkflowNode = typeof workflowNodes.$inferSelect;
export type WorkflowNodeConfig = typeof workflowNodeConfigs.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type JobInput = typeof jobInputs.$inferSelect;
export type JobAttempt = typeof jobAttempts.$inferSelect;
export type JobStepRun = typeof jobStepRuns.$inferSelect;
export type GenerationCandidate = typeof generationCandidates.$inferSelect;
export type QualityReviewRow = typeof qualityReviews.$inferSelect;
export type Defect = typeof defects.$inferSelect;
export type JobOutput = typeof jobOutputs.$inferSelect;
export type CostEvent = typeof costEvents.$inferSelect;
export type BudgetRules = typeof budgetRules.$inferSelect;
export type Feedback = typeof feedback.$inferSelect;
export type AdminAuditEvent = typeof adminAuditEvents.$inferSelect;
export type JobState = (typeof jobStateEnum.enumValues)[number];
export type ModelRole = (typeof modelRoleEnum.enumValues)[number];
export type ModelProvider = (typeof modelProviderEnum.enumValues)[number];
export type Resolution = (typeof resolutionEnum.enumValues)[number];
export type VersionStatus = (typeof versionStatusEnum.enumValues)[number];
export type AttemptStatus = (typeof attemptStatusEnum.enumValues)[number];
export type AssetKind = (typeof assetKindEnum.enumValues)[number];
export type AssetValidationStatus = (typeof assetValidationStatusEnum.enumValues)[number];
