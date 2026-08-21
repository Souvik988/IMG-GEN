import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Queue } from "bullmq";
import { createHash } from "node:crypto";
import { and, count, desc, eq, gte, inArray } from "drizzle-orm";
import {
  assets,
  budgetRules,
  characters,
  environmentPresets,
  feedback,
  generationCandidates,
  jobAttempts,
  jobInputs as jobInputsTable,
  jobOutputs,
  jobStateEvents,
  jobs,
  workflowVersions,
  workflows,
} from "@shotlin/database";
import { CUSTOMER_FACING_STATES } from "@shotlin/core";
import type { Storage } from "@shotlin/platform";
import { z } from "zod";
import { AuthGuard, parseWith } from "../common";
import { GenerationRateLimitGuard } from "./generation-rate-limit.guard";
import type { AuthedRequest, Reply } from "../types";
import {
  DB,
  GENERATION_QUEUE_PROV,
  STORAGE,
  type ApiDb,
} from "../infrastructure";
import { AuthModule } from "../auth/auth.module";

const createJobSchema = z.object({
  mainGarmentAssetId: z.string().uuid(),
  detailAssetIds: z.array(z.string().uuid()).max(5).default([]),
  inputType: z.enum(["photo", "drawing", "design_reference"]).default("photo"),
  characterId: z.string().uuid().nullable().optional(),
  characterAssetId: z.string().uuid().nullable().optional(),
  genderPresentation: z.enum(["female", "male", "other"]).nullable().optional(),
  ageAppearance: z.string().min(1).max(60).default("mid-20s"),
  heightAppearance: z.string().min(1).max(60).default("average"),
  pose: z.enum(["auto", "standing", "walking", "closeup"]).default("auto"),
  environmentPresetId: z.string().uuid().nullable().optional(),
  resolution: z.enum(["1k", "2k", "4k"]).default("2k"),
  aspectRatio: z.enum(["portrait", "square", "landscape"]).default("portrait"),
  outputCount: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(1),
});

const feedbackSchema = z.object({
  rating: z.enum(["good", "needs_improvement"]),
  comment: z.string().max(2000).optional(),
});

@Injectable()
class JobsService {
  constructor(
    @Inject(DB) private db: ApiDb,
    @Inject(STORAGE) private storage: Storage,
    @Inject(GENERATION_QUEUE_PROV) private queue: Queue,
  ) {}

