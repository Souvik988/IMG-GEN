import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import {
  budgetRules,
  modelPriceVersions,
  modelRegistry,
  promptVersions,
  prompts,
  skillRules,
  skillVersions,
  skills,
  workflowNodeConfigs,
  workflowNodes,
  workflowVersions,
  workflows,
} from "@shotlin/database";
import { getAppConfig } from "@shotlin/platform";
import { z } from "zod";
import { AdminGuard, parseWith } from "../common";
import type { AuthedRequest } from "../types";
import { DB, type ApiDb } from "../infrastructure";
import { AdminService } from "./admin.service";

/* ------------------------------------------------------------------ */
/* Workflow                                                            */
/* ------------------------------------------------------------------ */

@Controller("/admin/workflow")
@UseGuards(AdminGuard)
class WorkflowController {
  constructor(
    @Inject(DB) private db: ApiDb,
    private admin: AdminService,
  ) {}

  @Get()
  async get() {
    const wf = (
      await this.db.select().from(workflows).where(eq(workflows.key, "default")).limit(1)
    )[0];
    const versions = await this.db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, wf.id))
      .orderBy(desc(workflowVersions.version));
    const production = versions.find((v) => v.status === "production") ?? versions[0];

    const nodes = await this.db
      .select({
        node: workflowNodes,
        config: workflowNodeConfigs,
      })
      .from(workflowNodes)
      .leftJoin(workflowNodeConfigs, eq(workflowNodeConfigs.nodeId, workflowNodes.id))
      .where(eq(workflowNodes.workflowVersionId, production.id))
      .orderBy(asc(workflowNodes.sequence));

    return { workflow: wf, versions, activeVersion: production, nodes };
  }

  @Put("/order")
  async reorder(@Req() req: AuthedRequest, @Body() body: unknown) {
    const input = parseWith(
      z.object({ nodeKeys: z.array(z.string().min(1)).min(1) }),
      body,
    );
    const workflow = (
      await this.db.select().from(workflows).where(eq(workflows.key, "default")).limit(1)
    )[0];
    if (!workflow) throw new NotFoundException("Workflow not found");
    const versions = await this.db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, workflow.id))
      .orderBy(desc(workflowVersions.version));
    const production = versions.find((version) => version.status === "production") ?? versions[0];
    if (!production) throw new NotFoundException("Production workflow version not found");

    const productionNodes = await this.db
      .select()
      .from(workflowNodes)
      .where(eq(workflowNodes.workflowVersionId, production.id));
    const expected = new Set(productionNodes.map((node) => node.nodeKey));
    const requested = new Set(input.nodeKeys);
    if (
      requested.size !== expected.size ||
      requested.size !== input.nodeKeys.length ||
      input.nodeKeys.some((nodeKey) => !expected.has(nodeKey))
    ) {
      throw new BadRequestException("Order must include every production node exactly once");
    }

    const position = new Map(input.nodeKeys.map((nodeKey, index) => [nodeKey, index]));
    const dependencies: Record<string, string[]> = {
      vision: ["input_check"],
      skill_select: ["vision"],
      prompt_compile: ["skill_select"],
      image_generate: ["prompt_compile"],
      quality_review: ["image_generate"],
      rule_engine: ["quality_review"],
      second_review: ["rule_engine"],
      retry: ["rule_engine", "second_review"],
      finalize: ["rule_engine", "second_review"],
    };
    for (const [nodeKey, requiredBefore] of Object.entries(dependencies)) {
      for (const dependency of requiredBefore) {
        if ((position.get(dependency) ?? -1) > (position.get(nodeKey) ?? -1)) {
          throw new BadRequestException(`${nodeKey} must run after ${dependency}`);
        }
      }
    }

    await this.db.transaction(async (tx) => {
      for (const [index, nodeKey] of input.nodeKeys.entries()) {
        const node = productionNodes.find((candidate) => candidate.nodeKey === nodeKey);
        if (node) {
          await tx
            .update(workflowNodes)
            .set({ sequence: index + 1 })
            .where(eq(workflowNodes.id, node.id));
        }
      }
    });
    await this.admin.audit(req.user!.id, "workflow_order.update", "workflow_version", production.id, input);
    return { ok: true, nodeKeys: input.nodeKeys };
  }

  @Put("/:nodeKey")
  async updateNode(@Req() req: AuthedRequest, @Param("nodeKey") nodeKey: string, @Body() body: unknown) {
    const schema = z.object({
      isEnabled: z.boolean().optional(),
      modelId: z.string().uuid().nullable().optional(),
      promptVersionId: z.string().uuid().nullable().optional(),
      timeoutMs: z.number().int().min(1000).max(600000).optional(),
      maxRetries: z.number().int().min(0).max(5).optional(),
      thresholds: z.record(z.unknown()).optional(),
      settings: z.record(z.unknown()).optional(),
    });
    const input = parseWith(schema, body);

    const nodeRow = (
      await this.db.select().from(workflowNodes).where(eq(workflowNodes.nodeKey, nodeKey)).limit(1)
    )[0];
    if (!nodeRow) throw new NotFoundException("Node not found");

    if (input.isEnabled !== undefined) {
      await this.db
        .update(workflowNodes)
        .set({ isEnabled: input.isEnabled })
        .where(eq(workflowNodes.id, nodeRow.id));
    }

    const configPatch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.modelId !== undefined) configPatch.modelId = input.modelId;
    if (input.promptVersionId !== undefined) configPatch.promptVersionId = input.promptVersionId;
    if (input.timeoutMs !== undefined) configPatch.timeoutMs = input.timeoutMs;
    if (input.maxRetries !== undefined) configPatch.maxRetries = input.maxRetries;
    if (input.thresholds !== undefined) configPatch.thresholds = input.thresholds;
    if (input.settings !== undefined) configPatch.settings = input.settings;

    const existing = (
      await this.db
        .select()
        .from(workflowNodeConfigs)
        .where(eq(workflowNodeConfigs.nodeId, nodeRow.id))
        .limit(1)
    )[0];

    if (existing) {
      await this.db
        .update(workflowNodeConfigs)
        .set(configPatch)
        .where(eq(workflowNodeConfigs.id, existing.id));
    } else {
      await this.db.insert(workflowNodeConfigs).values({
        nodeId: nodeRow.id,
        ...configPatch,
      });
    }

    await this.admin.audit(req.user!.id, "workflow_node.update", "workflow_node", nodeRow.id, input);
    return { ok: true };
  }
}

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

