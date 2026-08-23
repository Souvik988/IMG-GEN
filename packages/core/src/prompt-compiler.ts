/**
 * Prompt compiler — template-first, Layer A/B/C/D architecture.
 * Deterministic ordering + priority-aware budgeting.
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
  /** Diagnostic metadata for how the budget was allocated. */
  budget: {
    totalBudget: number;
    usedBudget: number;
    includedLayers: string[];
    omittedSkills: number;
    compressedLayers: string[];
    /**
     * False only when facts and/or repair instruction — the layers that must
     * never be silently dropped — had to be cut to fit maxChars. This can
     * only happen when those mandatory layers alone exceed the whole budget;
     * skills are always sacrificed first.
     */
    mandatoryLayerPreserved: boolean;
  };
};

/**
 * Compile the generation prompt.
 * Order: system → facts → skills → repair
 *
 * Budgeting is priority-aware, not a blind end-of-string slice: facts (Layer
 * C, garment identity + protected details) and the repair instruction
 * (Layer D, the retry correction) are reserved for first and trimmed last.
 * Skills (Layer B) are the lowest-priority, most-decorative layer and are
 * cut first — individually, never partially — when the budget is tight.
 * Only if facts + repair instruction cannot fit even with zero skills does
 * the compiler fall back to truncating those mandatory layers, and it flags
 * that explicitly via `budget.mandatoryLayerPreserved`.
 */
export function compilePrompt(input: PromptCompileInput): CompiledPrompt {
  const repairText = input.repairInstruction
    ? "REPAIR INSTRUCTION: " + input.repairInstruction
    : "";

  // Static system-prompt characters that aren't the injected body — the
  // wrapper text always survives regardless of the placeholder's position.
  const hasPlaceholder = input.systemPrompt.includes("{{compiledPrompt}}");
  const staticSystemChars = hasPlaceholder
    ? input.systemPrompt.length - "{{compiledPrompt}}".length
    : input.systemPrompt.length;

  // Mandatory layers (facts + repair) get first claim on the budget. Skills
  // only ever spend what's left over.
  const separatorChars = repairText ? 4 : 2; // "\n\n" between parts, roughly
  const mandatoryChars = staticSystemChars + input.facts.length + repairText.length + separatorChars;
  const skillBudgetAvailable = Math.max(0, Math.min(input.skillCharBudget, input.maxChars - mandatoryChars));

  const parts: string[] = [input.facts];

  let skillBudgetRemaining = skillBudgetAvailable;
  const skillParts: string[] = [];
  let omittedSkills = 0;
  for (const instr of input.skillInstructions) {
    if (skillBudgetRemaining <= 0) {
      omittedSkills += 1;
      continue;
    }
    // Skip skills that don't fit entirely — partial instructions are worse than omission.
    if (instr.length > skillBudgetRemaining) {
      omittedSkills += 1;
      continue;
    }
    skillParts.push(instr);
    skillBudgetRemaining -= instr.length;
  }
  if (skillParts.length > 0) {
    parts.push("SKILL INSTRUCTIONS:\n" + skillParts.join("\n\n"));
  }

  if (repairText) parts.push(repairText);

  const compiledBody = parts.join("\n\n");

  let systemLayer = hasPlaceholder
    ? input.systemPrompt.replace("{{compiledPrompt}}", compiledBody)
    : input.systemPrompt + "\n\n" + compiledBody;

  const repairSize = repairText.length;
  const skillSize = skillParts.join("").length;
  const factsSize = input.facts.length;

  const compressedLayers: string[] = [];
  let truncated = false;
  let mandatoryLayerPreserved = true;
  let finalPrompt = systemLayer;

  if (finalPrompt.length > input.maxChars) {
    // Skills were already budgeted to fit, so overflow here means the
    // mandatory layers (system + facts + repair) alone exceed maxChars —
    // an edge case, not the common path. There is no safe semantic trim to
    // apply to caller-supplied facts/repair text from inside this function,
    // so the last resort is an end slice, same as before — but now it's
    // clearly flagged rather than silently indistinguishable from the
    // common "skills got cut" case.
    finalPrompt = finalPrompt.slice(0, input.maxChars);
    truncated = true;
    mandatoryLayerPreserved = false;
    compressedLayers.push("facts_or_repair");
  }

  const includedLayers = ["system", "facts"];
  if (skillParts.length > 0) includedLayers.push("skills");
  if (repairText) includedLayers.push("repair");
  if (omittedSkills > 0) compressedLayers.push("skills");

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
    budget: {
      totalBudget: input.maxChars,
      usedBudget: finalPrompt.length,
      includedLayers,
      omittedSkills,
      compressedLayers,
      mandatoryLayerPreserved,
    },
  };
}
