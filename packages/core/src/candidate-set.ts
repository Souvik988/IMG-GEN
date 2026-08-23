import type { RuleResultDecision } from "./rule-engine";

export type CandidateOutcome = {
  isAnchor: boolean;
  cameraAngle: string | null;
  /** Null means not yet reviewed. */
  decision: RuleResultDecision | null;
  decisionReasons: string[];
};

export type SetDecision = {
  decision: RuleResultDecision;
  reasons: string[];
};

/**
 * Roll a set of individually-reviewed candidates (one anchor plus any
 * fan-out angles) up into the single job-level decision that drives the
 * retry / second-review / finalize state machine.
 *
 * Invariant this function exists to protect: a candidate whose `decision` is
 * still null (never reviewed) must never cause a PASS roll-up — an unreviewed
 * image is not an approved image.
 */
export function rollUpSetDecision(candidates: readonly CandidateOutcome[]): SetDecision {
  const reviewed = candidates.filter((c) => c.decision !== null);
  if (reviewed.length === 0) {
    throw new Error("rollUpSetDecision requires at least one reviewed candidate");
  }

  const anchor = reviewed.find((c) => c.isAnchor) ?? reviewed[0];

  if (anchor.decision === "FAIL") {
    return {
      decision: "FAIL",
      reasons: [`anchor failed: ${anchor.decisionReasons.join("; ")}`],
    };
  }

  if (anchor.decision === "UNCERTAIN") {
    return {
      decision: "UNCERTAIN",
      reasons: [`anchor uncertain: ${anchor.decisionReasons.join("; ")}`],
    };
  }

  const uncertain = reviewed.filter((c) => c.decision === "UNCERTAIN");
  if (uncertain.length > 0) {
    return {
      decision: "UNCERTAIN",
      reasons: uncertain.map(
        (c) => `${c.cameraAngle ?? "image"}: ${c.decisionReasons.join("; ")}`,
      ),
    };
  }

  // Anchor passed and nothing is uncertain. Non-anchor FAILs are withheld at
  // finalize rather than failing the whole job — one bad angle should not
  // block delivery of the angles that did pass.
  const failed = reviewed.filter((c) => c.decision === "FAIL");
  return {
    decision: "PASS",
    reasons: failed.length
      ? [
          `anchor passed; ${failed.length} angle(s) withheld: ${failed
            .map((c) => c.cameraAngle ?? "image")
            .join(", ")}`,
        ]
      : ["all candidates passed"],
  };
}

/**
 * Which candidates may actually be delivered to the customer, given the
 * roll-up above already ran. Only an explicit per-candidate PASS qualifies —
 * null (unreviewed) and UNCERTAIN (never resolved) are both excluded.
 */
export function selectDeliverableCandidates<T extends { decision: RuleResultDecision | null }>(
  candidates: readonly T[],
): T[] {
  return candidates.filter((c) => c.decision === "PASS");
}
