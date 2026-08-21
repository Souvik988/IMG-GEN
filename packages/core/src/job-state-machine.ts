/**
 * Deterministic job state machine.
 * All valid transitions are enumerated; everything else is illegal.
 */

export const JOB_STATES = [
  "created",
  "validating",
  "analyzing",
  "compiling",
  "generating",
  "reviewing",
  "retrying",
  "finalizing",
  "ready",
  "input_rejected",
  "failed",
  "budget_stopped",
  "manual_review",
  "cancelled",
] as const;

export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set([
  "ready",
  "input_rejected",
  "failed",
  "budget_stopped",
  "manual_review",
  "cancelled",
]);

/**
 * Maps each non-terminal state to the set of states it may transition to.
 * The worker must call canTransition() before mutating job state.
 */
const TRANSITIONS: Record<string, ReadonlySet<string>> = {
  created: new Set(["validating", "cancelled"]),
  validating: new Set(["analyzing", "input_rejected", "failed", "cancelled"]),
  analyzing: new Set(["compiling", "failed", "cancelled"]),
  compiling: new Set(["generating", "failed", "cancelled"]),
  generating: new Set(["reviewing", "failed", "cancelled"]),
  reviewing: new Set(["finalizing", "retrying", "manual_review", "failed", "cancelled"]),
  retrying: new Set(["generating", "budget_stopped", "failed", "cancelled"]),
  finalizing: new Set(["ready", "failed"]),
};

export function canTransition(from: string, to: string): boolean {
  return TRANSITIONS[from]?.has(to) ?? false;
}

export function transition(
  current: string,
  target: string,
): { ok: true } | { ok: false; error: string } {
  if (canTransition(current, target)) return { ok: true };
  if (TERMINAL_STATES.has(current as JobState)) {
    return { ok: false, error: `Job is terminal (${current}); no transitions allowed.` };
  }
  return {
    ok: false,
    error: `Invalid transition: ${current} → ${target}. Allowed: ${[...(TRANSITIONS[current] ?? [])].join(", ") || "none"}`,
  };
}

/** Mapping from internal states to customer-facing display labels. */
export const CUSTOMER_FACING_STATES: Record<string, { label: string; isTerminal: boolean }> = {
  created: { label: "Queued", isTerminal: false },
  validating: { label: "Checking references", isTerminal: false },
  analyzing: { label: "Preparing garment details", isTerminal: false },
  compiling: { label: "Preparing garment details", isTerminal: false },
  generating: { label: "Creating image", isTerminal: false },
  reviewing: { label: "Checking quality", isTerminal: false },
  retrying: { label: "Improving result", isTerminal: false },
  finalizing: { label: "Finalizing", isTerminal: false },
  ready: { label: "Ready", isTerminal: true },
  input_rejected: { label: "Input rejected", isTerminal: true },
  failed: { label: "Failed", isTerminal: true },
  budget_stopped: { label: "Failed", isTerminal: true },
  manual_review: { label: "Under review", isTerminal: true },
  cancelled: { label: "Cancelled", isTerminal: true },
};

export const jobStateTransitions = TRANSITIONS;
