/**
 * Cost calculation — pure functions, no DB calls.
 * Price-version-aware: callers supply the active prices.
 */

export type UsageRecord = {
  inputTokens: number;
  outputTokens: number;
  imageCount: number;
  resolution?: string;
  /** USD cost reported by the provider (if any). */
  providerReportedCostUsd?: number | null;
};

export type PriceInfo = {
  inputPricePerM: number | null;
  outputPricePerM: number | null;
  /** { "1k": 0.04, "2k": 0.101, "4k": 0.151 } */
  imagePrices: Record<string, number> | null;
};

export type CostCalculation = {
  usdCost: number;
  fxRate: number;
  inrCost: number;
};

/**
 * Calculate cost for a single provider call.
 * If the provider reported a cost, use that directly.
 * Otherwise compute from tokens/images × configured prices.
 */
export function calculateCost(
  usage: UsageRecord,
  prices: PriceInfo,
  fxRate: number,
): CostCalculation {
  let usdCost = 0;

  if (usage.providerReportedCostUsd != null) {
    usdCost = usage.providerReportedCostUsd;
  } else {
    // Token-based pricing
    if (prices.inputPricePerM != null && usage.inputTokens > 0) {
      usdCost += (usage.inputTokens / 1_000_000) * prices.inputPricePerM;
    }
    if (prices.outputPricePerM != null && usage.outputTokens > 0) {
      usdCost += (usage.outputTokens / 1_000_000) * prices.outputPricePerM;
    }
    // Image-based pricing
    if (prices.imagePrices && usage.imageCount > 0 && usage.resolution) {
      const perImage = prices.imagePrices[usage.resolution] ?? 0;
      usdCost += usage.imageCount * perImage;
    }
  }

  return {
    usdCost: Math.round(usdCost * 1e8) / 1e8, // 8 decimal places
    fxRate,
    inrCost: Math.round(usdCost * fxRate * 100) / 100, // 2 decimal places
  };
}

/** Sum an array of cost calculations. */
export function sumCosts(costs: CostCalculation[]): CostCalculation {
  const totalUsd = costs.reduce((s, c) => s + c.usdCost, 0);
  const fx = costs[0]?.fxRate ?? 1;
  return {
    usdCost: Math.round(totalUsd * 1e8) / 1e8,
    fxRate: fx,
    inrCost: Math.round(totalUsd * fx * 100) / 100,
  };
}

/** Estimate the cost of the next generation attempt (image gen + QA). */
export function estimateNextAttemptCost(
  imageGenPrices: PriceInfo,
  qaPrices: PriceInfo,
  resolution: string,
  fxRate: number,
  avgImageInputTokens: number = 500,
  avgQaInputTokens: number = 2000,
  avgQaOutputTokens: number = 500,
): CostCalculation {
  const imageCost = calculateCost(
    { inputTokens: avgImageInputTokens, outputTokens: 0, imageCount: 1, resolution },
    imageGenPrices,
    fxRate,
  );
  const qaCost = calculateCost(
    { inputTokens: avgQaInputTokens, outputTokens: avgQaOutputTokens, imageCount: 0 },
    qaPrices,
    fxRate,
  );
  return sumCosts([imageCost, qaCost]);
}
