import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDLE_MOUNT_SETTLE_MS,
  IDLE_MOUNT_TIMEOUT_MS,
  scheduleIdle,
  useIdleMount,
} from "./use-idle-mount.js";

// lib.dom types requestIdleCallback as always present; the hook treats it
// as optional (jsdom has none), so the stubs go in untyped.
type IdleWindow = Record<string, unknown>;

describe("useIdleMount (ADR 0057 §2.9)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    (window as unknown as IdleWindow).requestIdleCallback = undefined;
    (window as unknown as IdleWindow).cancelIdleCallback = undefined;
  });

  it("stays false while not wanted, and never schedules", () => {
    const { result } = renderHook(() => useIdleMount(false));
    act(() => {
      vi.advanceTimersByTime(IDLE_MOUNT_TIMEOUT_MS * 2);
    });
    expect(result.current).toBe(false);
  });

  it("without requestIdleCallback (jsdom) it flips after the settle delay, not before", () => {
    const { result } = renderHook(() => useIdleMount(true));
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(IDLE_MOUNT_SETTLE_MS - 1);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it("with requestIdleCallback it waits the settle delay, then asks for an idle slot with the deadline", () => {
    const idle = vi.fn<(cb: () => void, o: { timeout: number }) => number>(
      () => 7,
    );
    (window as unknown as IdleWindow).requestIdleCallback = idle;
    const { result } = renderHook(() => useIdleMount(true));
    act(() => {
      vi.advanceTimersByTime(IDLE_MOUNT_SETTLE_MS);
    });
    expect(idle).toHaveBeenCalledTimes(1);
    expect(idle.mock.calls[0]?.[1]).toEqual({ timeout: IDLE_MOUNT_TIMEOUT_MS });
    expect(result.current).toBe(false);
    act(() => {
      idle.mock.calls[0]?.[0]();
    });
    expect(result.current).toBe(true);
  });

  it("turning the want off cancels a pending idle request and drops the flag", () => {
    const idle = vi.fn(() => 11);
    const cancel = vi.fn();
    (window as unknown as IdleWindow).requestIdleCallback = idle;
    (window as unknown as IdleWindow).cancelIdleCallback = cancel;
    const { result, rerender } = renderHook(
      ({ wanted }: { wanted: boolean }) => useIdleMount(wanted),
      { initialProps: { wanted: true } },
    );
    act(() => {
      vi.advanceTimersByTime(IDLE_MOUNT_SETTLE_MS);
    });
    expect(idle).toHaveBeenCalledTimes(1);
    rerender({ wanted: false });
    expect(cancel).toHaveBeenCalledWith(11);
    expect(result.current).toBe(false);
    // Wanting it again starts a fresh wait.
    rerender({ wanted: true });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(IDLE_MOUNT_SETTLE_MS);
    });
    expect(idle).toHaveBeenCalledTimes(2);
  });

  it("scheduleIdle's cancel before the settle delay means the callback never runs", () => {
    const fn = vi.fn();
    const cancel = scheduleIdle(fn, 500, 1000);
    vi.advanceTimersByTime(499);
    cancel();
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });
});
