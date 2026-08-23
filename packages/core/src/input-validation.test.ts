import { describe, it, expect } from "vitest";
import { validateImageInput } from "./input-validation";

describe("input validation", () => {
  it("accepts a valid JPEG with no warnings", () => {
    const r = validateImageInput({
      mimeType: "image/jpeg",
      sizeBytes: 5_000_000,
      width: 2048,
      height: 3072,
      blurVariance: 500,
    });
    expect(r.usable).toBe(true);
    expect(r.reasons).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
    expect(r.needsUpscale).toBe(false);
  });

  it("rejects unsupported MIME type", () => {
    const r = validateImageInput({
      mimeType: "image/gif",
      sizeBytes: 100_000,
      width: 800,
      height: 800,
      blurVariance: 500,
    });
    expect(r.usable).toBe(false);
    expect(r.reasons[0]).toContain("gif");
  });

  it("rejects oversized file", () => {
    const r = validateImageInput({
      mimeType: "image/jpeg",
      sizeBytes: 30_000_000,
      width: 2048,
      height: 3072,
      blurVariance: 500,
    });
    expect(r.usable).toBe(false);
    expect(r.reasons[0]).toContain("too large");
  });

  it("hard-rejects dimensions below the absolute floor — no amount of upscaling helps", () => {
    const r = validateImageInput({
      mimeType: "image/png",
      sizeBytes: 100_000,
      width: 64,
      height: 64,
      blurVariance: 500,
    });
    expect(r.usable).toBe(false);
    expect(r.reasons[0]).toContain("too small to use");
  });

  it("flags a decodable-but-undersized image for upscaling instead of rejecting it", () => {
    const r = validateImageInput({
      mimeType: "image/jpeg",
      sizeBytes: 100_000,
      width: 316,
      height: 963,
      blurVariance: 500,
    });
    expect(r.usable).toBe(true);
    expect(r.reasons).toHaveLength(0);
    expect(r.needsUpscale).toBe(true);
    expect(r.warnings[0]).toContain("below ideal size");
  });

  it("flags a blurry image as a warning, not a rejection", () => {
    const r = validateImageInput({
      mimeType: "image/jpeg",
      sizeBytes: 2_000_000,
      width: 1024,
      height: 1024,
      blurVariance: 50,
    });
    expect(r.usable).toBe(true);
    expect(r.reasons).toHaveLength(0);
    expect(r.warnings[0]).toContain("soft/blurry");
  });

  it("can be simultaneously too small (upscale) and blurry — both are warnings, still usable", () => {
    const r = validateImageInput({
      mimeType: "image/jpeg",
      sizeBytes: 100_000,
      width: 316,
      height: 963,
      blurVariance: 45.6,
    });
    expect(r.usable).toBe(true);
    expect(r.needsUpscale).toBe(true);
    expect(r.warnings).toHaveLength(2);
  });

  it("passes when blurVariance is null (not computed)", () => {
    const r = validateImageInput({
      mimeType: "image/jpeg",
      sizeBytes: 2_000_000,
      width: 1024,
      height: 1024,
      blurVariance: null,
    });
    expect(r.usable).toBe(true);
    expect(r.warnings).toHaveLength(0);
  });

  it("rejects dimensions above the max", () => {
    const r = validateImageInput({
      mimeType: "image/jpeg",
      sizeBytes: 2_000_000,
      width: 12_000,
      height: 8_000,
      blurVariance: 500,
    });
    expect(r.usable).toBe(false);
    expect(r.reasons[0]).toContain("too large");
  });
});
