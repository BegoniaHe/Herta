import { useMemo, useRef } from "react";
import { useListTransitions } from "../../hooks/useListTransitions.js";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import { useT } from "../../i18n/LocaleProvider.js";
import type { TodoDigestItem } from "../Workspace/plan-context.js";
import { useScrollEdges } from "../Workspace/useScrollEdges.js";
import { cardRowMotion, rowPhaseClass } from "./card-motion.js";
import { usePlanCard } from "./usePlanCard.js";

/**
 * 板砖's 任务清单 (ADR 0025 todo list) as a rail card, below the device.
 *
 * Why the rail and not the conversation: the inline strip
 * (`ActivityBlock`'s `.activity-plan`) lives INSIDE the scrolling transcript,
 * so scrolling up mid-run to re-read something takes the plan with it — the
 * one moment you most want it pinned. The rail is fixed, and it is already
 * 板砖's own column: the device card is the machine, this is what the machine
 * is working through.
 *
 * The inline strip stays as the NARROW-window fallback. The rail is
 * `display:none` under 900px (and narrows at 1200px), so a plan living only
 * here would vanish entirely on a small window. Which one shows is decided by
 * a media query alone — no viewport state in JS, nothing to go stale.
 *
 * Item text is backend-authored and renders VERBATIM (D7): the same string the
 * record shows Herta. Only the chrome around it localizes, on the UI locale —
 * this card is app chrome in 板砖's column, not a projection OF the record, so
 * unlike `ActivityBlock` (ADR 0018/0019) it follows `useT()` like its sibling
 * the device card.
 *
 * Rows move on CHANGE (ADR 0058 §5.7, the family's shared motion): a step
 * 板砖 adds eases in at its place, a step it drops eases out; a status flip
 * still only eases its colour. The first plan lands still with the card's
 * slide. Rows are keyed by position — todo_write is full-list replacement,
 * so item text is neither unique nor stable — which means a reworded row
 * simply repaints, and only a change in COUNT moves.
 */
export function PlanCard(): JSX.Element | null {
  const t = useT();
  const { plan, open, waiting, settled } = usePlanCard();
  const reduced = useReducedMotion();
  // Scroll-edge fog, same mechanism as the sidebar list and the conversation:
  // an edge only fogs when content actually overflows it. `plan` is the
  // re-observe signal — the rows are React-minted, so the hook's one-shot
  // child snapshot would otherwise go stale as steps come and go (the M5
  // failure the sidebar hit).
  const listRef = useRef<HTMLOListElement>(null);
  const edges = useScrollEdges(listRef, plan);

  const keyed = useMemo(
    () =>
      (plan?.itemsKnown === true ? plan.items : EMPTY).map((item, i) => ({
        id: String(i),
        item,
      })),
    [plan],
  );
  const rows = useListTransitions(
    keyed,
    keyOf,
    cardRowMotion(reduced, settled),
  );

  // Never mounted for a session that has had no plan at all — the rail should
  // not reserve space for a card that has never appeared.
  if (plan === null) return null;

  const pct = plan.total === 0 ? 0 : (plan.completed / plan.total) * 100;

  return (
    <section
      // `is-waiting` stills the in-flight row's pulse: parked on a permission
      // gate, the step marked in_progress is NOT being worked — it is waiting
      // on the user. Without this the card pulsed "happening now" while the
      // device card beside it correctly read 待批准, so two surfaces described
      // the same instant differently (audit 2026-07-26).
      className={`plan-card${open ? " is-open" : ""}${
        waiting ? " is-waiting" : ""
      }`}
      data-testid="plan-card"
      aria-label={t("plan.card.title")}
      aria-hidden={!open}
    >
      <header className="plan-card__head">
        <span className="plan-card__title">{t("plan.card.title")}</span>
        <span className="plan-card__count">
          {plan.completed}/{plan.total}
        </span>
      </header>
      {/* Progress is the one thing readable at a glance from across the room;
          the rows are for when you actually look. */}
      <div
        className="plan-card__meter"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={plan.total}
        aria-valuenow={plan.completed}
      >
        <span className="plan-card__meter-fill" style={{ width: `${pct}%` }} />
      </div>
      {plan.itemsKnown ? (
        <ol
          ref={listRef}
          className={`plan-card__list${edges.top ? " has-fog-top" : ""}${
            edges.bottom ? " has-fog-bottom" : ""
          }`}
        >
          {rows.map((row) => {
            const item = row.item.item;
            return (
              <li
                key={row.key}
                className={`plan-card__row is-${item.status.replace("_", "-")}${rowPhaseClass(row.phase)}`}
                aria-hidden={row.phase === "leave" || undefined}
              >
                {/* The mark triad mirrors the CLI plan strip's ✓ / ▸ / ·
                    (plan-strip.ts MARK) — the two frontends point at the
                    current step the same way. The caret is FORM, not motion:
                    after the 2026-07-27 dot redesign the record's activity LED
                    is the one pulsing element during a dispatch, and this card
                    states its facts statically. */}
                <span className="plan-card__mark" aria-hidden="true">
                  {item.status === "completed" && (
                    <svg
                      viewBox="0 0 10 10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M1.5 5.2l2.4 2.4L8.5 2.6" />
                    </svg>
                  )}
                  {item.status === "in_progress" && (
                    <svg
                      className="plan-card__caret"
                      viewBox="0 0 8 10"
                      aria-hidden="true"
                    >
                      <path d="M1.4 1.6l5.2 3.4-5.2 3.4z" />
                    </svg>
                  )}
                </span>
                <span className="plan-card__text">{item.content}</span>
              </li>
            );
          })}
        </ol>
      ) : (
        // A record persisted before the digest carried its items: the list is
        // UNKNOWN, not empty. The meter and counts are still honest, so they
        // stand alone rather than drawing a plan with no steps in it.
        <p className="plan-card__unknown">{t("plan.card.itemsUnavailable")}</p>
      )}
    </section>
  );
}

const EMPTY: readonly TodoDigestItem[] = [];
const keyOf = (k: { readonly id: string }): string => k.id;
