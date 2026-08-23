/**
 * Workflow execution context.
 * Carries all mutable state through the node chain for a single job attempt.
 */

import type {
  Asset,
  BudgetRules,
  Character,
  CostEvent,
  EnvironmentPreset,
  GenerationCandidate,
  Job,
  JobAttempt,
  JobStepRun,
  ModelPriceVersion,
  ModelRegistry,
  PromptVersion,
  SkillVersion,
  WorkflowNode,
  WorkflowNodeConfig,
  WorkflowVersion,
} from "@shotlin/database";
import type { GarmentTruthSheet, QualityReview, RuleResultDecision } from "@shotlin/core";

/** Flattened skill rules with resolved skill version ids + priority. */
export type ResolvedSkillRule = {
  id: string;
  skillId: string;
  description: string | null;
  conditions: Array<{ field: string; op: string; value: unknown }>;
  isEnabled: boolean;
  createdAt: Date;
  skillVersionId: string;
  priority: number;
};

/** The mutable context threaded through every node in the pipeline. */
export interface WorkflowContext {
  // --- immutable job data (loaded once) ---
  job: Job;
  workflowVersion: WorkflowVersion;
  workflowNodes: Array<WorkflowNode & { config: WorkflowNodeConfig }>;
  budgetRules: BudgetRules;
  fxRate: number;

  // --- per-attempt state ---
  attempt: JobAttempt;
  attemptNumber: number;
  selectedSkillVersionIds: string[];
  skillInstructions: string[];
  compiledPrompt: string;
  ruleDecision: RuleResultDecision | null;
  ruleReasons: string[];

  // --- vision output (set once, reused on retries) ---
  truthSheet: GarmentTruthSheet | null;
  truthSheetPromptVersionId: string | null;
  truthSheetModelId: string | null;

  // --- generation output ---
  candidates: Array<{
    candidate: GenerationCandidate;
    qualityReview: QualityReview | null;
    secondReview: QualityReview | null;
    /** This candidate's own PASS/FAIL/UNCERTAIN outcome. Null = not yet reviewed. */
    decision: RuleResultDecision | null;
    decisionReasons: string[];
  }>;
  finalCandidate: GenerationCandidate | null;

  // --- accumulated costs ---
  totalCostUsd: number;
  totalCostInr: number;
  costEvents: CostEvent[];

  // --- step tracking ---
  currentStep: StepRecord | null;

  // --- character / environment ---
  character: Character | null;
  environment: EnvironmentPreset | null;

  // --- model lookup cache ---
  modelsByRole: Map<string, ModelRegistry>;
  priceVersionsByModelId: Map<string, ModelPriceVersion>;
  promptVersionsById: Map<string, PromptVersion>;
  skillVersionsById: Map<string, SkillVersion>;
  skillRules: ResolvedSkillRule[];
}

export interface StepRecord {
  stepRunId: string;
  nodeKey: string;
  startedAt: Date;
}
