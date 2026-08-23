import sharp from "sharp";

export type ExtractedImageMeta = {
  width: number;
  height: number;
  mimeType: string;
  sizeBytes: number;
  blurVariance: number | null;
};

// A compressed file's byte size says nothing about its decoded pixel count
// — a small, deliberately crafted image can still expand to a huge raw
// bitmap on decode ("decompression bomb"). 50 megapixels is far beyond any
// real garment photo (a 45MP DSLR shot is ~8200x5500) but caps sharp's
// worst-case allocation well below sharp's own default ceiling (~268MP),
// which matters on a memory-constrained host.
const MAX_DECODE_PIXELS = 50_000_000;

/**
 * Decode an image buffer and extract deterministic metadata.
 * Throws on corrupted images (sharp fails to decode) or images that exceed
 * the pixel-count ceiling above.
 */
export async function extractImageMeta(buffer: Buffer): Promise<ExtractedImageMeta> {
  const image = sharp(buffer, { failOn: "error", limitInputPixels: MAX_DECODE_PIXELS });
  const meta = await image.metadata();
  if (!meta.width || !meta.height) {
    throw new Error("Could not read image dimensions");
  }
  const blurVariance = await estimateBlurVariance(buffer);
  const mimeType = meta.format === "jpeg" ? "image/jpeg"
    : meta.format === "png" ? "image/png"
    : meta.format === "webp" ? "image/webp"
    : `image/${meta.format}`;
  return { width: meta.width, height: meta.height, mimeType, sizeBytes: buffer.length, blurVariance };
}

/**
 * Estimate blur via variance of the Laplacian on a downscaled grayscale version.
 * Higher variance = sharper. Returns null when it cannot be computed.
 */
export async function estimateBlurVariance(buffer: Buffer): Promise<number | null> {
  try {
    const { data, info } = await sharp(buffer)
      .grayscale()
      .resize(256, 256, { fit: "inside" })
      .convolve({
        width: 3,
        height: 3,
        kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0],
        // Keep the signed Laplacian inside the 8-bit raw output range.
        // Without this offset/scale, sharp clips negative responses to 0,
        // making every image appear to have zero edge variance.
        scale: 4,
        offset: 128,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const n = info.width * info.height;
    if (n === 0) return null;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += data[i];
    const mean = sum / n;
    let variance = 0;
    for (let i = 0; i < n; i++) {
      const d = data[i] - mean;
      variance += d * d;
    }
    return variance / n;
  } catch {
    return null;
  }
}

/**
 * Upscale an image so neither dimension is below `minDimension`, preserving
 * aspect ratio and output format. A no-op (returns the original buffer,
 * untouched) if the image already meets the target — this never downscales.
 *
 * This is plain interpolation (Lanczos3): it makes an undersized reference
 * technically usable and visually less jarring, but it cannot recover detail
 * that was never captured. It does not fix blur — that needs a real
 * deblur/super-resolution model, which this function deliberately doesn't
 * attempt.
 */
export async function upscaleToMinDimension(
  buffer: Buffer,
  mimeType: string,
  minDimension: number,
): Promise<{ data: Buffer; width: number; height: number } | null> {
  const meta = await sharp(buffer).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width === 0 || height === 0) return null;

  const scale = minDimension / Math.min(width, height);
  if (scale <= 1) return null;

  const targetWidth = Math.round(width * scale);
  const targetHeight = Math.round(height * scale);
  let pipeline = sharp(buffer).resize({ width: targetWidth, height: targetHeight, kernel: "lanczos3" });
  pipeline = mimeType === "image/png" ? pipeline.png()
    : mimeType === "image/webp" ? pipeline.webp({ quality: 92 })
    : pipeline.jpeg({ quality: 92, mozjpeg: true });
  const data = await pipeline.toBuffer();
  return { data, width: targetWidth, height: targetHeight };
}

/** Generate an optimized web preview (webp). */
export async function makePreview(buffer: Buffer, maxWidth = 1600): Promise<Buffer> {
  return sharp(buffer)
    .resize({ width: maxWidth, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
}

/** Generate a JPG download variant. */
export async function toJpg(buffer: Buffer, quality = 90): Promise<Buffer> {
  return sharp(buffer).jpeg({ quality, mozjpeg: true }).toBuffer();
}

/** Generate a solid-color test PNG (mock image generation). */
export async function makeMockImage(
  width: number,
  height: number,
  label: string,
  rgb: [number, number, number],
): Promise<Buffer> {
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="rgb(${rgb[0]},${rgb[1]},${rgb[2]})"/>
    <text x="50%" y="48%" font-family="sans-serif" font-size="${Math.round(width / 18)}" fill="white" text-anchor="middle">Shotlin Mock</text>
    <text x="50%" y="58%" font-family="sans-serif" font-size="${Math.round(width / 28)}" fill="white" text-anchor="middle">${label}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
