import { z } from "zod";

export const defectSchema = z.object({
  code: z.string(),
  description: z.string(),
  repairHint: z.string(),
});

export type Defect = z.infer<typeof defectSchema>;

export const qualityReviewSchema = z.object({
  scores: z.object({
    garmentFidelity: z.number().int().min(0).max(100),
    patternFidelity: z.number().int().min(0).max(100),
    borderEmbroideryFidelity: z.number().int().min(0).max(100),
    garmentStructure: z.number().int().min(0).max(100),
    characterIdentity: z.number().int().min(0).max(100),
    anatomy: z.number().int().min(0).max(100),
    photorealism: z.number().int().min(0).max(100),
    environment: z.number().int().min(0).max(100),
    technicalQuality: z.number().int().min(0).max(100),
  }),
  criticalDefects: z.array(defectSchema),
  minorDefects: z.array(defectSchema),
  repairInstruction: z.string(),
  confidence: z.number().int().min(0).max(100),
});

export type QualityReview = z.infer<typeof qualityReviewSchema>;