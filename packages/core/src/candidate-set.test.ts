import { describe, expect, it } from "vitest";
import { rollUpSetDecision, selectDeliverableCandidates, type CandidateOutcome } from "./candidate-set";

function candidate(overrides: Partial<CandidateOutcome> = {}): CandidateOutcome {
  return {
    isAnchor: false,
    cameraAngle: null,
    decision: "PASS",
    decisionReasons: [],
    ...overrides,
  };
}

describe("rollUpSetDecision", () => {
  it("throws rather than silently deciding when nothing has been reviewed", () => {
    const unreviewed = [candidate({ decision: null }), candidate({ decision: null })];
    expect(() => rollUpSetDecision(unreviewed)).toThrow();
  });

  it("PASSes a single-candidate job when its own decision is PASS", () => {
    const result = rollUpSetDecision([candidate({ isAnchor: true, decision: "PASS" })]);
    expect(result.decision).toBe("PASS");
  });

  it("FAILs the whole set when the anchor fails, even if other angles passed", () => {
    const result = rollUpSetDecision([
      candidate({ isAnchor: true, decision: "FAIL", cameraAngle: "front" }),
      candidate({ decision: "PASS", cameraAngle: "back" }),
    ]);
    expect(result.decision).toBe("FAIL");
  });

  it("is UNCERTAIN when the anchor itself is uncertain", () => {
    const result = rollUpSetDecision([
      candidate({ isAnchor: true, decision: "UNCERTAIN", cameraAngle: "front" }),
    ]);
    expect(result.decision).toBe("UNCERTAIN");
  });

  it("is UNCERTAIN when the anchor passed but a non-anchor angle is uncertain", () => {
    const result = rollUpSetDecision([
      candidate({ isAnchor: true, decision: "PASS", cameraAngle: "front" }),
      candidate({ decision: "UNCERTAIN", cameraAngle: "back" }),
    ]);
    expect(result.decision).toBe("UNCERTAIN");
  });

  it("PASSes the set when the anchor passed even if a non-anchor angle failed", () => {
    const result = rollUpSetDecision([
      candidate({ isAnchor: true, decision: "PASS", cameraAngle: "front" }),
      candidate({ decision: "FAIL", cameraAngle: "back" }),
    ]);
    expect(result.decision).toBe("PASS");
    expect(result.reasons[0]).toContain("withheld");
  });

  it("ignores candidates that were never reviewed when finding the anchor fallback", () => {
    // A candidate array where the anchor slot itself is unreviewed (defensive
    // case) must not crash — it falls back to the first reviewed candidate.
    const result = rollUpSetDecision([
      candidate({ isAnchor: true, decision: null, cameraAngle: "front" }),
      candidate({ decision: "PASS", cameraAngle: "back" }),
    ]);
    expect(result.decision).toBe("PASS");
  });
});

describe("selectDeliverableCandidates — the core P0-1 safety invariant", () => {
  it("never delivers a candidate with a null (unreviewed) decision", () => {
    const candidates = [
      { id: "a", decision: "PASS" as const },
      { id: "b", decision: null },
      { id: "c", decision: "PASS" as const },
    ];
    const deliverable = selectDeliverableCandidates(candidates);
    expect(deliverable.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("never delivers a candidate stuck at UNCERTAIN", () => {
    const candidates = [
      { id: "a", decision: "PASS" as const },
      { id: "b", decision: "UNCERTAIN" as const },
    ];
    expect(selectDeliverableCandidates(candidates).map((c) => c.id)).toEqual(["a"]);
  });

  it("never delivers a candidate that FAILed", () => {
    const candidates = [
      { id: "a", decision: "PASS" as const },
      { id: "b", decision: "FAIL" as const },
    ];
    expect(selectDeliverableCandidates(candidates).map((c) => c.id)).toEqual(["a"]);
  });

  it("delivers nothing when nothing explicitly passed", () => {
    const candidates = [
      { id: "a", decision: null },
      { id: "b", decision: "UNCERTAIN" as const },
      { id: "c", decision: "FAIL" as const },
    ];
    expect(selectDeliverableCandidates(candidates)).toEqual([]);
  });
});