const priceSchema = z.object({
  inputPricePerM: z.number().nonnegative().nullable().optional(),
  outputPricePerM: z.number().nonnegative().nullable().optional(),
  imagePrices: z.record(z.number().nonnegative()).nullable().optional(),
});

@Controller("/admin/models")
@UseGuards(AdminGuard)
class ModelsController {
  constructor(
    @Inject(DB) private db: ApiDb,
    private admin: AdminService,
  ) {}

  @Get()
  async list() {
    const models = await this.db.select().from(modelRegistry).orderBy(modelRegistry.role);
    const prices = await this.db
      .select()
      .from(modelPriceVersions)
      .where(eq(modelPriceVersions.isActive, true));
    const priceByModel = new Map(prices.map((p) => [p.modelId, p]));
    return {
      models: models.map((m) => ({ ...m, activePrice: priceByModel.get(m.id) ?? null })),
    };
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: unknown) {
    const schema = z.object({
      name: z.string().min(1).max(120),
      provider: z.enum(["openrouter", "mock"]),
      modelId: z.string().min(1).max(200),
      role: z.enum([
        "vision_analyzer",
        "prompt_compiler",
        "image_generator",
        "quality_reviewer",
        "second_reviewer",
      ]),
      isEnabled: z.boolean().default(true),
      capabilities: z.record(z.unknown()).default({}),
      notes: z.string().max(2000).nullable().optional(),
      prices: priceSchema.optional(),
    });
    const input = parseWith(schema, body);

    const [model] = await this.db
      .insert(modelRegistry)
      .values({
        name: input.name,
        provider: input.provider,
        modelId: input.modelId,
        role: input.role,
        isEnabled: input.isEnabled,
        capabilities: input.capabilities,
        notes: input.notes ?? null,
      })
      .returning();

    if (input.prices) {
      await this.insertPriceVersion(model.id, input.prices);
    }

    await this.admin.audit(req.user!.id, "model.create", "model", model.id, input);
    return { model };
  }

