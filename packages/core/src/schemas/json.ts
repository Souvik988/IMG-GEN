/** Provider-neutral schemas for native structured model output. */

const nullableString = { type: ["string", "null"] } as const;

export const garmentTruthSheetJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    garmentType: { type: "string", enum: ["saree", "lehenga", "kurta", "kurti", "dress", "shirt", "top", "menswear", "other"] },
    inputType: { type: "string", enum: ["photo", "drawing", "design_reference"] },
    colors: {
      type: "array",
      description: "Every important color in garment-region order.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", description: "Plain-language color name." },
          hex: { ...nullableString, description: "Approximate hex when supported by the image; otherwise null." },
        },
        required: ["name", "hex"],
      },
    },
    material: { type: "string", description: "Visible fabric/material evidence only." },
    pattern: { type: "string", description: "Print, weave, motif, repeat, or none." },
    border: { type: "string", description: "Border/trim treatment, placement, and repeat, or none." },
    embroidery: { type: "string", description: "Embroidery, applique, sequins, zari, or none." },
    neckline: { type: "string" },
    sleeves: { type: "string" },
    lengthSilhouette: { type: "string", description: "Length, fit, volume, and silhouette." },
    drapePallu: { type: "string", description: "Drape/pleat/pallu/dupatta behavior, or not applicable." },
    specialDetails: { type: "array", items: { type: "string" } },
    protectedDetails: { type: "array", items: { type: "string" }, description: "Identity-defining details that must survive generation unchanged." },
    uncertainDetails: { type: "array", items: { type: "string" }, description: "Occluded or ambiguous details that must not be guessed." },
    complexity: { type: "string", enum: ["low", "medium", "high"] },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
  },
  required: ["garmentType", "inputType", "colors", "material", "pattern", "border", "embroidery", "neckline", "sleeves", "lengthSilhouette", "drapePallu", "specialDetails", "protectedDetails", "uncertainDetails", "complexity", "confidence"],
} as const;

const defectJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    code: { type: "string" },
    description: { type: "string" },
    repairHint: { type: "string" },
  },
  required: ["code", "description", "repairHint"],
} as const;

export const qualityReviewJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    scores: {
      type: "object",
      additionalProperties: false,
      properties: {
        garmentFidelity: { type: "integer", minimum: 0, maximum: 100 },
        patternFidelity: { type: "integer", minimum: 0, maximum: 100 },
        borderEmbroideryFidelity: { type: "integer", minimum: 0, maximum: 100 },
        garmentStructure: { type: "integer", minimum: 0, maximum: 100 },
        characterIdentity: { type: "integer", minimum: 0, maximum: 100 },
        anatomy: { type: "integer", minimum: 0, maximum: 100 },
        photorealism: { type: "integer", minimum: 0, maximum: 100 },
        environment: { type: "integer", minimum: 0, maximum: 100 },
        technicalQuality: { type: "integer", minimum: 0, maximum: 100 },
      },
      required: ["garmentFidelity", "patternFidelity", "borderEmbroideryFidelity", "garmentStructure", "characterIdentity", "anatomy", "photorealism", "environment", "technicalQuality"],
    },
    criticalDefects: { type: "array", items: defectJsonSchema },
    minorDefects: { type: "array", items: defectJsonSchema },
    repairInstruction: { type: "string" },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
  },
  required: ["scores", "criticalDefects", "minorDefects", "repairInstruction", "confidence"],
} as const;
