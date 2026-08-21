/**
 * Deterministic skill selector.
 * Evaluates skill_rules against the truth sheet + user selections.
 * Returns ordered skill version IDs (by priority desc).
 */

export type SkillRule = {
  skillId: string;
  skillVersionId: string;
  priority: number;
  conditions: Array<{ field: string; op: string; value: unknown }>;
};

export type SkillMatchContext = {
  /** Flattened truth-sheet fields for condition matching. */
 truthSheet: Record<string, unknown>;
  /** User selections and runtime flags. */
 selections: Record<string, unknown>;
};

function evaluateCondition(
  field: string,
  op: string,
  value: unknown,
  ctx: Record<string, unknown>,
): boolean {
  // Special literal "always" field.
  if (field === "always" && op === "equals" && value === true) return true;

  const actual = ctx[field];
  if (actual === undefined) return false;

  switch (op) {
    case "equals":
      return actual === value;
    case "not_equals":
      return actual !== value;
    case "in":
      return Array.isArray(value) && value.includes(actual);
    case "not_null":
      return actual != null;
    case "gt":
      return typeof actual === "number" && actual > (value as number);
    case "gte":
      return typeof actual === "number" && actual >= (value as number);
    default:
      return false;
  }
}

function ruleMatches(rule: SkillRule, ctx: Record<string, unknown>): boolean {
  return rule.conditions.every((c) => evaluateCondition(c.field, c.op, c.value, ctx));
}

/**
 * Select matching skills ordered by priority (highest first), capped at maxSkills.
 */
export function selectSkills(
  allRules: SkillRule[],
  context: SkillMatchContext,
  maxSkills: number = 6,
): string[] {
  const merged: Record<string, unknown> = {
    ...context.truthSheet,
    ...context.selections,
  };

  const matched = allRules.filter((r) => ruleMatches(r, merged));

  // Deduplicate by skillId (keep highest priority / first occurrence).
  const seen = new Set<string>();
  const unique: SkillRule[] = [];
  for (const r of matched) {
    if (!seen.has(r.skillId)) {
      seen.add(r.skillId);
      unique.push(r);
    }
  }

  // Sort by priority descending.
  unique.sort((a, b) => b.priority - a.priority);

  return unique.slice(0, maxSkills).map((r) => r.skillVersionId);
}
