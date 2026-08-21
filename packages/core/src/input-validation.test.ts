import { describe, it, expect } from "vitest";
import { validateImageInput } from "./input-validation";

describe("input validation", () => {
  it("accepts a valid JPEG", () => {
    const r = validateImageInput({
      mimeType: "image/jpeg",
      sizeBytes: 5_000_000,
      width: 2048,
      height: 3072,
      blurVariance: 500,
    });
    expect(r.usable).toBe(true);
    expect(r.reasons).toHaveLength(0);
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

  it("rejects too-small dimensions", () => {
    const r = validateImageInput({
      mimeType: "image/png",
      sizeBytes: 100_000,
      width: 64,
      height: 64,
      blurVariance: 500,
    });
    expect(r.usable).toBe(false);
    expect(r.reasons[0]).toContain("too small");
  });

  it("rejects blurry images", () => {
    const r = validateImageInput({
      mimeType: "image/jpeg",
      sizeBytes: 2_000_000,
      width: 1024,
      height: 1024,
      blurVariance: 50,
    });
    expect(r.usable).toBe(false);
    expect(r.reasons[0]).toContain("blurry");
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
  });
});
