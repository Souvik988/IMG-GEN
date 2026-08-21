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
});
