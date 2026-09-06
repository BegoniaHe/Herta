import type { CSSProperties } from "react";

export interface DragTrackerInput {
  /** Negative = upward drag in screen coordinates. */
  readonly dragDeltaY: number;
  /** Random outcome at drag start, in [0, 1). */
  readonly chance: number;
  /** Minimum |dragDeltaY| in px to even consider a lift. */
  readonly threshold: number;
  /** Probability (0..1) that a successful drag lifts the device. */
  readonly liftProbability: number;
  /** Cap on lift magnitude in px. */
  readonly maxLiftPx: number;
  /** prefers-reduced-motion preference. */
  readonly reducedMotion: boolean;
}

export interface DragResult {
  /** CSS transform string for the device layer, or null if no lift. */
  readonly transform: string | null;
  /** Inline style for the shadow layer (scale + opacity). */
  readonly shadowStyle: CSSProperties | undefined;
  /** The lift in CSS px (0 when no lift) — the 3D card's spring target
   *  (ADR 0057); the flat card reads the transform instead. */
  readonly liftPx: number;
}

const NO_LIFT: DragResult = {
  transform: null,
  shadowStyle: undefined,
  liftPx: 0,
};

/** A rectangle as fractions of the preview box (0..1 from its top-left). */
export interface FractionBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * Where the device actually is inside `.agent-preview` (owner 2026-09-07:
 * "the draggable area is obviously larger than the device"). Measured from
 * the flat art's alpha: opaque pixels span x 275–842 of 1121 and y
 * 231–1166 of 1403 (agent_device.png, threshold 24/255), i.e. the middle
 * 51 % of the width and 67 % of the height, centred. The 3D model was
 * built from the art, not traced from it, but it is framed to the same
 * box: its projected extent measured within a pixel of this one on every
 * edge (2026-09-07), so one box serves both.
 */
export const DEVICE_SILHOUETTE: FractionBox = {
  left: 275 / 1121,
  top: 231 / 1403,
  right: 843 / 1121,
  bottom: 1167 / 1403,
};

/** Whether a point, as fractions of the preview box, is over the device. */
export function pointOverDevice(
  fx: number,
  fy: number,
  box: FractionBox = DEVICE_SILHOUETTE,
): boolean {
  return fx >= box.left && fx <= box.right && fy >= box.top && fy <= box.bottom;
}

/**
 * Pure drag-to-lift computation. No side effects, no React. The
 * React-side hook (useDragToLift) handles event wiring + roll-the-dice.
 */
export function computeDragResult(input: DragTrackerInput): DragResult {
  // Reduced motion short-circuits everything.
  if (input.reducedMotion) return NO_LIFT;
  // Direction gate: only upward drags lift.
  if (input.dragDeltaY >= 0) return NO_LIFT;
  // Threshold gate: small jitter doesn't count.
  if (Math.abs(input.dragDeltaY) < input.threshold) return NO_LIFT;
  // Chance gate: only the lucky drags lift.
  if (input.chance >= input.liftProbability) return NO_LIFT;
  const liftPx = Math.min(Math.abs(input.dragDeltaY), input.maxLiftPx);
  const shadowScale = 1 - liftPx * 0.01;
  const shadowOpacity = 0.85 - liftPx * 0.02;
  return {
    transform: `translateY(-${liftPx}px)`,
    shadowStyle: {
      transform: `scale(${shadowScale.toFixed(3)})`,
      opacity: shadowOpacity.toFixed(3),
    },
    liftPx,
  };
}
