import { describe, it, expect } from "vitest";
import { compilePrompt } from "./prompt-compiler";

describe("prompt compiler", () => {
  const systemPrompt =
    "You are a fashion image generator.\n{{compiledPrompt}}";

  it("substitutes compiledPrompt in system prompt", () => {
    const result = compilePrompt({
      systemPrompt,
      skillInstructions: ["Skill A text."],
      facts: "Garment: red saree.",
      maxChars: 10000,
      skillCharBudget: 4000,
    });
    expect(result.prompt).toContain("Garment: red saree.");
    expect(result.prompt).toContain("Skill A text.");
    expect(result.prompt).not.toContain("{{compiledPrompt}}");
  });

  it("appends body when no template variable", () => {
    const result = compilePrompt({
      systemPrompt: "Generate a fashion image.",
      skillInstructions: [],
      facts: "Red kurta.",
      maxChars: 10000,
      skillCharBudget: 4000,
    });
    expect(result.prompt).toContain("Generate a fashion image.");
    expect(result.prompt).toContain("Red kurta.");
  });

  it("includes repair instruction for retries", () => {
    const result = compilePrompt({
      systemPrompt,
      skillInstructions: [],
      facts: "Blue dress.",
      repairInstruction: "Fix the neckline shape to be round, not V-shaped.",
      maxChars: 10000,
      skillCharBudget: 4000,
    });
    expect(result.prompt).toContain("REPAIR INSTRUCTION");
    expect(result.prompt).toContain("neckline");
    expect(result.layerSizes.repair).toBeGreaterThan(0);
  });

  it("truncates when exceeding maxChars", () => {
    const longFacts = "X".repeat(8000);
    const result = compilePrompt({
      systemPrompt,
      skillInstructions: ["Y".repeat(4000)],
      facts: longFacts,
      maxChars: 6000,
      skillCharBudget: 2000,
    });
    expect(result.truncated).toBe(true);
    expect(result.prompt.length).toBeLessThanOrEqual(6000);
  });

  it("respects skill budget and cuts skills", () => {
    const result = compilePrompt({
      systemPrompt,
      skillInstructions: ["A".repeat(1500), "B".repeat(1500)],
      facts: "Facts.",
      maxChars: 10000,
      skillCharBudget: 2000,
    });
    // Only first skill fits in 2000 budget
    expect(result.prompt).toContain("A".repeat(1500));
    expect(result.layerSizes.skills).toBeLessThanOrEqual(2000);
  });

  it("never drops the repair instruction to make room for skills — the bug this rewrite fixes", () => {
    // Facts + repair comfortably fit; skills alone would blow the budget.
    // The old implementation assembled system+facts+skills+repair as one
    // string and end-sliced at maxChars — since repair was appended last,
    // it was the first thing cut. This must no longer happen: skills should
    // be trimmed instead, and the repair instruction must survive intact.
    const result = compilePrompt({
      systemPrompt,
      skillInstructions: ["S".repeat(3000), "S".repeat(3000), "S".repeat(3000)],
      facts: "GARMENT TYPE: SAREE. PROTECTED DETAILS: gold zari border, 4-inch width.",
      repairInstruction: "Fix the border pattern — it must be a continuous gold zari motif, not broken segments.",
      maxChars: 1500,
      skillCharBudget: 9000,
    });
    expect(result.prompt).toContain("REPAIR INSTRUCTION");
    expect(result.prompt).toContain("continuous gold zari motif");
    expect(result.prompt).toContain("PROTECTED DETAILS");
    expect(result.budget.mandatoryLayerPreserved).toBe(true);
    expect(result.prompt.length).toBeLessThanOrEqual(1500);
  });

  it("flags mandatoryLayerPreserved=false only when facts+repair alone exceed the budget", () => {
    const longFacts = "X".repeat(8000);
    const result = compilePrompt({
      systemPrompt,
      skillInstructions: ["Y".repeat(4000)],
      facts: longFacts,
      maxChars: 6000,
      skillCharBudget: 2000,
    });
    expect(result.truncated).toBe(true);
    expect(result.budget.mandatoryLayerPreserved).toBe(false);
    expect(result.budget.compressedLayers).toContain("facts_or_repair");
  });

  it("omits whole skills rather than truncating one partway", () => {
    const result = compilePrompt({
      systemPrompt,
      skillInstructions: ["A".repeat(1500), "B".repeat(1500), "C".repeat(1500)],
      facts: "Facts.",
      maxChars: 10000,
      skillCharBudget: 2000,
    });
    // Any skill block present in the output must appear whole (a 1500-char
    // run of the same letter), never a partial/truncated fragment.
    for (const skill of ["A", "B", "C"]) {
      const full = skill.repeat(1500);
      const idx = result.prompt.indexOf(full);
      const partial = new RegExp(`${skill}{100,1499}(?!${skill})`).test(result.prompt);
      expect(idx !== -1 || !partial).toBe(true);
    }
    expect(result.budget.omittedSkills).toBeGreaterThan(0);
  });

  it("reports which layers were included and compressed", () => {
    const result = compilePrompt({
      systemPrompt,
      skillInstructions: ["Skill A."],
      facts: "Facts.",
      repairInstruction: "Fix it.",
      maxChars: 10000,
      skillCharBudget: 4000,
    });
    expect(result.budget.includedLayers).toEqual(
      expect.arrayContaining(["system", "facts", "skills", "repair"]),
    );
    expect(result.budget.compressedLayers).toEqual([]);
    expect(result.budget.totalBudget).toBe(10000);
  });
});
