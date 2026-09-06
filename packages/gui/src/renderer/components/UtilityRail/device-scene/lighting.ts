import type { BanzhuanDeviceState } from "../../../hooks/useDeviceState.js";

/**
 * The device scene's lighting tables (ADR 0057 §2, amended 2026-09-06:
 * no room). Ported from the owner's study (reference_UX_design/
 * banzhuan-3d-demo: study-model.js `studioLighting`, the midnight anchor,
 * webgpu-lighting.js' daylight/adaptation rules). Pure numbers — no
 * three.js — so the theme mapping unit-tests in node.
 *
 * The card shows the device the way the flat renders do: on the card's
 * own frost, no room. So the two looks are the study's "PNG match" white
 * studio (light theme) and its lights-off night with the weak outline
 * (dark theme), blended by one scalar — daylight — that the theme sets
 * and the scene eases.
 */

/** Ring indicator targets per device state: colour, emissive strength, the
 *  breath's rate (Hz) and depth. Same nine states as the flat card. */
export interface StateTarget {
  readonly color: string;
  readonly intensity: number;
  readonly hz: number;
  readonly depth: number;
}

export const STATE_TARGETS: Record<BanzhuanDeviceState, StateTarget> = {
  idle: { color: "#86cdf2", intensity: 2.4, hz: 1 / 3.8, depth: 0.065 },
  delegated: { color: "#77c8ff", intensity: 3.8, hz: 1 / 1.7, depth: 0.13 },
  reading: { color: "#77c8ff", intensity: 3.4, hz: 1 / 2, depth: 0.11 },
  writing: { color: "#77c8ff", intensity: 3.9, hz: 1 / 1.5, depth: 0.12 },
  runningCommand: {
    color: "#77c8ff",
    intensity: 4.0,
    hz: 1 / 1.35,
    depth: 0.13,
  },
  verifying: { color: "#77c8ff", intensity: 3.8, hz: 1 / 1.8, depth: 0.1 },
  waitingApproval: {
    color: "#ffc97e",
    intensity: 3.2,
    hz: 1 / 2.7,
    depth: 0.1,
  },
  succeeded: { color: "#87e5b0", intensity: 2.7, hz: 1 / 3, depth: 0.04 },
  failed: { color: "#f99586", intensity: 2.6, hz: 1 / 4, depth: 0.025 },
};

/** Daylight per theme: the white studio, or the night. */
export const THEME_DAYLIGHT: Record<"light" | "dark", number> = {
  light: 1,
  dark: 0,
};

export interface Lighting {
  readonly keyColor: string;
  readonly key: number;
  readonly fill: number;
  readonly rim: number;
  readonly sky: number;
  readonly environment: number;
  /** Softbox (the studio's large soft reflection) intensity. */
  readonly softbox: number;
  readonly exposure: number;
  readonly rotation: number;
  /** Key light position in the study's design units (metres × 20). */
  readonly position: readonly [number, number, number];
  /** Daylight presence 0..1 (the input, echoed for the callers). */
  readonly external: number;
  /** The weak night outline spotlight's intensity. */
  readonly contour: number;
  /** Camera exposure adaptation as daylight leaves (≤ +log2(12) stops). */
  readonly adaptation: number;
  /** Emissive bloom strength for the ring. */
  readonly bloom: number;
  /** Key shadow softness (VSM radius). */
  readonly shadowRadius: number;
}

/** The study's "PNG match · white studio": the photographic setup the flat
 *  renders were matched against. */
const STUDIO = {
  keyColor: "#ffffff",
  key: 3.1,
  fill: 0.18,
  rim: 0.24,
  sky: 0.22,
  environment: 0.65,
  softbox: 1.0,
  exposure: 1.02,
  rotation: 0,
  position: [-4, 7, 6] as const,
  bloom: 0.055,
  shadowRadius: 12,
};

/** The study's midnight anchor: every daylight term at zero, exposure
 *  adapted, the outline spotlight and the ring carrying the shape. */
const NIGHT = {
  keyColor: "#9abef4",
  exposure: 0.87,
  rotation: -0.2,
  bloom: 0.165,
  shadowRadius: 6,
};

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

const srgbToLinear = (v: number): number =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const linearToSrgb = (v: number): number =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;

/** Blend two `#rrggbb` colours in linear light. */
export function mixHexColor(a: string, b: string, t: number): string {
  const channels = [1, 3, 5].map((i) => {
    const x = srgbToLinear(Number.parseInt(a.slice(i, i + 2), 16) / 255);
    const y = srgbToLinear(Number.parseInt(b.slice(i, i + 2), 16) / 255);
    const v = clamp01(linearToSrgb(x + (y - x) * t));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

/**
 * The live-light recipe for a daylight amount in 0..1. Every daylight
 * term scales with it, the adaptation rises as it leaves (the study's
 * `12 / (1 + 11·external)`), so a theme flip passes through a believable
 * dusk instead of a flash: at half daylight the halved key under a 1.85×
 * exposure lands near the studio's product.
 */
export function lightingFor(daylight: number): Lighting {
  const external = clamp01(daylight);
  const adaptation = 12 / (1 + 11 * external);
  return {
    keyColor: mixHexColor(NIGHT.keyColor, STUDIO.keyColor, external),
    key: STUDIO.key * external,
    fill: STUDIO.fill * external,
    rim: STUDIO.rim * external,
    sky: STUDIO.sky * external,
    environment: STUDIO.environment * external,
    softbox: STUDIO.softbox * external,
    exposure: lerp(NIGHT.exposure, STUDIO.exposure, external) * adaptation,
    rotation: lerp(NIGHT.rotation, STUDIO.rotation, external),
    position: STUDIO.position,
    external,
    contour: 0.003 * (1 - external) ** 2,
    adaptation,
    // The night figure is the study's (0.065 + 0.10) / √adaptation.
    bloom: lerp(NIGHT.bloom / Math.sqrt(12), STUDIO.bloom, external),
    shadowRadius: lerp(NIGHT.shadowRadius, STUDIO.shadowRadius, external),
  };
}
