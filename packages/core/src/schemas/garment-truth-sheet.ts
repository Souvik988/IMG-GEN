import { z } from "zod";

export const garmentTruthSheetSchema = z.object({
  garmentType: z.enum([
    "saree",
    "lehenga",
    "kurta",
    "kurti",
    "dress",
    "shirt",
    "top",
    "menswear",
    "other",
  ]),
  inputType: z.enum(["photo", "drawing", "design_reference"]),
  colors: z.array(
    z.object({ name: z.string(), hex: z.string().nullable() }),
  ),
  material: z.string(),
  pattern: z.string(),
  border: z.string(),
  embroidery: z.string(),
  neckline: z.string(),
  sleeves: z.string(),
  lengthSilhouette: z.string(),
  drapePallu: z.string(),
  specialDetails: z.array(z.string()),
  protectedDetails: z.array(z.string()),
  uncertainDetails: z.array(z.string()),
  complexity: z.enum(["low", "medium", "high"]),
  confidence: z.number().int().min(0).max(100),
});

export type GarmentTruthSheet = z.infer<typeof garmentTruthSheetSchema>;
