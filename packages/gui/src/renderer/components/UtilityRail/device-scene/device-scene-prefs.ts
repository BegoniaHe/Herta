import { useSyncExternalStore } from "react";
import type { HertaBridge } from "../../../ipc/bridge-types.js";

/**
 * The 3D device card preference (ADR 0057), mirrored in the renderer so the
 * card and the Settings toggle share one live value (the voice-prefs
 * pattern, but persisted through the bridge rather than localStorage: the
 * value belongs to the user's settings.json like the theme does).
 *
 *   null   — unknown yet, or the bridge has no surface for it (fakes, the
 *            website demo): the card keeps its flat renders, the row hides.
 *   bool   — the persisted choice.
 */
export type DeviceScenePref = boolean | null;

let value: DeviceScenePref = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: DeviceScenePref): void {
  if (next === value) return;
  value = next;
  for (const l of listeners) l();
}

export function deviceScenePref(): DeviceScenePref {
  return value;
}

export function subscribeDeviceScenePref(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Read the persisted value once per renderer lifetime. Idempotent: the card
 * and the Settings pane both call it on mount and share the one round-trip.
 * A bridge without the surface resolves to null (the row hides, the card
 * stays flat); a failed read does the same rather than guessing.
 */
export function loadDeviceScenePref(bridge: HertaBridge): Promise<void> {
  if (loading !== null) return loading;
  const read = bridge.getDeviceScene;
  if (read === undefined) {
    set(null);
    loading = Promise.resolve();
    return loading;
  }
  loading = read
    .call(bridge)
    .then((v) => set(v === true))
    .catch(() => set(null));
  return loading;
}

/** Apply a user pick locally (optimistic); the caller persists it. */
export function setDeviceScenePrefLocal(next: boolean): void {
  set(next);
}

/** React binding. */
export function useDeviceScenePref(): DeviceScenePref {
  return useSyncExternalStore(subscribeDeviceScenePref, deviceScenePref);
}

/** Test hook: forget the value and the in-flight load. */
export function resetDeviceScenePrefForTest(): void {
  value = null;
  loading = null;
  listeners.clear();
}