  async createJob(userId: string, body: unknown, idempotencyKey: string | undefined) {
    const input = parseWith(createJobSchema, body);
    const key = parseWith(
      z.string().regex(/^[A-Za-z0-9._~-]{16,128}$/, "Idempotency-Key must be 16–128 URL-safe characters"),
      idempotencyKey,
    );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");

    const existing = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.userId, userId), eq(jobs.idempotencyKey, key)))
      .limit(1);
    if (existing[0]) {
      if (existing[0].idempotencyFingerprint !== fingerprint) {
        throw new ConflictException("This Idempotency-Key was already used for a different generation request");
      }
      return this.replayIdempotentJob(existing[0]);
    }

    // ---- validate assets belong to the user and are usable ----
    const assetIds = [input.mainGarmentAssetId, ...input.detailAssetIds];
    if (input.characterAssetId) assetIds.push(input.characterAssetId);
    const assetRows = await this.db
      .select()
      .from(assets)
      .where(eq(assets.userId, userId));
    const owned = new Map(assetRows.map((a) => [a.id, a]));
    for (const id of assetIds) {
      const a = owned.get(id);
      if (!a) throw new BadRequestException(`Asset ${id} not found for this user`);
      if (a.validationStatus !== "usable") {
        throw new BadRequestException(`Asset ${id} is not validated as usable`);
      }
    }

    // ---- per-user daily job limit ----
    const [rules] = await this.db.select().from(budgetRules).limit(1);
    const dailyLimit = rules?.perUserDailyJobLimit ?? 20;
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [{ value: todayCount }] = await this.db
      .select({ value: count() })
      .from(jobs)
      .where(and(eq(jobs.userId, userId), gte(jobs.createdAt, since)));
    if (Number(todayCount) >= dailyLimit) {
      throw new BadRequestException(`Daily job limit reached (${dailyLimit}/24h)`);
    }

    // ---- snapshot the production workflow version ----
    const wfRows = await this.db
      .select({ versionId: workflowVersions.id })
      .from(workflows)
      .innerJoin(workflowVersions, eq(workflowVersions.workflowId, workflows.id))
      .where(and(eq(workflows.key, "default"), eq(workflowVersions.status, "production")))
      .limit(1);
    const workflowVersionId = wfRows[0]?.versionId;
    if (!workflowVersionId) {
      throw new BadRequestException("No production workflow configured");
    }

    // ---- character / environment checks ----
    if (input.characterId) {
      const c = await this.db
        .select({ id: characters.id })
        .from(characters)
        .where(eq(characters.id, input.characterId))
        .limit(1);
      if (c.length === 0) throw new BadRequestException("Character not found");
    }
    if (input.environmentPresetId) {
      const e = await this.db
        .select({ id: environmentPresets.id })
        .from(environmentPresets)
        .where(eq(environmentPresets.id, input.environmentPresetId))
        .limit(1);
      if (e.length === 0) throw new BadRequestException("Environment preset not found");
    }

    const selections: Record<string, unknown> = {
      inputType: input.inputType,
      genderPresentation: input.genderPresentation ?? null,
      ageAppearance: input.ageAppearance,
      heightAppearance: input.heightAppearance,
      pose: input.pose,
    };

    let job: typeof jobs.$inferSelect;
    try {
      [job] = await this.db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(jobs)
          .values({
            userId,
            workflowVersionId,
            state: "created",
            requestedResolution: input.resolution,
            aspectRatio: input.aspectRatio,
            outputCount: input.outputCount,
            idempotencyKey: key,
            idempotencyFingerprint: fingerprint,
            characterId: input.characterId ?? null,
            characterAssetId: input.characterAssetId ?? null,
            environmentPresetId: input.environmentPresetId ?? null,
            selections,
          })
          .returning();
        const inputRows: Array<{
          jobId: string;
          assetId: string;
          role: "main_garment" | "detail" | "character";
        }> = [
          { jobId: inserted.id, assetId: input.mainGarmentAssetId, role: "main_garment" as const },
          ...input.detailAssetIds.map((id) => ({ jobId: inserted.id, assetId: id, role: "detail" as const })),
        ];
        if (input.characterAssetId) {
          inputRows.push({ jobId: inserted.id, assetId: input.characterAssetId, role: "character" as const });
        }
        await tx.insert(jobInputsTable).values(inputRows);
        return [inserted] as const;
      });
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
      const raced = await this.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.userId, userId), eq(jobs.idempotencyKey, key)))
        .limit(1);
      if (!raced[0]) throw error;
      if (raced[0].idempotencyFingerprint !== fingerprint) {
        throw new ConflictException("This Idempotency-Key was already used for a different generation request");
      }
      return this.replayIdempotentJob(raced[0]);
    }

    // ---- enqueue ----
    await this.queue.add("generate", { jobId: job.id }, { jobId: job.id });

    return { job: this.toCustomerJob(job) };
  }

  private async replayIdempotentJob(job: typeof jobs.$inferSelect) {
    // A request may have committed the DB transaction just before queue.add failed.
    // Replaying the same key repairs that handoff without creating another job.
    if (job.state === "created" && !(await this.queue.getJob(job.id))) {
      await this.queue.add("generate", { jobId: job.id }, { jobId: job.id });
    }
    return { job: this.toCustomerJob(job), deduplicated: true };
  }

  async getStatus(userId: string, jobId: string) {
    const job = await this.getOwnedJob(userId, jobId);
    const [attempts, stateEvents] = await Promise.all([
      this.db
        .select({ attemptNumber: jobAttempts.attemptNumber, status: jobAttempts.status })
        .from(jobAttempts)
        .where(eq(jobAttempts.jobId, job.id)),
      this.db
        .select({
          toState: jobStateEvents.toState,
          reason: jobStateEvents.reason,
          createdAt: jobStateEvents.createdAt,
        })
        .from(jobStateEvents)
        .where(eq(jobStateEvents.jobId, job.id))
        .orderBy(jobStateEvents.createdAt),
    ]);

    return {
      job: this.toCustomerJob(job),
      attempts: attempts.length,
      isTerminal: CUSTOMER_FACING_STATES[job.state]?.isTerminal ?? false,
      stateEvents,
    };
  }

  async getResult(userId: string, jobId: string) {
    const job = await this.getOwnedJob(userId, jobId);
    const outRows = await this.db
      .select()
      .from(jobOutputs)
      .where(eq(jobOutputs.jobId, job.id))
      .limit(1);
    const out = outRows[0];
    const candidateRows = await this.db
      .select({ asset: assets })
      .from(generationCandidates)
      .innerJoin(assets, eq(assets.id, generationCandidates.assetId))
      .where(eq(generationCandidates.jobId, job.id))
      .orderBy(desc(generationCandidates.createdAt))
      .limit(1);
    const candidate = candidateRows[0]?.asset;

    const outputAssetIds = [
      out?.masterAssetId,
      out?.previewAssetId,
      out?.jpgAssetId,
    ].filter((assetId): assetId is string => Boolean(assetId));
    const outputAssets = outputAssetIds.length
      ? await this.db.select().from(assets).where(inArray(assets.id, outputAssetIds))
      : [];
    const byId = new Map(outputAssets.map((asset) => [asset.id, asset]));
    const master = out ? byId.get(out.masterAssetId) : undefined;
    const preview = out?.previewAssetId ? byId.get(out.previewAssetId) : undefined;
    const jpg = out?.jpgAssetId ? byId.get(out.jpgAssetId) : undefined;
    const delivery = out ? "final" : candidate ? "stored_candidate" : "none";

    const [pngUrl, previewUrl, jpgUrl] = await Promise.all([
      master
        ? this.storage.presignGet(master.bucket, master.objectKey, 3600)
        : candidate
          ? this.storage.presignGet(candidate.bucket, candidate.objectKey, 3600)
          : null,
      preview
        ? this.storage.presignGet(preview.bucket, preview.objectKey, 3600)
        : candidate
          ? this.storage.presignGet(candidate.bucket, candidate.objectKey, 3600)
          : null,
      jpg ? this.storage.presignGet(jpg.bucket, jpg.objectKey, 3600) : null,
    ]);

    return {
      jobId: job.id,
      state: job.state,
      resolution: job.requestedResolution,
      aspectRatio: job.aspectRatio,
      characterId: job.characterId,
      environmentPresetId: job.environmentPresetId,
      delivery,
      previewUrl,
      downloads: {
        png: pngUrl,
        jpg: jpgUrl,
      },
    };
  }

  async listProjects(userId: string) {
    const rows = await this.db
      .select()
      .from(jobs)
      .where(eq(jobs.userId, userId))
      .orderBy(desc(jobs.createdAt))
      .limit(100);

    const projects = [];
    for (const job of rows) {
      let thumbnailUrl: string | null = null;
      if (job.state === "ready") {
        const out = await this.db
          .select()
          .from(jobOutputs)
          .where(eq(jobOutputs.jobId, job.id))
          .limit(1);
        const previewAssetId = out[0]?.previewAssetId ?? out[0]?.masterAssetId;
        if (previewAssetId) {
          const a = await this.db
            .select()
            .from(assets)
            .where(eq(assets.id, previewAssetId))
            .limit(1);
          if (a[0]) {
            thumbnailUrl = await this.storage.presignGet(a[0].bucket, a[0].objectKey, 3600);
          }
        }
      } else {
        const candidate = await this.db
          .select({ asset: assets })
          .from(generationCandidates)
          .innerJoin(assets, eq(assets.id, generationCandidates.assetId))
          .where(eq(generationCandidates.jobId, job.id))
          .orderBy(desc(generationCandidates.createdAt))
          .limit(1);
        if (candidate[0]) {
          thumbnailUrl = await this.storage.presignGet(
            candidate[0].asset.bucket,
            candidate[0].asset.objectKey,
            3600,
          );
        }
      }
      projects.push({
        ...this.toCustomerJob(job),
        thumbnailUrl,
        delivery: job.state === "ready" ? "final" : thumbnailUrl ? "stored_candidate" : "none",
      });
    }
    return { projects };
  }

  async submitFeedback(userId: string, jobId: string, body: unknown) {
    const input = parseWith(feedbackSchema, body);
    const job = await this.getOwnedJob(userId, jobId);
    await this.db
      .insert(feedback)
      .values({
        jobId: job.id,
        userId,
        rating: input.rating,
        comment: input.comment ?? null,
      })
      .onConflictDoUpdate({
        target: feedback.jobId,
        set: { rating: input.rating, comment: input.comment ?? null },
      });
    return { ok: true };
  }

  private async getOwnedJob(userId: string, jobId: string) {
    const rows = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException("Job not found");
    return rows[0];
  }

  private toCustomerJob(job: typeof jobs.$inferSelect) {
    return {
      id: job.id,
      state: job.state,
      display: CUSTOMER_FACING_STATES[job.state]?.label ?? job.state,
      resolution: job.requestedResolution,
      aspectRatio: job.aspectRatio,
      outputCount: job.outputCount,
      environmentPresetId: job.environmentPresetId,
      characterId: job.characterId,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    };
  }
}

@Controller("/jobs")
@UseGuards(AuthGuard)
class JobsController {
  constructor(private service: JobsService) {}

  @Post()
  @UseGuards(GenerationRateLimitGuard)
  async create(@Req() req: AuthedRequest, @Body() body: unknown) {
    const idempotencyKey = req.headers["idempotency-key"];
    return this.service.createJob(
      req.user!.id,
      body,
      typeof idempotencyKey === "string" ? idempotencyKey : undefined,
    );
  }

  @Get("/:id")
  async status(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.service.getStatus(req.user!.id, id);
  }

  @Get("/:id/result")
  async result(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.service.getResult(req.user!.id, id);
  }

  @Post("/:id/feedback")
  async feedback(
    @Req() req: AuthedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.service.submitFeedback(req.user!.id, id, body);
  }
}

@Controller("/projects")
@UseGuards(AuthGuard)
class ProjectsController {
  constructor(private service: JobsService) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    return this.service.listProjects(req.user!.id);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [JobsController, ProjectsController],
  providers: [JobsService, GenerationRateLimitGuard],
})
export class JobsModule {}
