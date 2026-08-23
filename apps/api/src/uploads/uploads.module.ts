import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { assets } from "@shotlin/database";
import {
  extractImageMeta,
  makePreview,
  type Storage,
} from "@shotlin/platform";
import { z } from "zod";
import { AuthGuard, parseWith } from "../common";
import type { AuthedRequest } from "../types";
import { STORAGE, type ApiDb } from "../infrastructure";
import { DB } from "../infrastructure";
import { AuthModule } from "../auth/auth.module";
import { createHash } from "node:crypto";

const presignSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  kind: z.enum([
    "garment_reference",
    "detail_reference",
    "character_reference",
  ]),
});

const completeSchema = z.object({
  filename: z.string().min(1).max(255).optional(),
});

@Injectable()
class UploadsService {
  constructor(
    @Inject(DB) private db: ApiDb,
    @Inject(STORAGE) private storage: Storage,
  ) {}

  async presign(userId: string, body: unknown) {
    const input = parseWith(presignSchema, body);
    const assetId = crypto.randomUUID();
    const ext = input.contentType === "image/jpeg" ? "jpg"
      : input.contentType === "image/png" ? "png" : "webp";
    const objectKey = `uploads/${userId}/${assetId}.${ext}`;

    const uploadUrl = await this.storage.presignPut(
      this.storage.uploadsBucket,
      objectKey,
      input.contentType,
    );

    await this.db.insert(assets).values({
      id: assetId,
      userId,
      kind: input.kind,
      bucket: this.storage.uploadsBucket,
      objectKey,
      originalFilename: input.filename,
      mimeType: input.contentType,
      validationStatus: "pending",
    });

    return {
      assetId,
      uploadUrl,
      objectKey,
      headers: { "Content-Type": input.contentType },
    };
  }

  /** HEAD the object, run deterministic validation, mark usable/rejected. */
  async complete(userId: string, assetId: string, body: unknown) {
    parseWith(completeSchema, body);

    const rows = await this.db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.userId, userId)))
      .limit(1);
    const asset = rows[0];
    if (!asset) throw new BadRequestException("Asset not found");

    if (asset.validationStatus !== "pending") {
      return this.assetResponse(asset.id, asset.validationStatus, asset.validationReport);
    }

    const head = await this.storage.headObject(asset.bucket, asset.objectKey);
    if (!head || head.contentLength === 0) {
      throw new BadRequestException("Uploaded object not found — upload first");
    }

    const report: Record<string, unknown> = {};
    let usable = true;
    let width: number | null = null;
    let height: number | null = null;
    let checksum: string | null = null;

    // Check size from the HEAD response before ever downloading or decoding
    // the object — an oversized file (or a decompression-bomb-style image
    // that's small on disk but huge decoded) should never reach `sharp` just
    // to be rejected a moment later.
    if (head.contentLength > 26_214_400) {
      usable = false;
      report.reason = "File exceeds 25MB limit";
    } else {
      const buffer = await this.storage.getObject(asset.bucket, asset.objectKey);
      checksum = createHash("sha256").update(buffer).digest("hex");

      try {
        const meta = await extractImageMeta(buffer);
        width = meta.width;
        height = meta.height;
        report.width = meta.width;
        report.height = meta.height;
        report.detectedMimeType = meta.mimeType;
        report.blurVariance = meta.blurVariance != null ? Math.round(meta.blurVariance) : null;

        if (meta.mimeType !== asset.mimeType) {
          usable = false;
          report.reason = `Detected type ${meta.mimeType} does not match declared ${asset.mimeType}`;
        }
        if (meta.width < 128 || meta.height < 128) {
          usable = false;
          report.reason = "Image too small (min 128px)";
        }
      } catch (err) {
        usable = false;
        report.reason = `Corrupted or undecodable image: ${(err as Error).message}`;
      }
    }

    // Originals stay immutable; only validation fields update.
    await this.db
      .update(assets)
      .set({
        validationStatus: usable ? "usable" : "rejected",
        validationReport: report,
        sizeBytes: head.contentLength,
        width,
        height,
        checksum,
      })
      .where(eq(assets.id, assetId));

    return this.assetResponse(assetId, usable ? "usable" : "rejected", report);
  }

  private assetResponse(assetId: string, status: string, report: unknown) {
    return { assetId, validationStatus: status, validationReport: report };
  }
}

@Controller("/uploads")
@UseGuards(AuthGuard)
class UploadsController {
  constructor(private service: UploadsService) {}

  @Post()
  async presign(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.service.presign(req.user!.id, body);
  }

  @Post("/:id/complete")
  async complete(
    @Req() req: AuthedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.service.complete(req.user!.id, id, body);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [UploadsController],
  providers: [UploadsService],
})
export class UploadsModule {}
