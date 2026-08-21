import { makeMockImage } from "@shotlin/platform";
import type {
  AnalyzeGarmentInput,
  ChatJsonInput,
  GenerateImageInput,
  GenerateImageOutput,
  ProviderResult,
  ReviewCandidateInput,
} from "./types";
import type { GarmentTruthSheet, QualityReview } from "@shotlin/core";

/**
 * Deterministic mock providers.
 * Behaviour is driven by env vars so the whole pipeline (QA → rule engine →
 * retries → budget stop) can be exercised without API keys:
 *
 *   MOCK_REVIEW_RESULT   pass | fail | uncertain   (default pass)
 *   MOCK_FAIL_FIRST_N    number of leading attempts that fail (default 0)
 *   MOCK_GARMENT_TYPE    saree | kurta | dress ... (default saree)
 */

const RESOLUTION_DIMS: Record<string, [number, number]> = {
  "1k": [1024, 1024],
  "2k": [1536, 2048],
  "4k": [3072, 4096],
};

const ASPECT_MODIFIER: Record<string, [number, number]> = {
  portrait: [1, 1.33],
  square: [1, 1],
  landscape: [1.33, 1],
};

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function makeTruthSheet(garmentType: string): GarmentTruthSheet {
  const base: Record<string, GarmentTruthSheet> = {
    saree: {
      garmentType: "saree",
      inputType: "photo",
      colors: [{ name: "deep teal", hex: "#0f6b6b" }, { name: "gold zari", hex: "#d4af37" }],
      material: "silk with metallic zari threads",
      pattern: "woven paisley motifs across the body",
      border: "wide gold zari border with temple motif repeat",
      embroidery: "none",
      neckline: "boat neckline blouse",
      sleeves: "sleeveless blouse",
      lengthSilhouette: "full-length saree with pallu over left shoulder",
      drapePallu: "Nivi style drape, pallu draped over left shoulder to knee",
      specialDetails: ["pleated front fall", "pallu tassels"],
      protectedDetails: [
        "teal body colour",
        "gold temple-motif border on pallu and hem",
        "paisley motif placement and scale",
        "boat neckline sleeveless blouse",
      ],
      uncertainDetails: [],
      complexity: "medium",
      confidence: 92,
    },
    kurta: {
      garmentType: "kurta",
      inputType: "photo",
      colors: [{ name: "ivory", hex: "#f5f0e6" }],
      material: "cotton",
      pattern: "none",
      border: "none",
      embroidery: "chikankari embroidery on yoke",
      neckline: "mandarin collar",
      sleeves: "three-quarter sleeves",
      lengthSilhouette: "straight knee-length kurta",
      drapePallu: "not applicable",
      specialDetails: ["side slits"],
      protectedDetails: ["ivory colour", "chikankari yoke", "mandarin collar", "side slits"],
      uncertainDetails: [],
      complexity: "medium",
      confidence: 90,
    },
    dress: {
      garmentType: "dress",
      inputType: "photo",
      colors: [{ name: "black", hex: "#111111" }],
      material: "crepe",
      pattern: "none",
      border: "none",
      embroidery: "none",
      neckline: "v-neck",
      sleeves: "sleeveless",
      lengthSilhouette: "midi fit-and-flare",
      drapePallu: "not applicable",
      specialDetails: ["concealed back zip"],
      protectedDetails: ["black colour", "v-neck", "midi length", "fit-and-flare silhouette"],
      uncertainDetails: [],
      complexity: "low",
      confidence: 93,
    },
  };
  return (
    base[garmentType] ??
    ({
      ...base.saree,
      garmentType: garmentType as GarmentTruthSheet["garmentType"],
    })
  );
}

function passingReview(): QualityReview {
  return {
    scores: {
      garmentFidelity: 97,
      patternFidelity: 96,
      borderEmbroideryFidelity: 96,
      garmentStructure: 97,
      characterIdentity: 95,
      anatomy: 96,
      photorealism: 95,
      environment: 96,
      technicalQuality: 96,
    },
    criticalDefects: [],
    minorDefects: [],
    repairInstruction: "",
    confidence: 90,
  };
}

