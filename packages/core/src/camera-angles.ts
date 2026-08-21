/**
 * Camera angle vocabulary for multi-angle generation sets.
 *
 * A set is generated as one anchor plus a fan-out: the anchor establishes the
 * character and garment, every other angle receives the anchor image as a
 * reference so identity cannot drift between images.
 */

export type CameraAngleKey =
  | "front"
  | "three_quarter_left"
  | "three_quarter_right"
  | "profile_left"
  | "back";

export type CameraAngle = {
  key: CameraAngleKey;
  /** Customer-facing label. */
  label: string;
  /** Camera placement instruction injected into the compiled prompt. */
  instruction: string;
};

/**
 * Angle definitions. Only the camera moves — subject, garment, lighting, and
 * environment stay fixed. Each instruction is written as a camera direction so
 * the model repositions the viewpoint instead of restyling the subject.
 */
export const CAMERA_ANGLES: Record<CameraAngleKey, CameraAngle> = {
  front: {
    key: "front",
    label: "Front",
    instruction:
      "Camera positioned directly in front of the subject at eye level, straight-on frontal view, subject facing the camera, shoulders square to frame",
  },
  three_quarter_left: {
    key: "three_quarter_left",
    label: "3/4 Left",
    instruction:
      "Camera positioned 45 degrees to the subject's left at eye level, three-quarter view, subject's body angled so both the front and left side of the garment are visible",
  },
  three_quarter_right: {
    key: "three_quarter_right",
    label: "3/4 Right",
    instruction:
      "Camera positioned 45 degrees to the subject's right at eye level, three-quarter view, subject's body angled so both the front and right side of the garment are visible",
  },
  profile_left: {
    key: "profile_left",
    label: "Side Profile",
    instruction:
      "Camera positioned 90 degrees to the subject's left at eye level, full side profile view, subject facing left of frame, showing the complete side silhouette of the garment",
  },
  back: {
    key: "back",
    label: "Back",
    instruction:
      "Camera positioned directly behind the subject at eye level, rear view, subject facing away from camera, showing the full back of the garment",
  },
};

/**
 * Ordered angle sets by requested image count. Index 0 is always the anchor.
 * Front leads every set: it is the most reliable view for establishing both
 * face identity and garment structure for the remaining angles to lock onto.
 */
const ANGLE_SETS: Record<number, CameraAngleKey[]> = {
  1: ["front"],
  2: ["front", "three_quarter_left"],
  3: ["front", "three_quarter_left", "three_quarter_right"],
  4: ["front", "three_quarter_left", "three_quarter_right", "profile_left"],
  5: [
    "front",
    "three_quarter_left",
    "three_quarter_right",
    "profile_left",
    "back",
  ],
};

export const MAX_ANGLES = 5;

/** Resolve the default ordered angle set for a requested output count. */
export function defaultAngleSet(outputCount: number): CameraAngleKey[] {
  const clamped = Math.min(Math.max(Math.trunc(outputCount) || 1, 1), MAX_ANGLES);
  return ANGLE_SETS[clamped] ?? ANGLE_SETS[1];
}

/**
 * Type guard for persisted/user-supplied angle keys.
 * Uses an own-property check so inherited names like `toString` or
 * `constructor` cannot pass as valid angles.
 */
export function isCameraAngleKey(value: unknown): value is CameraAngleKey {
  return typeof value === "string" && Object.hasOwn(CAMERA_ANGLES, value);
}

/**
 * Normalize a caller-supplied angle list: keeps only known keys, removes
 * duplicates, caps at the requested count, and falls back to the default set
 * when nothing usable remains.
 */
export function resolveAngleSet(
  outputCount: number,
  requested?: readonly unknown[] | null,
): CameraAngleKey[] {
  const fallback = defaultAngleSet(outputCount);
  if (!requested?.length) return fallback;

  const seen = new Set<CameraAngleKey>();
  for (const value of requested) {
    if (isCameraAngleKey(value)) seen.add(value);
    if (seen.size >= fallback.length) break;
  }
  if (seen.size === 0) return fallback;

  const chosen = [...seen];
  // Top up from the default set if the caller supplied too few valid angles.
  for (const key of fallback) {
    if (chosen.length >= fallback.length) break;
    if (!seen.has(key)) {
      chosen.push(key);
      seen.add(key);
    }
  }
  return chosen;
}

/**
 * Identity-lock instruction for every non-anchor angle.
 *
 * This is the consistency contract: the anchor image is supplied as a
 * reference, and this text tells the model that the reference defines the
 * person and the outfit, so only the viewpoint may change.
 */
export function buildAngleInstruction(
  angle: CameraAngle,
  options: { isAnchor: boolean },
): string {
  if (options.isAnchor) {
    return [
      `CAMERA ANGLE: ${angle.instruction}.`,
      "This is the anchor frame of a multi-angle set: render the subject and garment cleanly and completely so later angles can match it.",
    ].join("\n");
  }

  return [
    `CAMERA ANGLE: ${angle.instruction}.`,
    "IDENTITY LOCK — the final reference image is the anchor frame of this same shoot. It shows the SAME person wearing the SAME garment. Only the camera position changes.",
    "Reproduce from the anchor exactly: facial structure and proportions, skin tone and undertone, freckles, moles, scars and every skin marking, eye colour, eyebrow shape, hairstyle, hair colour and hairline, body proportions, height and build.",
    "Reproduce the garment exactly: colours, pattern placement, weave, border, trim, embroidery, neckline, sleeves, length and silhouette. Keep the same styling, fit and drape.",
    "Keep the same lighting direction, colour temperature, environment and lens character as the anchor.",
    "Do not restyle, re-age, re-cast, beautify or alter the person. Do not redesign, recolour or re-drape the garment. This must read as the same photograph session, same model, same outfit, photographed from a different position.",
  ].join("\n");
}
