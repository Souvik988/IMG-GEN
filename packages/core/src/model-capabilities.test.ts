import { describe, expect, it } from "vitest";
import { checkModelCapabilities, parseModelCapabilities } from "./model-capabilities";

describe("parseModelCapabilities", () => {
  it("returns unconstrained for null/non-object input", () => {
    expect(parseModelCapabilities(null)).toEqual({});
    expect(parseModelCapabilities(undefined)).toEqual({});
    expect(parseModelCapabilities("not an object")).toEqual({});
  });

  it("picks up well-typed fields and ignores malformed ones", () => {
    expect(
      parseModelCapabilities({
        maxImageRefs: 6,
        resolutions: ["1k", "2k", "4k"],
        supportsMultiOutput: true,
        someUnrelatedField: "ignored",
      }),
    ).toEqual({ maxImageRefs: 6, resolutions: ["1k", "2k", "4k"], supportsMultiOutput: true });
  });

  it("drops a non-positive or non-numeric maxImageRefs instead of trusting it", () => {
    expect(parseModelCapabilities({ maxImageRefs: 0 })).toEqual({});
    expect(parseModelCapabilities({ maxImageRefs: -1 })).toEqual({});
    expect(parseModelCapabilities({ maxImageRefs: "6" })).toEqual({});
  });

  it("drops a resolutions array containing non-string entries", () => {
    expect(parseModelCapabilities({ resolutions: ["1k", 2] })).toEqual({});
  });

  it("handles partial capability objects (only some fields set)", () => {
    expect(parseModelCapabilities({ maxImageRefs: 4 })).toEqual({ maxImageRefs: 4 });
  });
});

describe("checkModelCapabilities", () => {
  const request = { referenceCount: 3, resolution: "2k", count: 1 };

  it("passes when capabilities are entirely unconstrained", () => {
    expect(checkModelCapabilities({}, request)).toEqual({ valid: true });
  });

  it("rejects when reference count exceeds maxImageRefs", () => {
    const result = checkModelCapabilities({ maxImageRefs: 2 }, request);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("at most 2");
  });

  it("passes when reference count is within maxImageRefs", () => {
    expect(checkModelCapabilities({ maxImageRefs: 3 }, request)).toEqual({ valid: true });
  });

  it("rejects an unsupported resolution", () => {
    const result = checkModelCapabilities({ resolutions: ["1k", "2k"] }, { ...request, resolution: "4k" });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("4k");
  });

  it("passes a supported resolution", () => {
    expect(checkModelCapabilities({ resolutions: ["1k", "2k", "4k"] }, request)).toEqual({ valid: true });
  });

  it("rejects count > 1 when the model explicitly does not support multi-output", () => {
    const result = checkModelCapabilities({ supportsMultiOutput: false }, { ...request, count: 2 });
    expect(result.valid).toBe(false);
  });

  it("does not reject count > 1 when supportsMultiOutput is simply unset", () => {
    expect(checkModelCapabilities({}, { ...request, count: 2 })).toEqual({ valid: true });
  });

  it("checks reference count before resolution when both would fail (deterministic first-failure order)", () => {
    const result = checkModelCapabilities(
      { maxImageRefs: 1, resolutions: ["1k"] },
      { referenceCount: 5, resolution: "4k", count: 1 },
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("at most 1");
  });
});
