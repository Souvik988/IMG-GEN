/**
 * Deterministic rule engine — this code, not a prompt, makes PASS/FAIL/UNCERTAIN.
 * Thresholds come from budget_rules (admin-configurable, stored in DB).
 */

import type { QualityReview } from "./schemas/quality-review";

export type RuleResultDecision = "PASS" | "FAIL" | "UNCERTAIN";

export type RuleConfig = {
  minGarmentFidelity: number;
  minCharacterIdentity: number;
  minPhotorealism: number;
  minAnatomy: number;
  minTechnicalQuality: number;
  uncertaintyBand: number;
  minReviewerConfidence: number;
  hardFailDefectCodes: string[];
};

export type RuleResult = {
  decision: RuleResultDecision;
  reasons: string[];
  garmentScore: number;
};

/** Default thresholds matching the seeded budget_rules row. */
export const DEFAULT_RULE_CONFIG: RuleConfig = {
  minGarmentFidelity: 94,
  minCharacterIdentity: 90,
  minPhotorealism: 92,
  minAnatomy: 90,
  minTechnicalQuality: 88,
  uncertaintyBand: 3,
  minReviewerConfidence: 70,
  hardFailDefectCodes: [],
};

/**
 * Evaluate a quality review against deterministic thresholds.
 * Returns PASS, FAIL, or UNCERTAIN with human-readable reasons.
 */
export function evaluateRules(
  review: QualityReview,
  config: RuleConfig = DEFAULT_RULE_CONFIG,
): RuleResult {
  const { scores, criticalDefects, minorDefects, confidence } = review;
  const reasons: string[] = [];

  // Any defect the reviewer itself classified as critical is an automatic
  // FAIL, independent of aggregate score.
  for (const d of criticalDefects) {
    reasons.push(`Critical defect: ${d.code} — ${d.description}`);
  }

  // Hard-fail codes are a system-level override on top of the reviewer's own
  // judgment: some defect types (wrong garment color, changed logo, broken
  // anatomy, ...) must always fail even if this particular reviewer call
  // classified them as minor. This is what makes hardFailDefectCodes
  // meaningful — critical defects already fail regardless of this list.
  for (const d of minorDefects) {
    if (config.hardFailDefectCodes.includes(d.code)) {
      reasons.push(`Hard-fail defect (configured as always-critical): ${d.code} — ${d.description}`);
    }
  }

  if (reasons.length > 0) {
    return { decision: "FAIL", reasons, garmentScore: scores.garmentFidelity };
  }

  // Score thresholds.
  const checks: [string, number, number][] = [
    ["Garment fidelity", scores.garmentFidelity, config.minGarmentFidelity],
    ["Character identity", scores.characterIdentity, config.minCharacterIdentity],
    ["Photorealism", scores.photorealism, config.minPhotorealism],
    ["Anatomy", scores.anatomy, config.minAnatomy],
    ["Technical quality", scores.technicalQuality, config.minTechnicalQuality],
  ];

  let allPass = true;
  let anyUncertain = false;

  for (const [label, score, min] of checks) {
    if (score < min) {
      const gap = min - score;
      if (gap <= config.uncertaintyBand) {
        anyUncertain = true;
        reasons.push(`${label} ${score} is ${gap} below threshold ${min} (within uncertainty band)`);
      } else {
        allPass = false;
        reasons.push(`${label} ${score} is ${gap} below threshold ${min}`);
      }
    }
  }

  // Low reviewer confidence pushes toward UNCERTAIN instead of PASS.
  if (confidence < config.minReviewerConfidence) {
    anyUncertain = true;
    reasons.push(`Reviewer confidence ${confidence} is below ${config.minReviewerConfidence}`);
  }

  if (!allPass) {
    return { decision: "FAIL", reasons, garmentScore: scores.garmentFidelity };
  }
  if (anyUncertain) {
    return { decision: "UNCERTAIN", reasons, garmentScore: scores.garmentFidelity };
  }

  return { decision: "PASS", reasons: [], garmentScore: scores.garmentFidelity };
}
