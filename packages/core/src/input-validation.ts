/**
 * Deterministic input image validation — cheap, no AI calls.
 *
 * Split into two tiers, deliberately:
 * - `reasons` (hard failures) reject the job outright — reserved for images
 *   with no usable signal at all: wrong file type, corrupted, oversized, or
 *   so small there's nothing for a vision model to work with.
 * - `warnings` (soft signals) never block the job. A too-small-but-decodable
 *   image gets auto-upscaled by the caller instead of rejected; a blurry
 *   image proceeds with a flag so the vision step can tell the model to use
 *   best judgment rather than pretending the source is pixel-perfect. A
 *   blind pixel heuristic is a much worse judge of "is this usable" than a
 *   vision model that's actually looked at the photo — this validator's job
 *   is to filter out the genuinely hopeless cases, not to second-guess
 *   everything else.
 */

export type ImageValidationResult = {
  usable: boolean;
  reasons: string[];
  warnings: string[];
  needsUpscale: boolean;
};

export type ImageMeta = {
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  /** Pre-computed blur metric (variance of Laplacian). Null means not computed. */
  blurVariance: number | null;
};

export type ValidationConfig = {
  maxBytes: number;
  /** Below this, the image is upscaled (if decodable) rather than rejected. */
  minDimension: number;
  /** Below this, no amount of upscaling helps — there's no real signal left. Not admin-configurable. */
  absoluteMinDimension: number;
  maxDimension: number;
  blurThreshold: number;
  allowedMimeTypes: string[];
};

export const DEFAULT_VALIDATION_CONFIG: ValidationConfig = {
  maxBytes: 26_214_400, // 25 MB
  minDimension: 512,
  absoluteMinDimension: 128,
  maxDimension: 10000,
  blurThreshold: 100, // below this = flagged as blurry (soft warning, not a rejection)
  allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
};

/**
 * Pure deterministic validation from already-extracted metadata.
 * The platform layer handles sharp/decode; this just evaluates numbers.
 */
export function validateImageInput(
  meta: ImageMeta,
  config: ValidationConfig = DEFAULT_VALIDATION_CONFIG,
): ImageValidationResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  let needsUpscale = false;

  if (!config.allowedMimeTypes.includes(meta.mimeType)) {
    reasons.push(`Unsupported file type: ${meta.mimeType}`);
  }

  if (meta.sizeBytes > config.maxBytes) {
    reasons.push(`File too large: ${(meta.sizeBytes / 1_048_576).toFixed(1)} MB (max ${config.maxBytes / 1_048_576} MB)`);
  }

  if (meta.width < config.absoluteMinDimension || meta.height < config.absoluteMinDimension) {
    reasons.push(`Image too small to use: ${meta.width}x${meta.height} (min ${config.absoluteMinDimension}px)`);
  } else if (meta.width < config.minDimension || meta.height < config.minDimension) {
    needsUpscale = true;
    warnings.push(`Image below ideal size (${meta.width}x${meta.height}, target ${config.minDimension}px) — upscaled automatically`);
  }

  if (meta.width > config.maxDimension || meta.height > config.maxDimension) {
    reasons.push(`Image too large: ${meta.width}x${meta.height} (max ${config.maxDimension}px)`);
  }

  if (meta.blurVariance !== null && meta.blurVariance < config.blurThreshold) {
    warnings.push(`Image appears soft/blurry (sharpness ${meta.blurVariance.toFixed(1)} below the ${config.blurThreshold} reference level)`);
  }

  return {
    usable: reasons.length === 0,
    reasons,
    warnings,
    needsUpscale,
  };
}
