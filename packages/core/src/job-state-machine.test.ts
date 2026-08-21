import { describe, it, expect } from "vitest";
import { canTransition, transition, TERMINAL_STATES, CUSTOMER_FACING_STATES } from "./job-state-machine";

describe("job state machine", () => {
  it("allows normal happy path", () => {
    const path = ["created","validating","analyzing","compiling","generating","reviewing","finalizing","ready"];
    let current = path[0];
    for (let i = 1; i < path.length; i++) {
      expect(canTransition(current, path[i])).toBe(true);
      current = path[i];
    }
  });

  it("allows retry loop", () => {
    expect(canTransition("reviewing", "retrying")).toBe(true);
    expect(canTransition("retrying", "generating")).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(canTransition("created", "generating")).toBe(false);
    expect(canTransition("ready", "generating")).toBe(false);
  });

  it("rejects transitions from terminal states", () => {
    for (const s of TERMINAL_STATES) {
      const r = transition(s, "generating");
      expect(r.ok).toBe(false);
    }
  });

  it("transition() returns error details", () => {
    const r = transition("validating", "generating");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Invalid transition");
    }
  });

  it("customer-facing states cover all job states", () => {
    for (const s of ["created","validating","analyzing","compiling","generating","reviewing","retrying","finalizing","ready","input_rejected","failed","budget_stopped","manual_review","cancelled"]) {
      expect(CUSTOMER_FACING_STATES[s]).toBeDefined();
    }
  });

  it("marks terminal states correctly for customers", () => {
    expect(CUSTOMER_FACING_STATES.ready.isTerminal).toBe(true);
    expect(CUSTOMER_FACING_STATES.created?.isTerminal).toBe(false);
    expect(CUSTOMER_FACING_STATES.generating?.isTerminal).toBe(false);
  });
});
