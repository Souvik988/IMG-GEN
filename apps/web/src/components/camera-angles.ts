export type CameraAngleKey = "front" | "three_quarter_left" | "three_quarter_right" | "profile_left" | "back";

export const CAMERA_ANGLES: Record<CameraAngleKey, { key: CameraAngleKey; label: string }> = {
  front: { key: "front", label: "Front" },
  three_quarter_left: { key: "three_quarter_left", label: "3/4 Left" },
  three_quarter_right: { key: "three_quarter_right", label: "3/4 Right" },
  profile_left: { key: "profile_left", label: "Side Profile" },
  back: { key: "back", label: "Back" },
};

const DEFAULT_SETS: Record<number, CameraAngleKey[]> = {
  1: ["front"],
  2: ["front", "three_quarter_left"],
  3: ["front", "three_quarter_left", "three_quarter_right"],
  4: ["front", "three_quarter_left", "three_quarter_right", "profile_left"],
  5: ["front", "three_quarter_left", "three_quarter_right", "profile_left", "back"],
};

export function resolveAngleSet(outputCount: number, requested?: readonly unknown[] | null): CameraAngleKey[] {
  const count = Math.min(Math.max(Math.trunc(outputCount) || 1, 1), 5);
  const fallback = DEFAULT_SETS[count] ?? DEFAULT_SETS[1];
  const selected = (requested ?? []).filter((value): value is CameraAngleKey => typeof value === "string" && value in CAMERA_ANGLES);
  return selected.length ? [...new Set(selected)].slice(0, fallback.length) : fallback;
}
