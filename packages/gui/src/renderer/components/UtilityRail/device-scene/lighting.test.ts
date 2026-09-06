import { describe, expect, it } from "vitest";
import {
  lightingFor,
  mixHexColor,
  STATE_TARGETS,
  THEME_DAYLIGHT,
} from "./lighting.js";

describe("device-scene lighting tables (ADR 0057 §2, no room)", () => {
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

  it("the light theme is the white studio and the dark theme is the night", () => {
    const day = lightingFor(THEME_DAYLIGHT.light);
    expect(day.external).toBe(1);
    expect(day.adaptation).toBe(1);
    expect(day.contour).toBe(0);
    expect(day.key).toBeCloseTo(3.1, 9);
    expect(day.keyColor).toBe("#ffffff");
    expect(day.exposure).toBeCloseTo(1.02, 9);
    expect(day.softbox).toBe(1);
    expect(day.bloom).toBeCloseTo(0.055, 9);
    const night = lightingFor(THEME_DAYLIGHT.dark);
    expect(night.external).toBe(0);
    expect(night.key).toBe(0);
    expect(night.fill).toBe(0);
    expect(night.rim).toBe(0);
    expect(night.sky).toBe(0);
    expect(night.environment).toBe(0);
    expect(night.softbox).toBe(0);
    expect(night.contour).toBeCloseTo(0.003, 9);
    expect(night.adaptation).toBe(12);
    // Adaptation scales exposure, never the ring: 0.87 × 12.
    expect(night.exposure).toBeCloseTo(0.87 * 12, 6);
    expect(night.keyColor).toBe("#9abef4");
  });

  it("a half-daylight frame keeps the key × exposure near the studio's (no flash mid-flip)", () => {
    const day = lightingFor(1);
    const mid = lightingFor(0.5);
    const ratio = (mid.key * mid.exposure) / (day.key * day.exposure);
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.1);
  });

  it("clamps the input and stays monotone in daylight", () => {
    expect(lightingFor(-1)).toEqual(lightingFor(0));
    expect(lightingFor(2)).toEqual(lightingFor(1));
    let prev = lightingFor(0);
    for (let t = 0.1; t <= 1.0001; t += 0.1) {
      const cur = lightingFor(t);
      expect(cur.key).toBeGreaterThanOrEqual(prev.key);
      expect(cur.contour).toBeLessThanOrEqual(prev.contour);
      expect(cur.adaptation).toBeLessThanOrEqual(prev.adaptation);
      prev = cur;
    }
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
});
