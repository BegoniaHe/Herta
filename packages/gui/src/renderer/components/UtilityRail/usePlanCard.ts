import { useEffect, useMemo } from "react";
import { useApprovalPending } from "../../hooks/useApprovalPending.js";
import {
  useSessionScoped,
  useSessionScopedRef,
  useSessionScopedTimer,
} from "../../hooks/useSessionScoped.js";
import { useSessionSelector } from "../../hooks/useSessionSelector.js";
import { type PlanContext, planScope } from "../Workspace/plan-context.js";

/**
 * How long the settled plan stays on screen after the dispatch ends, before
 * the card slides back.
 *
 * The retract is keyed to the DISPATCH ending, not to the last item flipping
 * to `completed`. Two reasons, both load-bearing:
 *   - a run can end `blocked` / `partial` with items still open (ADR 0025
 *     folds the unfinished tail into the report), so "every item done" is not
 *     reachable in those runs at all — the card would never leave;
 *   - the last item can flip a beat BEFORE the done-marker lands, so
 *     retracting on it would pull the plan away at exactly the moment the
 *     outcome arrives.
 * Holding past the end also lets the reader watch the finished checklist
 * settle. Sized like the device card's success flash (1800ms) so the card
 * leaving and the device's 完成 flash read as one gesture.
 */
export const PLAN_HOLD_MS = 1800;

/**
 * The slide-back's duration — MUST match `.plan-card`'s transform transition
 * in reference-ux.css. The card unmounts this long after `open` goes false.
 *
 * Why unmount at all, when the card is already translated off-rail with
 * `content-visibility: hidden`: that hides the CONTENTS, but the element's own
 * padding box keeps its place in the rail's flex column — measured, a
 * retracted card left 48px of dead space (28px collapsed box + the 20px flex
 * gap) hanging under the device card for the rest of the session. Unmounting
 * only AFTER the slide has finished keeps the card's content on screen
 * throughout the animation, which is why this is a second phase and not just
 * clearing the plan on retract.
 */
export const PLAN_SLIDE_MS = 640;

/**
 * Slack added to {@link PLAN_SLIDE_MS} before the card is dropped.
 *
 * The duration lives in two places (here and the CSS) and the two failure
 * directions are NOT symmetric: unmounting LATE just leaves the collapsed box
 * a moment longer, while unmounting EARLY tears the content out mid-slide and
 * collapses the box on screen — the exact artefact this phase exists to
 * avoid. So the timer deliberately runs long. (A `transitionend` listener
 * would track the CSS exactly but never fires under
 * `prefers-reduced-motion`, where the transition is removed — that trade is
 * strictly worse: the card would then never unmount at all.)
 */
const PLAN_UNMOUNT_SLACK_MS = 120;

export interface PlanCardState {
  /** The plan to draw, or null when the card should not be mounted. */
  readonly plan: PlanContext | null;
  /** Whether the card should be slid OUT. */
  readonly open: boolean;
  /** The run is parked on a permission gate: the step marked in_progress is
   *  NOT being worked, it is waiting on the user. The card stops claiming
   *  otherwise (the device card beside it already shows 待批准). */
  readonly waiting: boolean;
  /** A first plan has been on screen: later plans are CHANGES, and their
   *  rows may move (ADR 0058 §5.7). False again while the card retracts,
   *  so the next dispatch's plan arrives settled with the card's slide. */
  readonly settled: boolean;
}

/**
 * The rail plan card's visibility, derived from the active session.
 *
 * `planScope` reports WHY there is no plan rather than just that there is
 * none, because this hook RETRACTS on that answer and the two causes are not
 * interchangeable: a terminal marker means the run is over, while a window
 * trim means the renderer dropped the rows and nothing can be concluded. The
 * card holds through the latter.
 *
 * Everything held here is session-scoped (audit 2026-07-24): a plan, an
 * "is showing" latch, and two pending timers that belong to session A must
 * not describe — or fire against — session B. The rail is mounted for the
 * app's lifetime, so nothing else would ever clear them.
 */
export function usePlanCard(): PlanCardState {
  const record = useSessionSelector((s) => s.record);
  const waiting = useApprovalPending();
  // Memoized on the record like Conversation's: the store mints a fresh
  // snapshot per assistant.delta, but `record` only changes when a block
  // commits, so this scan does not run per token.
  const scope = useMemo(() => planScope(record), [record]);

  const [plan, setPlan] = useSessionScoped<PlanContext | null>(null);
  const [open, setOpen] = useSessionScoped(false);
  const [settled, setSettled] = useSessionScoped(false);
  /** Mirrors `open` for the effect to read without taking it as a dependency:
   *  the effect must fire on a SCOPE edge only, and depending on `open` would
   *  re-run it on its own result. */
  const showing = useSessionScopedRef(false);
  const retract = useSessionScopedTimer();
  const unmount = useSessionScopedTimer();

  useEffect(() => {
    if (scope.kind === "plan") {
      // A live plan supersedes both pending phases — including a SECOND
      // dispatch starting inside the first one's hold or slide window.
      retract.clear();
      unmount.clear();
      setPlan(scope.plan);
      setOpen(true);
      showing.current = true;
      return;
    }
    // The window truncated the scan before any boundary: this says nothing
    // about whether the run ended, so act on nothing.
    if (scope.kind === "unknown") return;
    // "ended" / "absent" are definitive. Arm the retract only when something
    // is actually on screen — otherwise every unrelated record change while
    // idle would restart the timer.
    if (!showing.current) return;
    retract.arm(() => {
      showing.current = false;
      setOpen(false);
      // Phase two: drop the card once its slide has finished, so it stops
      // holding a collapsed box in the rail's flex column.
      unmount.arm(() => setPlan(null), PLAN_SLIDE_MS + PLAN_UNMOUNT_SLACK_MS);
    }, PLAN_HOLD_MS);
  }, [scope, retract, unmount, setPlan, setOpen, showing]);

  // Settled follows what is ON SCREEN, one commit behind it: the render
  // that first draws an open plan sees `settled` false and lands the rows
  // still; this effect then arms motion for the plans after it. A retract
  // disarms, so the next dispatch's first plan is still again.
  useEffect(() => {
    setSettled(open && plan !== null);
  }, [open, plan, setSettled]);

  return { plan, open, waiting, settled };
}
