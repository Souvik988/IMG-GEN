import { describe, it, expect } from "vitest";
import { calculateCost, sumCosts, estimateNextAttemptCost } from "./cost-engine";

describe("cost engine", () => {
  const fxRate = 95.78;
  const tokenPrices = { inputPricePerM: 0.14, outputPricePerM: 1.0, imagePrices: null };
  const imagePrices = { inputPricePerM: null, outputPricePerM: null, imagePrices: { "1k": 0.04, "2k": 0.101, "4k": 0.151 } };

  it("calculates token-based cost", () => {
    const c = calculateCost(
      { inputTokens: 1_000_000, outputTokens: 500_000, imageCount: 0 },
      tokenPrices,
      fxRate,
    );
    expect(c.usdCost).toBeCloseTo(0.64, 6);
    expect(c.inrCost).toBeCloseTo(61.3, 1);
  });

  it("calculates image-based cost for 2K", () => {
    const c = calculateCost(
      { inputTokens: 500, outputTokens: 0, imageCount: 1, resolution: "2k" },
      imagePrices,
      fxRate,
    );
    expect(c.usdCost).toBe(0.101);
    expect(c.inrCost).toBeCloseTo(9.67, 2);
  });

  it("prefers provider-reported cost when given", () => {
    const c = calculateCost(
      { inputTokens: 0, outputTokens: 0, imageCount: 1, resolution: "2k", providerReportedCostUsd: 0.15 },
      imagePrices,
      fxRate,
    );
    expect(c.usdCost).toBe(0.15);
  });

  it("preserves a provider-reported zero-cost call", () => {
    const c = calculateCost(
      { inputTokens: 1000, outputTokens: 500, imageCount: 0, providerReportedCostUsd: 0 },
      tokenPrices,
      fxRate,
    );
    expect(c.usdCost).toBe(0);
    expect(c.inrCost).toBe(0);
  });

  it("sums multiple cost calculations", () => {
    const costs = [
      calculateCost({ inputTokens: 1_000_000, outputTokens: 0, imageCount: 0 }, tokenPrices, fxRate),
      calculateCost({ inputTokens: 0, outputTokens: 1_000_000, imageCount: 0 }, tokenPrices, fxRate),
    ];
    const total = sumCosts(costs);
    expect(total.usdCost).toBeCloseTo(1.14, 6);
  });

  it("estimates next attempt cost", () => {
    const est = estimateNextAttemptCost(imagePrices, tokenPrices, "2k", fxRate);
    // image 0.101 + QA ~0.0007 ≈ 0.102
    expect(est.usdCost).toBeGreaterThan(0.10);
    expect(est.usdCost).toBeLessThan(0.12);
  });
});
