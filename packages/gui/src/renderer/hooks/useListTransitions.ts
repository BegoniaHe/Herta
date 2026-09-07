import { useEffect, useRef, useState } from "react";

/** One rendered row of a keyed list, with the phase its motion is in. */
export interface TransitionRow<T> {
  readonly key: string;
  readonly item: T;
  /** `enter`: appeared since the last render (plays the entrance once);
   *  `steady`: settled; `leave`: gone from the source, kept on screen for
   *  the exit before it is dropped. */
  readonly phase: "enter" | "steady" | "leave";
}

export interface ListTransitionOpts {
  /** How long a leaving row stays mounted — MUST match the CSS exit. */
  readonly leaveMs: number;
  /** How long a row keeps its `enter` phase — the CSS entrance's length. */
  readonly enterMs: number;
  /** Reduced motion: rows appear and vanish in place; no phases. */
  readonly reduced: boolean;
}

/**
 * Keyed list presence for the rail cards' rows (ADR 0058 §5.7): a row
 * that arrives gets one entrance, a row that leaves gets one exit before
 * it is dropped, and the rows between them keep their places. The FIRST
 * render never animates — a card that slides in with its rows already
 * settled is the card family's entrance; the rows' own motion is for
 * CHANGES after that (a probe answering with one more file, a commit
 * moving a path off the list).
 *
 * Order: the source's order for present rows; a leaving row keeps the
 * index it had, so the exit plays where the row was and nothing below it
 * jumps before the collapse. Phases are state, not DOM classes measured
 * back — the rows are plain markup and the CSS owns the curves.
 */
export function useListTransitions<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  opts: ListTransitionOpts,
): readonly TransitionRow<T>[] {
  const { leaveMs, enterMs, reduced } = opts;
  const [rows, setRows] = useState<readonly TransitionRow<T>[]>(() =>
    items.map((item) => ({ key: keyOf(item), item, phase: "steady" })),
  );
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const first = useRef(true);

  useEffect(() => {
    const prev = rowsRef.current;
    const prevByKey = new Map(prev.map((r) => [r.key, r]));
    const nextKeys = new Set(items.map(keyOf));
    const fresh = first.current;
    first.current = false;

    const next: TransitionRow<T>[] = items.map((item) => {
      const key = keyOf(item);
      const before = prevByKey.get(key);
      // A key that was leaving and came back is simply present again.
      const phase: TransitionRow<T>["phase"] =
        before !== undefined && before.phase !== "leave"
          ? before.phase
          : fresh || reduced
            ? "steady"
            : "enter";
      return { key, item, phase };
    });
    if (!reduced) {
      // Leaving rows keep their old index (clamped to the new length).
      prev.forEach((r, index) => {
        if (nextKeys.has(r.key)) return;
        const leaving: TransitionRow<T> = { ...r, phase: "leave" };
        next.splice(Math.min(index, next.length), 0, leaving);
      });
    }
    setRows(next);

    // One timer per keyed phase: entrances settle, exits drop the row.
    for (const r of next) {
      if (r.phase === "steady" || timers.current.has(r.key)) continue;
      const ms = r.phase === "enter" ? enterMs : leaveMs;
      const t = setTimeout(() => {
        timers.current.delete(r.key);
        setRows((cur) =>
          r.phase === "leave"
            ? cur.filter((x) => !(x.key === r.key && x.phase === "leave"))
            : cur.map((x) =>
                x.key === r.key && x.phase === "enter"
                  ? { ...x, phase: "steady" }
                  : x,
              ),
        );
      }, ms);
      timers.current.set(r.key, t);
    }
    // A leaving row that came back must not be dropped by its stale exit.
    for (const r of next) {
      if (r.phase !== "leave") {
        const stale = prevByKey.get(r.key);
        if (stale?.phase === "leave") {
          const t = timers.current.get(r.key);
          if (t !== undefined) clearTimeout(t);
          timers.current.delete(r.key);
        }
      }
    }
  }, [items, keyOf, leaveMs, enterMs, reduced]);

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);

  return rows;
}
