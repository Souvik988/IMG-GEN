import { getAppConfig } from "@shotlin/platform";
import {
  garmentTruthSheetSchema,
  garmentTruthSheetJsonSchema,
  qualityReviewSchema,
  qualityReviewJsonSchema,
  type GarmentTruthSheet,
  type QualityReview,
} from "@shotlin/core";
import { mockProvider } from "./mock";
import { openRouterChatJson, openRouterGenerateImage } from "./openrouter";
import { ProviderError } from "./types";
import type {
  AnalyzeGarmentInput,
  GenerateImageInput,
  GenerateImageOutput,
  ProviderResult,
  ReviewCandidateInput,
} from "./types";

/**
 * Resolves the active provider implementation for each logical role.
 * MOCK_PROVIDERS=true (env) forces mocks for every role regardless of the
 * configured model, so the pipeline runs end-to-end without API keys.
 */
export function resolveProviders() {
  const config = getAppConfig();
  const forceMock = config.MOCK_PROVIDERS;

  async function analyzeGarment(
    input: AnalyzeGarmentInput,
  ): Promise<ProviderResult<GarmentTruthSheet>> {
    if (forceMock || input.model.provider === "mock") {
      return mockProvider.analyzeGarment(input);
    }
    if (input.model.provider === "openrouter") {
      return openRouterChatJson(
        {
          systemPrompt: input.systemPrompt,
          userPrompt:
            "Analyze the attached garment reference image(s) and return the Garment Truth Sheet JSON.",
          images: input.references,
          schema: garmentTruthSheetSchema,
          jsonSchema: garmentTruthSheetJsonSchema,
          schemaName: "garment_truth_sheet",
          model: input.model,
          timeoutMs: input.timeoutMs,
          maxTokens: 1_800,
        },
        config.OPENROUTER_API_KEY,
      );
    }
    throw new ProviderError(
      `No vision adapter for provider '${input.model.provider}'`,
      input.model.provider,
    );
  }

  async function reviewCandidate(
    input: ReviewCandidateInput,
  ): Promise<ProviderResult<QualityReview>> {
    if (forceMock || input.model.provider === "mock") {
      return mockProvider.reviewCandidate(input);
    }
    if (input.model.provider === "openrouter") {
      return openRouterChatJson(
        {
          systemPrompt: input.systemPrompt,
          userPrompt: [
            "Review the FINAL generated image (the last attached image) against the original garment references (earlier images).",
            "",
            `GARMENT TRUTH SHEET:\n${JSON.stringify(input.truthSheet)}`,
            "",
            `USER SELECTIONS:\n${JSON.stringify(input.userSelections)}`,
          ].join("\n"),
          images: [...input.originalReferences, input.candidate],
          schema: qualityReviewSchema,
          jsonSchema: qualityReviewJsonSchema,
          schemaName: "quality_review",
          model: input.model,
          timeoutMs: input.timeoutMs,
          // A review needs concise scores and defects, not a 4K-token essay.
          // This reduces latency and cost while still allowing several repairs.
          maxTokens: 1_200,
          // Qwen can spend the entire response budget in hidden thinking when
          // strict-schema mode is combined with two images. We retain local
          // Zod validation, while requesting compact generic JSON directly.
          strictSchema: false,
          disableReasoning: true,
        },
        config.OPENROUTER_API_KEY,
      );
    }
    throw new ProviderError(
      `No quality reviewer adapter for provider '${input.model.provider}'`,
      input.model.provider,
    );
  }

  async function secondReview(
    input: ReviewCandidateInput,
  ): Promise<ProviderResult<QualityReview>> {
    if (forceMock || input.model.provider === "mock") {
      return mockProvider.secondReview(input);
    }
    if (input.model.provider === "openrouter") {
      return openRouterChatJson(
        {
          systemPrompt: input.systemPrompt,
          userPrompt: [
            "You are the second reviewer. Final generated image is the LAST attached image; garment references come first.",
            "",
            `GARMENT TRUTH SHEET:\n${JSON.stringify(input.truthSheet)}`,
            "",
            `USER SELECTIONS:\n${JSON.stringify(input.userSelections)}`,
          ].join("\n"),
          images: [...input.originalReferences, input.candidate],
          schema: qualityReviewSchema,
          jsonSchema: qualityReviewJsonSchema,
          schemaName: "quality_review_adjudication",
          model: input.model,
          timeoutMs: input.timeoutMs,
          maxTokens: 1_200,
          strictSchema: false,
          disableReasoning: true,
        },
        config.OPENROUTER_API_KEY,
      );
    }
    throw new ProviderError(
      `No second reviewer adapter for provider '${input.model.provider}'`,
      input.model.provider,
    );
  }

  async function generateImage(input: GenerateImageInput): Promise<GenerateImageOutput> {
    if (forceMock || input.model.provider === "mock") {
      return mockProvider.generateImage(input);
    }
    if (input.model.provider === "openrouter") {
      return openRouterGenerateImage(input, config.OPENROUTER_API_KEY);
    }
    throw new ProviderError(
      `No image generator adapter for provider '${input.model.provider}'`,
      input.model.provider,
    );
  }

  return { analyzeGarment, reviewCandidate, secondReview, generateImage };
}

export type ResolvedProviders = ReturnType<typeof resolveProviders>;
