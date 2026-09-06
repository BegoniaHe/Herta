import { useEffect, useRef } from "react";
import { deviceSceneAssetUrl } from "../../../../shared/device-scene.js";
import type { BanzhuanDeviceState } from "../../../hooks/useDeviceState.js";
import { useReducedMotion } from "../../../hooks/useReducedMotion.js";
import type { ResolvedTheme } from "../../../hooks/useResolvedTheme.js";
import { detectDeviceSceneBackend } from "./capability.js";
import type { DeviceSceneHandle, DeviceSceneInputs } from "./scene.js";

export interface DeviceSceneProps {
  readonly state: BanzhuanDeviceState;
  readonly theme: ResolvedTheme;
  /** Off-screen gate (disconnected rail, docked viewer) — stops the loop. */
  readonly paused: boolean;
  /** The drag hook's lift target in CSS px (0 when released). */
  readonly liftPx: number;
  /** true once the scene has presented a frame and owns the card; false
   *  when it cannot (no GPU path, a load failure, a lost device). */
  readonly onLive: (live: boolean) => void;
}

/**
 * The 3D device card's canvas (ADR 0057 §4). Mounts a canvas immediately,
 * probes the GPU path, then lazily imports the three.js scene module and
 * builds the scene; `onLive(true)` fires only after a first frame, so the
 * flat renders stay up until there is something to show. Any failure —
 * before or after — is `onLive(false)` and the card is flat again. The
 * scene's inputs ride a ref so the mount effect runs once.
 */
export function DeviceScene(props: DeviceSceneProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = useReducedMotion();
  const inputs: DeviceSceneInputs = {
    state: props.state,
    theme: props.theme,
    reducedMotion,
    paused: props.paused,
    liftPx: props.liftPx,
  };
  const live = useRef(inputs);
  live.current = inputs;
  const onLive = useRef(props.onLive);
  onLive.current = props.onLive;
  const handle = useRef<DeviceSceneHandle | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    let cancelled = false;
    let built: DeviceSceneHandle | null = null;
    void (async () => {
      const backend = await detectDeviceSceneBackend();
      if (cancelled) return;
      if (backend === null) {
        onLive.current(false);
        return;
      }
      const { createDeviceScene } = await import("./scene.js");
      if (cancelled) return;
      built = await createDeviceScene({
        canvas,
        forceWebGL: backend === "webgl2",
        assetUrl: deviceSceneAssetUrl,
        initial: live.current,
        onFallback: () => {
          handle.current = null;
          onLive.current(false);
        },
      });
      if (cancelled) {
        built.dispose();
        return;
      }
      handle.current = built;
      built.update(live.current);
      canvas.dataset.backend = built.stats.backend;
      canvas.dataset.loadMs = built.stats.loadMs.toFixed(0);
      canvas.dataset.firstFrameMs = built.stats.firstFrameMs.toFixed(0);
      onLive.current(true);
    })().catch(() => {
      if (!cancelled) onLive.current(false);
    });
    return () => {
      cancelled = true;
      // One dispose: `handle.current` and `built` are the same object once
      // the build has landed; before that only `built` (or nothing) exists.
      const scene = handle.current ?? built;
      handle.current = null;
      built = null;
      scene?.dispose();
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the scene reads the inputs through `live`; the deps are the wake triggers
  useEffect(() => {
    handle.current?.update(live.current);
  }, [props.state, props.theme, props.paused, props.liftPx, reducedMotion]);

  // No aria-hidden: a canvas exposes nothing to assistive tech by itself,
  // and the card's aria-label carries the device state.
  return <canvas ref={canvasRef} className="device-scene-canvas" />;
}