  @Put("/:id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    const schema = z.object({
      name: z.string().min(1).max(120).optional(),
      provider: z.enum(["openrouter", "mock"]).optional(),
      modelId: z.string().min(1).max(200).optional(),
      role: z.enum([
        "vision_analyzer",
        "prompt_compiler",
        "image_generator",
        "quality_reviewer",
        "second_reviewer",
      ]).optional(),
      isEnabled: z.boolean().optional(),
      capabilities: z.record(z.unknown()).optional(),
      notes: z.string().max(2000).nullable().optional(),
      /** When provided, creates a NEW price version and deactivates the old one. */
      newPrices: priceSchema.optional(),
    });
    const input = parseWith(schema, body);

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const key of ["name", "provider", "modelId", "role", "isEnabled", "capabilities", "notes"] as const) {
      if (input[key] !== undefined) patch[key] = input[key];
    }
    const [model] = await this.db
      .update(modelRegistry)
      .set(patch)
      .where(eq(modelRegistry.id, id))
      .returning();
    if (!model) throw new NotFoundException("Model not found");

    if (input.newPrices) {
      await this.db
        .update(modelPriceVersions)
        .set({ isActive: false })
        .where(eq(modelPriceVersions.modelId, id));
      await this.insertPriceVersion(id, input.newPrices);
    }

    await this.admin.audit(req.user!.id, "model.update", "model", id, input);
    return { model };
  }

  private async insertPriceVersion(modelId: string, prices: z.infer<typeof priceSchema>) {
    const existing = await this.db
      .select({ version: modelPriceVersions.version })
      .from(modelPriceVersions)
      .where(eq(modelPriceVersions.modelId, modelId));
    const nextVersion = existing.reduce((m, p) => Math.max(m, p.version), 0) + 1;
    await this.db.insert(modelPriceVersions).values({
      modelId,
      version: nextVersion,
      inputPricePerM:
        prices.inputPricePerM !== undefined && prices.inputPricePerM !== null
          ? String(prices.inputPricePerM)
          : null,
      outputPricePerM:
        prices.outputPricePerM !== undefined && prices.outputPricePerM !== null
          ? String(prices.outputPricePerM)
          : null,
      imagePrices: prices.imagePrices !== undefined ? prices.imagePrices : null,
      isActive: true,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Prompts                                                             */
/* ------------------------------------------------------------------ */

@Controller("/admin/prompts")
@UseGuards(AdminGuard)
class PromptsController {
  constructor(
    @Inject(DB) private db: ApiDb,
    private admin: AdminService,
  ) {}

  @Get()
  async list() {
    const allPrompts = await this.db.select().from(prompts).orderBy(prompts.category);
    const allVersions = await this.db
      .select()
      .from(promptVersions)
      .orderBy(desc(promptVersions.version));
    return {
      prompts: allPrompts.map((p) => ({
        ...p,
        versions: allVersions.filter((v) => v.promptId === p.id),
      })),
    };
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: unknown) {
    const schema = z.object({
      key: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
      name: z.string().min(1).max(120),
      category: z.enum([
        "input_quality",
        "garment_vision",
        "prompt_compiler",
        "image_generation",
        "quality_review",
        "repair",
        "second_review",
      ]),
      description: z.string().max(500).optional(),
      body: z.string().min(1),
      variables: z.array(z.string()).default([]),
    });
    const input = parseWith(schema, body);

    const existing = await this.db
      .select({ id: prompts.id })
      .from(prompts)
      .where(eq(prompts.key, input.key))
      .limit(1);
    if (existing.length > 0) throw new BadRequestException("Prompt key already exists");

    const [prompt] = await this.db
      .insert(prompts)
      .values({
        key: input.key,
        name: input.name,
        category: input.category,
        description: input.description ?? null,
      })
      .returning();

    const [version] = await this.db
      .insert(promptVersions)
      .values({
        promptId: prompt.id,
        version: 1,
        status: "draft",
        body: input.body,
        variables: input.variables,
        createdById: req.user!.id,
      })
      .returning();

    await this.admin.audit(req.user!.id, "prompt.create", "prompt", prompt.id, { key: input.key });
    return { prompt, version };
  }

  @Post("/:id/versions")
  async newVersion(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    const schema = z.object({
      body: z.string().min(1),
      variables: z.array(z.string()).default([]),
      notes: z.string().max(1000).optional(),
    });
    const input = parseWith(schema, body);

    const versions = await this.db
      .select({ version: promptVersions.version })
      .from(promptVersions)
      .where(eq(promptVersions.promptId, id));
    if (versions.length === 0) throw new NotFoundException("Prompt not found");
    const nextVersion = versions.reduce((m, v) => Math.max(m, v.version), 0) + 1;

    const [version] = await this.db
      .insert(promptVersions)
      .values({
        promptId: id,
        version: nextVersion,
        status: "draft",
        body: input.body,
        variables: input.variables,
        notes: input.notes ?? null,
        createdById: req.user!.id,
      })
      .returning();

    await this.admin.audit(req.user!.id, "prompt.new_version", "prompt", id, { version: nextVersion });
    return { version };
  }

  @Post("/:id/publish")
  async publish(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    const schema = z.object({ versionId: z.string().uuid().optional() });
    const input = parseWith(schema, body);

    let target = input.versionId
      ? (
          await this.db
            .select()
            .from(promptVersions)
            .where(and(eq(promptVersions.id, input.versionId), eq(promptVersions.promptId, id)))
            .limit(1)
        )[0]
      : (
          await this.db
            .select()
            .from(promptVersions)
            .where(eq(promptVersions.promptId, id))
            .orderBy(desc(promptVersions.version))
            .limit(1)
        )[0];

    if (!target) throw new NotFoundException("Version not found");
    if (target.status === "production") throw new BadRequestException("Version is already production");

    // Archive current production (partial unique index allows only one).
    await this.db
      .update(promptVersions)
      .set({ status: "archived" })
      .where(and(eq(promptVersions.promptId, id), eq(promptVersions.status, "production")));

    const [published] = await this.db
      .update(promptVersions)
      .set({ status: "production", publishedAt: new Date() })
      .where(eq(promptVersions.id, target.id))
      .returning();

    await this.admin.audit(req.user!.id, "prompt.publish", "prompt", id, {
      version: published.version,
    });
    return { version: published };
  }

  @Post("/:id/rollback")
  async rollback(@Req() req: AuthedRequest, @Param("id") id: string) {
    const archived = await this.db
      .select()
      .from(promptVersions)
      .where(and(eq(promptVersions.promptId, id), eq(promptVersions.status, "archived")))
      .orderBy(desc(promptVersions.publishedAt))
      .limit(1);
    if (archived.length === 0) throw new BadRequestException("No archived version to roll back to");

    await this.db
      .update(promptVersions)
      .set({ status: "archived" })
      .where(and(eq(promptVersions.promptId, id), eq(promptVersions.status, "production")));

    const [restored] = await this.db
      .update(promptVersions)
      .set({ status: "production", publishedAt: new Date() })
      .where(eq(promptVersions.id, archived[0].id))
      .returning();

    await this.admin.audit(req.user!.id, "prompt.rollback", "prompt", id, {
      version: restored.version,
    });
    return { version: restored };
  }
}

/* ------------------------------------------------------------------ */
/* Skills                                                              */
/* ------------------------------------------------------------------ */

@Controller("/admin/skills")
@UseGuards(AdminGuard)
class SkillsController {
  constructor(
    @Inject(DB) private db: ApiDb,
    private admin: AdminService,
  ) {}

  @Get()
  async list() {
    const allSkills = await this.db.select().from(skills).orderBy(skills.category);
    const allVersions = await this.db
      .select()
      .from(skillVersions)
      .orderBy(desc(skillVersions.version));
    const allRules = await this.db.select().from(skillRules);
    return {
      skills: allSkills.map((s) => ({
        ...s,
        versions: allVersions.filter((v) => v.skillId === s.id),
        rules: allRules.filter((r) => r.skillId === s.id),
      })),
    };
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: unknown) {
    const schema = z.object({
      key: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
      name: z.string().min(1).max(120),
      category: z.string().min(1).max(60),
      purpose: z.string().max(500).optional(),
      instruction: z.string().min(1),
      priority: z.number().int().min(1).max(100).default(50),
    });
    const input = parseWith(schema, body);

    const existing = await this.db
      .select({ id: skills.id })
      .from(skills)
      .where(eq(skills.key, input.key))
      .limit(1);
    if (existing.length > 0) throw new BadRequestException("Skill key already exists");

    const [skill] = await this.db
      .insert(skills)
      .values({
        key: input.key,
        name: input.name,
        category: input.category,
        purpose: input.purpose ?? null,
      })
      .returning();

    const [version] = await this.db
      .insert(skillVersions)
      .values({
        skillId: skill.id,
        version: 1,
        status: "draft",
        instruction: input.instruction,
        priority: input.priority,
      })
      .returning();

    await this.admin.audit(req.user!.id, "skill.create", "skill", skill.id, { key: input.key });
    return { skill, version };
  }

  @Post("/:id/versions")
  async newVersion(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    const schema = z.object({
      instruction: z.string().min(1),
      priority: z.number().int().min(1).max(100).optional(),
      notes: z.string().max(1000).optional(),
    });
    const input = parseWith(schema, body);

    const versions = await this.db
      .select({ version: skillVersions.version })
      .from(skillVersions)
      .where(eq(skillVersions.skillId, id));
    if (versions.length === 0) throw new NotFoundException("Skill not found");
    const nextVersion = versions.reduce((m, v) => Math.max(m, v.version), 0) + 1;

    const [version] = await this.db
      .insert(skillVersions)
      .values({
        skillId: id,
        version: nextVersion,
        status: "draft",
        instruction: input.instruction,
        priority: input.priority ?? 50,
        notes: input.notes ?? null,
      })
      .returning();

    await this.admin.audit(req.user!.id, "skill.new_version", "skill", id, { version: nextVersion });
    return { version };
  }

  @Post("/:id/publish")
  async publish(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    const schema = z.object({ versionId: z.string().uuid().optional() });
    const input = parseWith(schema, body);

    let target = input.versionId
      ? (
          await this.db
            .select()
            .from(skillVersions)
            .where(and(eq(skillVersions.id, input.versionId), eq(skillVersions.skillId, id)))
            .limit(1)
        )[0]
      : (
          await this.db
            .select()
            .from(skillVersions)
            .where(eq(skillVersions.skillId, id))
            .orderBy(desc(skillVersions.version))
            .limit(1)
        )[0];

    if (!target) throw new NotFoundException("Version not found");
    if (target.status === "production") throw new BadRequestException("Version is already production");

    await this.db
      .update(skillVersions)
      .set({ status: "archived" })
      .where(and(eq(skillVersions.skillId, id), eq(skillVersions.status, "production")));

    const [published] = await this.db
      .update(skillVersions)
      .set({ status: "production", publishedAt: new Date() })
      .where(eq(skillVersions.id, target.id))
      .returning();

    await this.admin.audit(req.user!.id, "skill.publish", "skill", id, {
      version: published.version,
    });
    return { version: published };
  }

  @Put("/:id/rules")
  async replaceRules(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    const schema = z.object({
      rules: z.array(
        z.object({
          description: z.string().max(500).optional(),
          conditions: z.array(
            z.object({
              field: z.string(),
              op: z.enum(["equals", "not_equals", "in", "not_null", "gt", "gte"]),
              value: z.unknown(),
            }),
          ),
          isEnabled: z.boolean().default(true),
        }),
      ),
    });
    const input = parseWith(schema, body);

    const skill = await this.db.select({ id: skills.id }).from(skills).where(eq(skills.id, id)).limit(1);
    if (skill.length === 0) throw new NotFoundException("Skill not found");

    await this.db.delete(skillRules).where(eq(skillRules.skillId, id));
    if (input.rules.length > 0) {
      await this.db.insert(skillRules).values(
        input.rules.map((r) => ({
          skillId: id,
          description: r.description ?? null,
          conditions: r.conditions as Array<{ field: string; op: string; value: unknown }>,
          isEnabled: r.isEnabled,
        })),
      );
    }

    await this.admin.audit(req.user!.id, "skill.rules", "skill", id, { count: input.rules.length });
    return { ok: true };
  }

  @Put("/:id/enabled")
  async setEnabled(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    const schema = z.object({ isEnabled: z.boolean() });
    const input = parseWith(schema, body);
    await this.db.update(skills).set({ isEnabled: input.isEnabled }).where(eq(skills.id, id));
    await this.admin.audit(req.user!.id, "skill.enabled", "skill", id, input);
    return { ok: true };
  }
}

/* ------------------------------------------------------------------ */
/* Quality rules & budget                                              */
/* ------------------------------------------------------------------ */

@Controller("/admin/quality-rules")
@UseGuards(AdminGuard)
class QualityRulesController {
  constructor(
    private admin: AdminService,
    @Inject(DB) private db: ApiDb,
  ) {}

  @Get()
  async get() {
    const rules = await this.admin.getBudgetRules();
    return {
      minGarmentFidelity: rules.minGarmentFidelity,
      minCharacterIdentity: rules.minCharacterIdentity,
      minPhotorealism: rules.minPhotorealism,
      minAnatomy: rules.minAnatomy,
      minTechnicalQuality: rules.minTechnicalQuality,
      uncertaintyBand: rules.uncertaintyBand,
      minReviewerConfidence: rules.minReviewerConfidence,
      isSecondReviewEnabled: rules.isSecondReviewEnabled,
    };
  }

  @Put()
  async update(@Req() req: AuthedRequest, @Body() body: unknown) {
    const schema = z.object({
      minGarmentFidelity: z.number().int().min(0).max(100).optional(),
      minCharacterIdentity: z.number().int().min(0).max(100).optional(),
      minPhotorealism: z.number().int().min(0).max(100).optional(),
      minAnatomy: z.number().int().min(0).max(100).optional(),
      minTechnicalQuality: z.number().int().min(0).max(100).optional(),
      uncertaintyBand: z.number().int().min(0).max(20).optional(),
      minReviewerConfidence: z.number().int().min(0).max(100).optional(),
      isSecondReviewEnabled: z.boolean().optional(),
    });
    const input = parseWith(schema, body);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(input)) if (v !== undefined) patch[k] = v;
    await this.db.update(budgetRules).set(patch).where(eq(budgetRules.singletonKey, "global"));
    await this.admin.audit(req.user!.id, "quality_rules.update", "budget_rules", "global", input);
    return { ok: true };
  }
}

@Controller("/admin/budget")
@UseGuards(AdminGuard)
class BudgetController {
  constructor(
    private admin: AdminService,
    @Inject(DB) private db: ApiDb,
  ) {}

  @Get()
  async get() {
    return this.admin.getBudgetRules();
  }

  @Put()
  async update(@Req() req: AuthedRequest, @Body() body: unknown) {
    const schema = z.object({
      warnInr: z.number().nonnegative().optional(),
      hardStopInr: z.number().nonnegative().optional(),
      maxAttempts: z.number().int().min(1).max(6).optional(),
      planningBudget1kInr: z.number().nonnegative().optional(),
      planningBudget2kInr: z.number().nonnegative().optional(),
      planningBudget4kInr: z.number().nonnegative().optional(),
      usdInrRate: z.number().positive().optional(),
      perUserDailyJobLimit: z.number().int().min(1).max(1000).optional(),
    });
    const input = parseWith(schema, body);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      patch[k] = typeof v === "number" && k !== "maxAttempts" && k !== "perUserDailyJobLimit"
        ? String(v)
        : v;
    }
    await this.db.update(budgetRules).set(patch).where(eq(budgetRules.singletonKey, "global"));
    await this.admin.audit(req.user!.id, "budget.update", "budget_rules", "global", input);
    return { ok: true };
  }
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

@Controller("/admin/settings")
@UseGuards(AdminGuard)
class SettingsController {
  constructor(private admin: AdminService) {}

  @Get()
  async get() {
    const config = getAppConfig();
    return {
      providerKeys: {
        openrouterConfigured: Boolean(config.OPENROUTER_API_KEY),
      },
      mockProviders: config.MOCK_PROVIDERS,
      webUrl: config.WEB_URL,
      audit: await this.admin.recentAudit(20),
    };
  }

  /**
   * Verify a provider connection from the API process. Credentials are accepted
   * only for this request and are never returned or written to the audit log.
   * The worker remains env-configured until a durable provider secret store is
   * introduced; this endpoint is intentionally a real connectivity check, not
   * a fake "connected" toggle.
   */
  @Post("/test-openrouter")
  async testOpenRouter(@Body() body: unknown) {
    const schema = z.object({
      baseUrl: z.string().url().refine((value) => /^https?:\/\//i.test(value), "Use an HTTP(S) URL"),
      apiKey: z.string().min(1).max(500),
    });
    const input = parseWith(schema, body);
    const baseUrl = input.baseUrl.replace(/\/+$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${input.apiKey}` },
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => null)) as
        | { data?: Array<{ id?: string }> ; error?: { message?: string } }
        | null;

      if (!response.ok) {
        return {
          connected: false,
          status: response.status,
          message: payload?.error?.message ?? `Provider returned HTTP ${response.status}`,
        };
      }

      return {
        connected: true,
        status: response.status,
        baseUrl,
        modelCount: Array.isArray(payload?.data) ? payload.data.length : 0,
        sampleModels: Array.isArray(payload?.data)
          ? payload.data.slice(0, 5).map((model) => model.id).filter(Boolean)
          : [],
      };
    } catch (error) {
      return {
        connected: false,
        status: 0,
        message: error instanceof Error && error.name === "AbortError"
          ? "Provider request timed out after 10 seconds"
          : error instanceof Error
            ? error.message
            : "Provider request failed",
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export {
  WorkflowController,
  ModelsController,
  PromptsController,
  SkillsController,
  QualityRulesController,
  BudgetController,
  SettingsController,
};
