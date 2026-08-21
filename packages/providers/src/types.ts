import type { GarmentTruthSheet, QualityReview } from "@shotlin/core";

export type ModelRef = {
  id: string;
  provider: "openrouter" | "mock";
  modelId: string;
  role: string;
};

export type ImageInput = {
  data: Buffer;
  mimeType: string;
};

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  imageCount: number;
  resolution?: string;
  providerReportedCostUsd?: number | null;
};

export type ProviderResult<T> = {
  data: T;
  usage: Usage;
  /** Raw provider text output for inspection. */
  raw?: string;
};

export type AnalyzeGarmentInput = {
  references: ImageInput[];
  systemPrompt: string;
  model: ModelRef;
  timeoutMs: number;
};

export type ReviewCandidateInput = {
  originalReferences: ImageInput[];
  candidate: ImageInput;
  truthSheet: GarmentTruthSheet;
  userSelections: Record<string, unknown>;
  systemPrompt: string;
  model: ModelRef;
  timeoutMs: number;
  /** Worker context (mock determinism, tracing). */
  attemptNumber?: number;
  jobId?: string;
};

export type GenerateImageInput = {
  references: ImageInput[];
  characterReference?: ImageInput;
  prompt: string;
  resolution: string; // "1k" | "2k" | "4k"
  aspectRatio: string; // "portrait" | "square" | "landscape"
  count: number;
  model: ModelRef;
  timeoutMs: number;
  /** Worker context for deterministic mock behaviour. */
  attemptNumber?: number;
  jobId?: string;
};

export type GeneratedImage = ImageInput;

export type GenerateImageOutput = {
  images: GeneratedImage[];
  usage: Usage;
};

export type ChatJsonInput<T> = {
  systemPrompt: string;
  userPrompt: string;
  images?: ImageInput[];
  schema: { parse: (v: unknown) => T; safeParse: (v: unknown) => { success: boolean; data?: T; error?: { message: string } } };
  jsonSchema?: Record<string, unknown>;
  schemaName?: string;
  model: ModelRef;
  timeoutMs: number;
  /** Stage-specific ceiling. Review JSON is intentionally compact. */
  maxTokens?: number;
  /** Use generic JSON plus the embedded schema when a model rejects strict mode. */
  strictSchema?: boolean;
  /** Preserve output budget for the requested JSON instead of hidden reasoning. */
  disableReasoning?: boolean;
};

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly cause?: unknown,
    /**
     * Usage returned by a provider even when its content was unusable.
     * Keeping it on the error lets the worker record every billable call.
     */
    public readonly usage?: Usage,
    /** Bounded diagnostic text; never used as a prompt or displayed to customers. */
    public readonly raw?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
