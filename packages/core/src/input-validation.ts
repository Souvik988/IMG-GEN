/**
 * Deterministic input image validation — cheap, no AI calls.
 * Returns usable/rejected with reasons.
 */

export type ImageValidationResult = {
  usable: boolean;
  reasons: string[];
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
  minDimension: number;
  maxDimension: number;
  blurThreshold: number;
  allowedMimeTypes: string[];
};

export const DEFAULT_VALIDATION_CONFIG: ValidationConfig = {
  maxBytes: 26_214_400, // 25 MB
  minDimension: 128,
  maxDimension: 10000,
  blurThreshold: 100, // below this = too blurry
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

  if (!config.allowedMimeTypes.includes(meta.mimeType)) {
    reasons.push(`Unsupported file type: ${meta.mimeType}`);
  }

  if (meta.sizeBytes > config.maxBytes) {
    reasons.push(`File too large: ${(meta.sizeBytes / 1_048_576).toFixed(1)} MB (max ${config.maxBytes / 1_048_576} MB)`);
  }

  if (meta.width < config.minDimension || meta.height < config.minDimension) {
    reasons.push(`Image too small: ${meta.width}x${meta.height} (min ${config.minDimension}px)`);
  }

  if (meta.width > config.maxDimension || meta.height > config.maxDimension) {
    reasons.push(`Image too large: ${meta.width}x${meta.height} (max ${config.maxDimension}px)`);
  }

  if (meta.blurVariance !== null && meta.blurVariance < config.blurThreshold) {
    reasons.push(`Image appears blurry (variance ${meta.blurVariance.toFixed(1)} < threshold ${config.blurThreshold})`);
  }

  return {
    usable: reasons.length === 0,
    reasons,
  };
}
