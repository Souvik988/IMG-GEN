/**
 * Prompt compiler — template-first, Layer A/B/C/D architecture.
 * Deterministic ordering + hard character limit.
 */

export type PromptCompileInput = {
  /** Layer A: system instructions (image generation system prompt body). */
  systemPrompt: string;
  /** Layer B: skill instructions, already ordered by priority desc. */
  skillInstructions: string[];
  /** Layer C: structured job facts. */
  facts: string;
  /** Layer D: repair instructions (retry attempts only). */
  repairInstruction?: string;
  /** Maximum total character length for the compiled prompt. */
  maxChars: number;
  /** Budget for all skills combined. */
  skillCharBudget: number;
};

export type CompiledPrompt = {
  /** The final text sent to the image generator. */
  prompt: string;
  /** How many characters each layer contributed. */
  layerSizes: {
    system: number;
    skills: number;
    facts: number;
    repair: number;
    total: number;
  };
  /** Whether the prompt was truncated to fit. */
  truncated: boolean;
};

/**
 * Compile the generation prompt.
 * Order: system → facts → skills → repair
 * Skills are individually capped and collectively budgeted.
 * The system prompt variable {{compiledPrompt}} is replaced with the rest.
 */
export function compilePrompt(input: PromptCompileInput): CompiledPrompt {
  const parts: string[] = [];

  // Layer C: facts (most structured, always compact).
  parts.push(input.facts);

  // Layer B: skills — each individually capped, total budget enforced.
  let skillBudgetRemaining = input.skillCharBudget;
  const skillParts: string[] = [];
  for (const instr of input.skillInstructions) {
    if (skillBudgetRemaining <= 0) break;
    // Skip skills that don't fit entirely — partial instructions are worse than omission.
    if (instr.length > skillBudgetRemaining) continue;
    skillParts.push(instr);
    skillBudgetRemaining -= instr.length;
  }
  if (skillParts.length > 0) {
    parts.push("SKILL INSTRUCTIONS:\n" + skillParts.join("\n\n"));
  }

  // Layer D: repair (retry only).
  if (input.repairInstruction) {
    parts.push("REPAIR INSTRUCTION: " + input.repairInstruction);
  }

  const compiledBody = parts.join("\n\n");

  // Layer A: system prompt — substitute {{compiledPrompt}} if present.
  let systemLayer = input.systemPrompt;
  if (systemLayer.includes("{{compiledPrompt}}")) {
    systemLayer = systemLayer.replace("{{compiledPrompt}}", compiledBody);
  } else {
    systemLayer = input.systemPrompt + "\n\n" + compiledBody;
  }

  const repairSize = input.repairInstruction ? input.repairInstruction.length : 0;
  const skillSize = skillParts.join("").length;
  const factsSize = input.facts.length;

  // Truncate at maxChars if needed.
  let truncated = false;
  let finalPrompt = systemLayer;
  if (finalPrompt.length > input.maxChars) {
    finalPrompt = finalPrompt.slice(0, input.maxChars);
    truncated = true;
  }

  return {
    prompt: finalPrompt,
    layerSizes: {
      system: finalPrompt.length - skillSize - factsSize - repairSize,
      skills: skillSize,
      facts: factsSize,
      repair: repairSize,
      total: finalPrompt.length,
    },
    truncated,
  };
}
