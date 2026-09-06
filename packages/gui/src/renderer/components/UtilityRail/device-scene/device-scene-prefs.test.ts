import { afterEach, describe, expect, it, vi } from "vitest";
import type { HertaBridge } from "../../../ipc/bridge-types.js";
import {
  deviceScenePref,
  loadDeviceScenePref,
  resetDeviceScenePrefForTest,
  setDeviceScenePrefLocal,
  subscribeDeviceScenePref,
} from "./device-scene-prefs.js";

afterEach(resetDeviceScenePrefForTest);

describe("device-scene-prefs (ADR 0057)", () => {
  it("is null until loaded, then mirrors the bridge", async () => {
    expect(deviceScenePref()).toBeNull();
    const bridge = {
      getDeviceScene: vi.fn(async () => true),
    } as unknown as HertaBridge;
    await loadDeviceScenePref(bridge);
    expect(deviceScenePref()).toBe(true);
  });

  it("loads once — a second caller shares the round-trip", async () => {
    const getDeviceScene = vi.fn(async () => false);
    const bridge = { getDeviceScene } as unknown as HertaBridge;
    await Promise.all([
      loadDeviceScenePref(bridge),
      loadDeviceScenePref(bridge),
    ]);
    expect(getDeviceScene).toHaveBeenCalledTimes(1);
    expect(deviceScenePref()).toBe(false);
  });

  it("stays null when the bridge lacks the surface or the read fails", async () => {
    await loadDeviceScenePref({} as HertaBridge);
    expect(deviceScenePref()).toBeNull();
    resetDeviceScenePrefForTest();
    await loadDeviceScenePref({
      getDeviceScene: async () => {
        throw new Error("io");
      },
    } as unknown as HertaBridge);
    expect(deviceScenePref()).toBeNull();
  });

  it("notifies subscribers on change only", () => {
    const seen: boolean[] = [];
    const unsub = subscribeDeviceScenePref(() =>
      seen.push(deviceScenePref() === true),
    );
    setDeviceScenePrefLocal(true);
    setDeviceScenePrefLocal(true);
    setDeviceScenePrefLocal(false);
    unsub();
    setDeviceScenePrefLocal(true);
    expect(seen).toEqual([true, false]);
  });
});
