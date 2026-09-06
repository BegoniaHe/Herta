import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDeviceSceneBackendForTest } from "./capability.js";
import { DeviceScene } from "./DeviceScene.js";

const createDeviceScene = vi.fn();
vi.mock("./scene.js", () => ({
  createDeviceScene: (o: unknown) => createDeviceScene(o),
}));

const flush = async (): Promise<void> => {
  // capability probe → dynamic import → createDeviceScene: three awaits.
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

beforeEach(() => {
  resetDeviceSceneBackendForTest();
  createDeviceScene.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    (() => null) as typeof HTMLCanvasElement.prototype.getContext,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DeviceScene (ADR 0057 §4)", () => {
  it("reports not-live and never builds the scene when there is no GPU path (jsdom)", async () => {
    const onLive = vi.fn();
    const { container } = render(
      <DeviceScene
        state="idle"
        theme="light"
        paused={false}
        liftPx={0}
        onLive={onLive}
      />,
    );
    expect(
      container.querySelector("canvas.device-scene-canvas"),
    ).not.toBeNull();
    await act(flush);
    expect(onLive).toHaveBeenCalledWith(false);
    expect(createDeviceScene).not.toHaveBeenCalled();
  });

  it("builds the scene on a GPU path, goes live after the first frame, forwards inputs, disposes on unmount", async () => {
    const gpu = {
      requestAdapter: async () => ({
        requestDevice: async () => ({ destroy: () => undefined }),
      }),
    };
    vi.stubGlobal("navigator", { ...navigator, gpu });
    const handle = {
      stats: { backend: "webgpu", loadMs: 12, firstFrameMs: 3 },
      update: vi.fn(),
      dispose: vi.fn(),
    };
    createDeviceScene.mockImplementation(async () => handle);
    const onLive = vi.fn();
    const { container, rerender, unmount } = render(
      <DeviceScene
        state="idle"
        theme="light"
        paused={false}
        liftPx={0}
        onLive={onLive}
      />,
    );
    await act(flush);
    expect(createDeviceScene).toHaveBeenCalledTimes(1);
    const opts = createDeviceScene.mock.calls[0]?.[0] as {
      forceWebGL: boolean;
      assetUrl: (f: string) => string;
      initial: { state: string };
    };
    expect(opts.forceWebGL).toBe(false);
    expect(opts.assetUrl("device.glb")).toBe(
      "herta-asset://device-scene/device.glb",
    );
    expect(opts.initial.state).toBe("idle");
    expect(onLive).toHaveBeenLastCalledWith(true);
    const canvas = container.querySelector(
      "canvas.device-scene-canvas",
    ) as HTMLCanvasElement;
    expect(canvas.dataset.backend).toBe("webgpu");

    rerender(
      <DeviceScene
        state="delegated"
        theme="dark"
        paused={true}
        liftPx={6}
        onLive={onLive}
      />,
    );
    expect(handle.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: "delegated",
        theme: "dark",
        paused: true,
        liftPx: 6,
      }),
    );
    unmount();
    expect(handle.dispose).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("returns the card to flat when the scene reports a fallback, and when building throws", async () => {
    const gpu = { requestAdapter: async () => null };
    vi.stubGlobal("navigator", { ...navigator, gpu });
    // No adapter but a hardware WebGL2 context → the WebGL2 path.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((
      type: string,
    ) =>
      type === "webgl2"
        ? {
            getExtension: () => null,
            getParameter: () => "NVIDIA GeForce",
            RENDERER: 0,
          }
        : null) as typeof HTMLCanvasElement.prototype.getContext);
    let fallback: (() => void) | null = null;
    const handle = {
      stats: { backend: "webgl2", loadMs: 1, firstFrameMs: 1 },
      update: vi.fn(),
      dispose: vi.fn(),
    };
    createDeviceScene.mockImplementation(
      async (o: { onFallback: () => void }) => {
        fallback = o.onFallback;
        return handle;
      },
    );
    const onLive = vi.fn();
    render(
      <DeviceScene
        state="idle"
        theme="light"
        paused={false}
        liftPx={0}
        onLive={onLive}
      />,
    );
    await act(flush);
    expect(onLive).toHaveBeenLastCalledWith(true);
    expect(
      (createDeviceScene.mock.calls[0]?.[0] as { forceWebGL: boolean })
        .forceWebGL,
    ).toBe(true);
    act(() => {
      fallback?.();
    });
    expect(onLive).toHaveBeenLastCalledWith(false);

    cleanup();
    resetDeviceSceneBackendForTest();
    createDeviceScene.mockImplementation(async () => {
      throw new Error("no wasm");
    });
    const onLive2 = vi.fn();
    render(
      <DeviceScene
        state="idle"
        theme="light"
        paused={false}
        liftPx={0}
        onLive={onLive2}
      />,
    );
    await act(flush);
    expect(onLive2).toHaveBeenLastCalledWith(false);
    vi.unstubAllGlobals();
  });
});
