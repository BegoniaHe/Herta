import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { DeviceCard, SCENE_PATIENCE_MS } from "./DeviceCard.js";
import { resetDeviceSceneBackendForTest } from "./device-scene/capability.js";
import { resetDeviceScenePrefForTest } from "./device-scene/device-scene-prefs.js";
import { IDLE_MOUNT_SETTLE_MS } from "./device-scene/use-idle-mount.js";

// A scene stand-in that hands its `onLive` to the test: what the card
// shows while the real one builds is the subject here (ADR 0057 §2.13).
const latest: { onLive: ((live: boolean) => void) | null } = { onLive: null };
vi.mock("./device-scene/DeviceScene.js", () => ({
  DeviceScene: (props: { onLive: (live: boolean) => void }) => {
    latest.onLive = props.onLive;
    return <canvas className="device-scene-canvas" />;
  },
}));

const sceneAttr = (container: HTMLElement): string | null =>
  container.querySelector(".device-card")?.getAttribute("data-scene") ?? null;

describe("DeviceCard — what shows while the 3D scene builds (ADR 0057 §2.13)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    latest.onLive = null;
  });
  afterEach(() => {
    // No automatic RTL cleanup here: a card left mounted keeps re-rendering
    // the mock and steals `latest.onLive` from the next test's card.
    cleanup();
    vi.useRealTimers();
    resetDeviceScenePrefForTest();
    resetDeviceSceneBackendForTest();
  });

  it("holds the device back from the first paint while the setting is unknown or on, then fades the 3D in on its first frame", async () => {
    const mock = createMockHertaBridge({ deviceSceneResult: true });
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    // Before the pref has even loaded: pending, never a flash of flat art.
    expect(sceneAttr(container)).toBe("pending");
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    expect(sceneAttr(container)).toBe("pending");
    await act(async () => {
      vi.advanceTimersByTime(IDLE_MOUNT_SETTLE_MS);
    });
    expect(container.querySelector(".device-scene-canvas")).not.toBeNull();
    expect(sceneAttr(container)).toBe("pending");
    act(() => {
      latest.onLive?.(true);
    });
    expect(sceneAttr(container)).toBe("live");
  });

  it("shows the flat art when the scene cannot come, and when patience runs out — then still takes a late first frame", async () => {
    const mock = createMockHertaBridge({ deviceSceneResult: true });
    const first = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    const { container } = first;
    // The pref lands in one act; the idle gate's timer starts on the
    // re-render that follows, so the advance is a second act.
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(IDLE_MOUNT_SETTLE_MS);
    });
    expect(container.querySelector(".device-scene-canvas")).not.toBeNull();
    expect(sceneAttr(container)).toBe("pending");
    act(() => {
      latest.onLive?.(false); // no GPU path / a failure
    });
    expect(sceneAttr(container)).toBeNull();
    // The pref store is module-level and loads once: start the next card
    // clean, and unmount this one so `latest.onLive` is the next card's.
    first.unmount();
    resetDeviceScenePrefForTest();

    // A fresh card whose scene never reports: patience.
    const second = createMockHertaBridge({ deviceSceneResult: true });
    const again = renderWithLocale(
      <HertaBridgeProvider bridge={second.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    expect(sceneAttr(again.container)).toBe("pending");
    act(() => {
      vi.advanceTimersByTime(SCENE_PATIENCE_MS);
    });
    expect(sceneAttr(again.container)).toBeNull();
    act(() => {
      latest.onLive?.(true);
    });
    expect(sceneAttr(again.container)).toBe("live");
  });

  it("a bridge without the surface, or the setting off, is flat from the start / as soon as known", async () => {
    const off = createMockHertaBridge(); // no setDeviceScene surface
    const first = renderWithLocale(
      <HertaBridgeProvider bridge={off.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    expect(sceneAttr(first.container)).toBeNull();
    first.unmount();
    resetDeviceScenePrefForTest();

    const disabled = createMockHertaBridge({ deviceSceneResult: false });
    const second = renderWithLocale(
      <HertaBridgeProvider bridge={disabled.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    expect(sceneAttr(second.container)).toBe("pending"); // the pref is in flight
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    expect(sceneAttr(second.container)).toBeNull();
  });
});
