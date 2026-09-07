import { useEffect, useMemo } from "react";
import { useApprovalPending } from "../../hooks/useApprovalPending.js";
import {
  useSessionScoped,
  useSessionScopedRef,
  useSessionScopedTimer,
} from "../../hooks/useSessionScoped.js";
import { useSessionSelector } from "../../hooks/useSessionSelector.js";
import { planScope } from "../Workspace/plan-context.js";
import {
  settleTrace,
  type TraceContext,
  traceScope,
} from "../Workspace/trace-context.js";
import { PLAN_HOLD_MS, PLAN_SLIDE_MS } from "./usePlanCard.js";

/** Mirrors usePlanCard's unmount slack — same two-phase retire, same
 *  asymmetric failure directions (late = a moment of collapsed box; early =
 *  content torn out mid-slide). */
const TRACE_UNMOUNT_SLACK_MS = 120;

export interface TraceCardState {
  readonly trace: TraceContext | null;
  readonly open: boolean;
  /** Parked on a permission gate: the newest op is WAITING, not being
   *  worked — the card's live meter stills (same discipline as PlanCard's
   *  is-waiting, audit 2026-07-26). */
  readonly waiting: boolean;
  /** A first trace has been on screen: appended ops are CHANGES and enter
   *  with the row motion (ADR 0058 §5.7); false while the card retracts. */
  readonly settled: boolean;
}

/**
 * The rail 操作轨迹 card's visibility (2026-08-17) — usePlanCard's shape,
 * point for point (session-scoped state, hold-then-slide retract, the
 * unknown-scope hold), with one extra rule:
 *
 * **PlanCard wins the slot.** The trace is the fallback surface for a
 * dispatch with no 任务清单 — every 极简 dispatch (ADR 0040 ships no todo
 * tool) and the 标准 briefs where 板砖 skips the list. The moment a todo
 * projection exists for the current dispatch, this card clears IMMEDIATELY
 * (no hold, no slide — the plan card is already sliding in over the same
 * rail position, and two cards narrating one dispatch would stack). While a
 * held PLAN is on screen after its run, `planScope` still reports it, so
 * the suppression covers the hold window too.
 *
 * Timers share PlanCard's constants so the two cards leave with the same
 * rhythm — the rail has one retire gesture, not two.
 */
export function useTraceCard(): TraceCardState {
  const record = useSessionSelector((s) => s.record);
  const waiting = useApprovalPending();
  // One scan per record commit (not per streaming delta) — same memo shape
  // as usePlanCard.
  const scope = useMemo(() => traceScope(record), [record]);
  const plan = useMemo(() => planScope(record), [record]);

  const [trace, setTrace] = useSessionScoped<TraceContext | null>(null);
  const [open, setOpen] = useSessionScoped(false);
  const [settled, setSettled] = useSessionScoped(false);
  const showing = useSessionScopedRef(false);
  const retract = useSessionScopedTimer();
  const unmount = useSessionScopedTimer();

  useEffect(() => {
    if (plan.kind === "plan") {
      // The plan owns the slot — stand down without ceremony.
      retract.clear();
      unmount.clear();
      showing.current = false;
      setOpen(false);
      setTrace(null);
      return;
    }
    if (scope.kind === "trace") {
      retract.clear();
      unmount.clear();
      setTrace(scope.trace);
      setOpen(true);
      showing.current = true;
      return;
    }
    if (scope.kind === "unknown") return;
    if (!showing.current) return;
    // "ended": the held view settles its running tail — the marker landed,
    // nothing is in flight anymore (settleTrace is idempotent).
    if (scope.kind === "ended") {
      setTrace((prev) => (prev === null ? prev : settleTrace(prev)));
    }
    retract.arm(() => {
      showing.current = false;
      setOpen(false);
      unmount.arm(() => setTrace(null), PLAN_SLIDE_MS + TRACE_UNMOUNT_SLACK_MS);
    }, PLAN_HOLD_MS);
  }, [scope, plan, retract, unmount, setTrace, setOpen, showing]);

  // One commit behind what is on screen — usePlanCard's own latch.
  useEffect(() => {
    setSettled(open && trace !== null);
  }, [open, trace, setSettled]);

  return { trace, open, waiting, settled };
}
