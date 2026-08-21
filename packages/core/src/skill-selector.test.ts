import { describe, it, expect } from "vitest";
import { selectSkills, type SkillRule } from "./skill-selector";

describe("skill selector", () => {
  const rules: SkillRule[] = [
    { skillId: "s1", skillVersionId: "sv1", priority: 80, conditions: [{ field: "always", op: "equals", value: true }] },
    { skillId: "s2", skillVersionId: "sv2", priority: 90, conditions: [{ field: "garmentType", op: "equals", value: "saree" }] },
    { skillId: "s3", skillVersionId: "sv3", priority: 60, conditions: [{ field: "environmentCategory", op: "equals", value: "outdoor" }] },
    { skillId: "s4", skillVersionId: "sv4", priority: 95, conditions: [{ field: "hasCharacterReference", op: "equals", value: true }] },
  ];

  it("selects always-active + matching skills, ordered by priority", () => {
    const ids = selectSkills(rules, {
      truthSheet: { garmentType: "saree" },
      selections: {},
    });
    // s1 (always,80) + s2 (saree,90) → ordered [s2,s1]
    expect(ids).toEqual(["sv2", "sv1"]);
  });

  it("matches environment from selections context", () => {
    const ids = selectSkills(rules, {
      truthSheet: { garmentType: "dress" },
      selections: { environmentCategory: "outdoor" },
    });
    expect(ids).toEqual(["sv1", "sv3"]);
  });

  it("respects maxSkills cap", () => {
    const ids = selectSkills(rules, {
      truthSheet: { garmentType: "saree" },
      selections: { hasCharacterReference: true, environmentCategory: "outdoor" },
    }, 2);
    expect(ids).toHaveLength(2);
    // top 2 by priority: s4(95), s2(90)
    expect(ids).toEqual(["sv4", "sv2"]);
  });

  it("returns empty when nothing matches", () => {
    const ids = selectSkills([], { truthSheet: { garmentType: "dress" }, selections: {} });
    expect(ids).toEqual([]);
  });
});
