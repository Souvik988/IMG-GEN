import { describe, expect, it } from "vitest";
import {
  CAMERA_ANGLES,
  MAX_ANGLES,
  buildAngleInstruction,
  defaultAngleSet,
  isCameraAngleKey,
  resolveAngleSet,
} from "./camera-angles";

describe("defaultAngleSet", () => {
  it("returns one angle for a single image", () => {
    expect(defaultAngleSet(1)).toEqual(["front"]);
  });

  it("always leads with the anchor front view", () => {
    for (let count = 1; count <= MAX_ANGLES; count++) {
      expect(defaultAngleSet(count)[0]).toBe("front");
    }
  });

  it("returns exactly the requested number of distinct angles", () => {
    for (let count = 1; count <= MAX_ANGLES; count++) {
      const set = defaultAngleSet(count);
      expect(set).toHaveLength(count);
      expect(new Set(set).size).toBe(count);
    }
  });

  it("clamps out-of-range counts into the supported set", () => {
    expect(defaultAngleSet(0)).toEqual(["front"]);
    expect(defaultAngleSet(-3)).toEqual(["front"]);
    expect(defaultAngleSet(99)).toHaveLength(MAX_ANGLES);
  });
});

describe("resolveAngleSet", () => {
  it("falls back to the default set when nothing is requested", () => {
    expect(resolveAngleSet(3, null)).toEqual(defaultAngleSet(3));
    expect(resolveAngleSet(3, [])).toEqual(defaultAngleSet(3));
  });

  it("honours a valid explicit request", () => {
    expect(resolveAngleSet(2, ["back", "profile_left"])).toEqual([
      "back",
      "profile_left",
    ]);
  });

  it("drops unknown keys and tops up from the default set", () => {
    const set = resolveAngleSet(3, ["back", "not_a_real_angle", "nope"]);
    expect(set).toHaveLength(3);
    expect(set[0]).toBe("back");
    expect(new Set(set).size).toBe(3);
  });

  it("removes duplicates rather than generating the same angle twice", () => {
    const set = resolveAngleSet(3, ["front", "front", "front"]);
    expect(new Set(set).size).toBe(set.length);
  });

  it("never exceeds the requested count", () => {
    const set = resolveAngleSet(2, [
      "front",
      "back",
      "profile_left",
      "three_quarter_left",
    ]);
    expect(set).toHaveLength(2);
  });

  it("ignores non-string junk without throwing", () => {
    expect(resolveAngleSet(1, [null, 42, {}])).toEqual(["front"]);
  });
});

describe("isCameraAngleKey", () => {
  it("accepts known keys and rejects everything else", () => {
    expect(isCameraAngleKey("front")).toBe(true);
    expect(isCameraAngleKey("toString")).toBe(false);
    expect(isCameraAngleKey(undefined)).toBe(false);
  });
});

describe("buildAngleInstruction", () => {
  it("marks the anchor frame without an identity lock", () => {
    const text = buildAngleInstruction(CAMERA_ANGLES.front, { isAnchor: true });
    expect(text).toContain("anchor frame");
    expect(text).not.toContain("IDENTITY LOCK");
  });

  it("locks identity and garment for every follow-up angle", () => {
    const text = buildAngleInstruction(CAMERA_ANGLES.back, { isAnchor: false });
    expect(text).toContain("IDENTITY LOCK");
    expect(text).toContain("freckles");
    expect(text).toContain("SAME person");
    // The camera instruction must still be present so the view actually changes.
    expect(text).toContain(CAMERA_ANGLES.back.instruction);
  });
});
