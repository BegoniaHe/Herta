import { describe, expect, it } from "vitest";
import {
  externalLightAt,
  hourDelta,
  lightingAt,
  mixHexColor,
  STATE_TARGETS,
  THEME_HOUR,
  timeWeights,
} from "./lighting.js";

describe("device-scene lighting tables (ADR 0057 §2)", () => {
  it("covers every device state the flat card knows", () => {
    const states = [
      "idle",
      "delegated",
      "reading",
      "writing",
      "runningCommand",
      "waitingApproval",
      "verifying",
      "succeeded",
      "failed",
    ] as const;
    for (const s of states) {
      expect(STATE_TARGETS[s].color).toMatch(/^#[0-9a-f]{6}$/);
      expect(STATE_TARGETS[s].intensity).toBeGreaterThan(0);
    }
  });

  it("daylight is off after hours and full in the day, with smooth ramps", () => {
    expect(externalLightAt(0)).toBe(0);
    expect(externalLightAt(23)).toBe(0);
    expect(externalLightAt(5)).toBe(0);
    expect(externalLightAt(6.5)).toBeCloseTo(0.5, 5);
    expect(externalLightAt(12)).toBe(1);
    expect(externalLightAt(20)).toBeCloseTo(0.5, 5);
    expect(externalLightAt(22)).toBe(0);
    expect(externalLightAt(-1)).toBe(0); // wraps
  });

  it("the light theme is a morning and the dark theme is after hours", () => {
    const day = lightingAt(THEME_HOUR.light);
    expect(day.afterHours).toBe(false);
    expect(day.external).toBe(1);
    expect(day.adaptation).toBe(1);
    expect(day.contour).toBe(0);
    expect(day.key).toBeGreaterThan(2);
    const night = lightingAt(THEME_HOUR.dark);
    expect(night.afterHours).toBe(true);
    expect(night.key).toBe(0);
    expect(night.sky).toBe(0);
    expect(night.environment).toBe(0);
    expect(night.contour).toBeCloseTo(0.003, 6);
    expect(night.adaptation).toBe(12);
    // Adaptation scales exposure, never the ring: 0.87 × 12.
    expect(night.exposure).toBeCloseTo(0.87 * 12, 6);
  });

  it("interpolates anchors continuously across the midnight seam", () => {
    const before = lightingAt(23.999);
    const after = lightingAt(0.001);
    expect(Math.abs(before.rotation - after.rotation)).toBeLessThan(1e-3);
    expect(before.background).toBe(after.background);
  });

  it("time weights sum to one and pick the right preset", () => {
    for (const h of [0, 3, 6.5, 8, 10, 13, 15.5, 18, 20, 22, 23.9]) {
      const w = timeWeights(h);
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    }
    expect(timeWeights(8)).toEqual([1, 0, 0, 0]);
    expect(timeWeights(13)).toEqual([0, 1, 0, 0]);
    expect(timeWeights(18)).toEqual([0, 0, 1, 0]);
    expect(timeWeights(0)).toEqual([0, 0, 0, 1]);
    // The light theme's hour is nearly pure morning.
    expect(timeWeights(THEME_HOUR.light)[0]).toBeGreaterThan(0.95);
  });

  it("mixes colours in linear light and clamps", () => {
    expect(mixHexColor("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHexColor("#000000", "#ffffff", 1)).toBe("#ffffff");
    // Linear midpoint is brighter than the sRGB midpoint (#808080).
    const mid = Number.parseInt(
      mixHexColor("#000000", "#ffffff", 0.5).slice(1, 3),
      16,
    );
    expect(mid).toBeGreaterThan(128);
  });

  it("hourDelta takes the short way around the clock", () => {
    expect(hourDelta(8.5, 0)).toBeCloseTo(-8.5, 9);
    expect(hourDelta(0, 8.5)).toBeCloseTo(8.5, 9);
    expect(hourDelta(22, 2)).toBeCloseTo(4, 9);
    expect(hourDelta(2, 22)).toBeCloseTo(-4, 9);
  });
});
