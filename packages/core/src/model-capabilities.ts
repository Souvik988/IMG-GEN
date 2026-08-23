/**
 * Pre-flight validation against a model's declared capabilities
 * (`model_registry.capabilities`), so a request doomed to fail — or to
 * silently drop reference images a provider can't accept — is rejected
 * *before* spending on it, not discovered from a confusing provider error
 * after the fact.
 *
 * Every field is optional: a model with no declared constraint for a given
 * dimension is treated as unconstrained on it, not as failing the check.
 * This matters because `capabilities` is admin-editable free-form JSON —
 * an incomplete or newly-added model shouldn't become unusable just
 * because nobody has filled in every field yet.
 */
export type ModelCapabilities = {
  maxImageRefs?: number;
  resolutions?: string[];
  supportsMultiOutput?: boolean;
};

export type GenerationRequestShape = {
  referenceCount: number;
  resolution: string;
  count: number;
};

export type CapabilityCheckResult = { valid: true } | { valid: false; reason: string };

/** Best-effort parse of the free-form `capabilities` JSON column. Unknown/malformed shapes degrade to "unconstrained", never to a thrown error. */
export function parseModelCapabilities(raw: unknown): ModelCapabilities {
  if (!raw || typeof raw !== "object") return {};
  const value = raw as Record<string, unknown>;
  const result: ModelCapabilities = {};
  if (typeof value.maxImageRefs === "number" && value.maxImageRefs > 0) {
    result.maxImageRefs = value.maxImageRefs;
  }
  if (Array.isArray(value.resolutions) && value.resolutions.every((r) => typeof r === "string")) {
    result.resolutions = value.resolutions as string[];
  }
  if (typeof value.supportsMultiOutput === "boolean") {
    result.supportsMultiOutput = value.supportsMultiOutput;
  }
  return result;
}

export function checkModelCapabilities(
  capabilities: ModelCapabilities,
  request: GenerationRequestShape,
): CapabilityCheckResult {
  if (capabilities.maxImageRefs != null && request.referenceCount > capabilities.maxImageRefs) {
    return {
      valid: false,
      reason: `This model accepts at most ${capabilities.maxImageRefs} reference image(s), but ${request.referenceCount} were provided.`,
    };
  }
  if (
    capabilities.resolutions &&
    capabilities.resolutions.length > 0 &&
    !capabilities.resolutions.includes(request.resolution)
  ) {
    return {
      valid: false,
      reason: `This model does not support resolution "${request.resolution}" (supports: ${capabilities.resolutions.join(", ")}).`,
    };
  }
  if (request.count > 1 && capabilities.supportsMultiOutput === false) {
    return {
      valid: false,
      reason: `This model does not support generating more than one image per request.`,
    };
  }
  return { valid: true };
}