function failingReview(): QualityReview {
  return {
    scores: {
      garmentFidelity: 78,
      patternFidelity: 75,
      borderEmbroideryFidelity: 80,
      garmentStructure: 85,
      characterIdentity: 91,
      anatomy: 92,
      photorealism: 93,
      environment: 94,
      technicalQuality: 92,
    },
    criticalDefects: [
      {
        code: "wrong_pallu_color",
        description: "Pallu rendered as maroon instead of deep teal",
        repairHint: "Render the pallu in deep teal #0f6b6b matching the reference",
      },
    ],
    minorDefects: [
      {
        code: "slight_border_repeat_error",
        description: "Border motif spacing is wider than the reference",
        repairHint: "Tighten border motif repeat to match reference spacing",
      },
    ],
    repairInstruction:
      "Correct the pallu colour to deep teal (#0f6b6b) and tighten the gold border motif spacing to match the reference exactly. Keep everything else unchanged.",
    confidence: 88,
  };
}

function uncertainReview(): QualityReview {
  return {
    scores: {
      garmentFidelity: 93,
      patternFidelity: 92,
      borderEmbroideryFidelity: 93,
      garmentStructure: 95,
      characterIdentity: 94,
      anatomy: 95,
      photorealism: 94,
      environment: 95,
      technicalQuality: 94,
    },
    criticalDefects: [],
    minorDefects: [],
    repairInstruction: "",
    confidence: 55, // low confidence → UNCERTAIN
  };
}

export const mockProvider = {
  async analyzeGarment(input: AnalyzeGarmentInput): Promise<ProviderResult<GarmentTruthSheet>> {
    const garmentType = process.env.MOCK_GARMENT_TYPE ?? "saree";
    return {
      data: makeTruthSheet(garmentType),
      usage: { inputTokens: 1800, outputTokens: 700, imageCount: 0 },
      raw: JSON.stringify(makeTruthSheet(garmentType)),
    };
  },

  async reviewCandidate(input: ReviewCandidateInput): Promise<ProviderResult<QualityReview>> {
    const mode = process.env.MOCK_REVIEW_RESULT ?? "pass";
    const failFirstN = envInt("MOCK_FAIL_FIRST_N", 0);
    const attempt = input.model.role === "second_reviewer" ? 0 : (input.attemptNumber ?? 1) - 1;

    let review: QualityReview;
    if (mode === "fail") {
      review = failingReview();
    } else if (mode === "uncertain" && attempt === 0) {
      review = uncertainReview();
    } else if (mode === "pass" && attempt < failFirstN) {
      review = failingReview();
    } else {
      review = passingReview();
    }

    return {
      data: review,
      usage: { inputTokens: 2600, outputTokens: 600, imageCount: 0 },
      raw: JSON.stringify(review),
    };
  },

  async generateImage(input: GenerateImageInput): Promise<GenerateImageOutput> {
    const base = RESOLUTION_DIMS[input.resolution] ?? RESOLUTION_DIMS["2k"];
    const mod = ASPECT_MODIFIER[input.aspectRatio] ?? ASPECT_MODIFIER.portrait;
    const width = Math.round(base[0] * mod[0]);
    const height = Math.round(base[1] * mod[1]);

    const count = Math.max(1, Math.min(input.count, 4));
    const images = [];
    for (let i = 0; i < count; i++) {
      const label = `job ${input.jobId ?? "?"} attempt ${input.attemptNumber ?? 1} img ${i + 1}`;
      const rgb: [number, number, number] = [
        (attemptChannel(input.attemptNumber) * 37) % 256,
        (i * 80 + 60) % 256,
        (attemptChannel(input.attemptNumber) * 91) % 256,
      ];
      images.push({
        data: await makeMockImage(width, height, label, rgb),
        mimeType: "image/png",
      });
    }

    return {
      images,
      usage: { inputTokens: 650, outputTokens: 0, imageCount: count, resolution: input.resolution },
    };
  },

  async secondReview(input: ReviewCandidateInput): Promise<ProviderResult<QualityReview>> {
    // Second reviewer is decisive: PASS-quality scores with high confidence.
    return {
      data: passingReview(),
      usage: { inputTokens: 2800, outputTokens: 620, imageCount: 0 },
      raw: JSON.stringify(passingReview()),
    };
  },

  async chatJson<T>(input: ChatJsonInput<T>): Promise<ProviderResult<T>> {
    throw new Error("Mock chatJson not implemented — mock mode is template-first.");
  },
};

function attemptChannel(attempt?: number): number {
  return 1 + (attempt ?? 1);
}
