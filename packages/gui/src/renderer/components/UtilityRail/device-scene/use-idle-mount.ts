import { useEffect, useState } from "react";

/**
 * Gate for mounting something heavy that the boot must not wait for (ADR
 * 0057 §2.9: the 3D device's three.js chunk, its 3.6 MB of assets, two
 * transcoder workers and a 0.5 s synchronous first frame). Returns true no
 * sooner than `settleMs` after `wanted` became true, and then only from an
 * idle callback — or its `timeoutMs` deadline, so a busy session still gets
 * the scene. Falls back to a plain timer where `requestIdleCallback` is
 * missing (jsdom). Flips back to false as soon as `wanted` does.
 */
export function useIdleMount(
  wanted: boolean,
  settleMs = IDLE_MOUNT_SETTLE_MS,
  timeoutMs = IDLE_MOUNT_TIMEOUT_MS,
): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!wanted) {
      setReady(false);
      return;
    }
    return scheduleIdle(() => setReady(true), settleMs, timeoutMs);
  }, [wanted, settleMs, timeoutMs]);
  return wanted && ready;
}

/** The boot's own work (first paint, the session list, the record) is done
 *  well inside this on the machines measured; the scene starts after it. */
export const IDLE_MOUNT_SETTLE_MS = 800;
/** The latest the scene starts, idle or not. */
export const IDLE_MOUNT_TIMEOUT_MS = 3000;

interface IdleWindow {
  requestIdleCallback?: (cb: () => void, opts: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
}

/** Runs `fn` once, after `settleMs`, in the next idle slot (or by
 *  `timeoutMs` after that). Returns the cancel. */
export function scheduleIdle(
  fn: () => void,
  settleMs: number,
  timeoutMs: number,
): () => void {
  const w = window as unknown as IdleWindow;
  let idleId: number | null = null;
  const timer = setTimeout(() => {
    if (typeof w.requestIdleCallback === "function") {
      idleId = w.requestIdleCallback(fn, { timeout: timeoutMs });
    } else {
      fn();
    }
  }, settleMs);
  return () => {
    clearTimeout(timer);
    if (idleId !== null) w.cancelIdleCallback?.(idleId);
  };
}
