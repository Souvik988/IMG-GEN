import { describe, it, expect } from "vitest";
import { evaluateRules, DEFAULT_RULE_CONFIG, type RuleConfig, type RuleResultDecision } from "./rule-engine";
import type { QualityReview } from "./schemas/quality-review";

function makeReview(overrides: Partial<QualityReview["scores"]> & {
  criticalDefects?: QualityReview["criticalDefects"];
  confidence?: number;
} = {}): QualityReview {
  return {
    scores: {
      garmentFidelity: 96,
      patternFidelity: 96,
      borderEmbroideryFidelity: 96,
      garmentStructure: 96,
      characterIdentity: 95,
      anatomy: 95,
      photorealism: 95,
      environment: 95,
      technicalQuality: 95,
      ...overrides,
    },
    criticalDefects: overrides.criticalDefects ?? [],
    minorDefects: [],
    repairInstruction: "",
    confidence: overrides.confidence ?? 85,
  };
}

describe("rule engine", () => {
  it("PASSes a review that meets all thresholds", () => {
    const r = evaluateRules(makeReview());
    expect(r.decision).toBe("PASS");
    expect(r.reasons).toHaveLength(0);
  });

  it("FAILs when garment fidelity is below threshold outside band", () => {
    const r = evaluateRules(makeReview({ garmentFidelity: 88 }));
    expect(r.decision).toBe("FAIL");
    expect(r.reasons[0]).toContain("Garment fidelity");
  });

  it("FAILs on any critical defect", () => {
    const r = evaluateRules(makeReview({
      criticalDefects: [{ code: "wrong_color", description: "Pallu is red, should be blue", repairHint: "Fix color" }],
    }));
    expect(r.decision).toBe("FAIL");
    expect(r.reasons[0]).toContain("wrong_color");
  });

  it("returns UNCERTAIN when score is within uncertainty band", () => {
    const config: RuleConfig = { ...DEFAULT_RULE_CONFIG, uncertaintyBand: 3 };
    // threshold 94, score 92 → gap 2, within band 3
    const r = evaluateRules(makeReview({ garmentFidelity: 92 }), config);
    expect(r.decision).toBe("UNCERTAIN");
  });

  it("returns UNCERTAIN when reviewer confidence is low", () => {
    const r = evaluateRules(makeReview({ confidence: 50 }));
    expect(r.decision).toBe("UNCERTAIN");
  });

  it("FAILs when multiple thresholds are breached outside band", () => {
    const r = evaluateRules(makeReview({ photorealism: 80, anatomy: 85 }));
    expect(r.decision).toBe("FAIL");
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it("returns garmentScore", () => {
    const r = evaluateRules(makeReview({ garmentFidelity: 91 }));
    expect(r.garmentScore).toBe(91);
  });
});
