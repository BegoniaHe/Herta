import { useEffect, useMemo, useRef } from "react";
import { useListTransitions } from "../../hooks/useListTransitions.js";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import { useT } from "../../i18n/LocaleProvider.js";
import { VERB_KEY } from "../Workspace/step-display.js";
import type { TraceNote, TraceOp } from "../Workspace/trace-context.js";
import { useScrollEdges } from "../Workspace/useScrollEdges.js";
import {
  CARD_ROW_ENTER_MS,
  cardRowMotion,
  rowPhaseClass,
} from "./card-motion.js";
import { useTraceCard } from "./useTraceCard.js";

/**
 * 板砖's 操作轨迹 as a rail card — the plan card's sibling and fallback
 * (2026-08-17). For a dispatch with no 任务清单 (every 极简 run, and the
 * 标准 briefs that skip the list) the rail used to show only the device
 * ring: THAT it was busy, never WHAT it was doing, while the conversation's
 * op rows scrolled away. This pins the record's own op rows — same strings,
 * same D7 sourcing as PlanCard; nothing here is a new channel.
 *
 * Design language: it RIDES the .plan-card chrome classes (glass, slide-in,
 * fog, mark triad) so the rail has one card family, with a `trace-card`
 * variant for what differs — an indeterminate sweep meter while the run is
 * live (the todo card's determinate fill has a denominator; a trace does
 * not), one-line ellipsized rows with a dim result note, and a follow-tail
 * list that tracks the newest op. Per the 2026-07-27 form-not-motion rule
 * the row marks are static (▸ caret = the op in flight); the meter's sweep
 * is the card's single IDLE moving element, and `is-waiting` stills it —
 * parked on a permission gate, nothing is being worked (audit 2026-07-26).
 * Rows move on CHANGE (ADR 0058 §5.7, the family's shared motion): an op
 * that lands eases in at the tail, a row the sliding window drops eases
 * out at the head; the first trace lands still with the card's slide.
 */
export function TraceCard(): JSX.Element | null {
  const t = useT();
  const { trace, open, waiting, settled } = useTraceCard();
  const reduced = useReducedMotion();
  const listRef = useRef<HTMLOListElement>(null);
  const edges = useScrollEdges(listRef, trace);

  // Keyed by the op's ORDINAL within the whole dispatch, not the window
  // index: once the list trims to its cap the window slides, and index keys
  // would remount every row per append — replaying the entrance on the
  // entire list.
  const keyed = useMemo(
    () =>
      (trace?.ops ?? EMPTY).map((op, i) => ({
        id: String((trace?.firstOrdinal ?? 0) + i),
        op,
      })),
    [trace],
  );
  const rows = useListTransitions(
    keyed,
    keyOf,
    cardRowMotion(reduced, settled),
  );

  // Follow the tail: the newest op is the one being watched. A reader who
  // scrolled up to inspect an earlier row keeps their place (the pin releases
  // beyond ~1½ rows of drift) — same courtesy the conversation's own
  // autoscroll extends. An entering row opens from zero height, so the
  // tail is followed again once its entrance has ended — otherwise the
  // scroll stopped short by the row's final height.
  const ops = trace?.ops;
  useEffect(() => {
    const el = listRef.current;
    if (el === null || ops === undefined) return;
    const follow = (): void => {
      const drift = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (drift < 40 || el.scrollTop === 0) el.scrollTop = el.scrollHeight;
    };
    follow();
    const t = setTimeout(follow, CARD_ROW_ENTER_MS + 20);
    return () => clearTimeout(t);
  }, [ops]);

  if (trace === null) return null;

  const noteText = (note: TraceNote): string => {
    switch (note.kind) {
      case "exit":
        return `${t("activity.result.exit")} ${note.code}`;
      case "signal":
        return t("activity.bg.signal");
      case "tests":
        return `${t("activity.result.tests")} ${note.summary}`;
      case "fail":
        return note.code;
      case "matches":
        return `${note.n} ${t("activity.result.matches")}`;
    }
  };

  // Counts cover the WHOLE dispatch; the list below is the recent window
  // (trace-context trims to TRACE_MAX_ROWS so a long run cannot grow the
  // DOM without bound; the list's CSS max-height bounds the card itself).
  const counts = [t("trace.card.steps", { n: String(trace.steps) })];
  if (trace.writes > 0) {
    counts.push(t("trace.card.files", { n: String(trace.writes) }));
  }

  return (
    <section
      className={`plan-card trace-card${open ? " is-open" : ""}${
        waiting ? " is-waiting" : ""
      }`}
      data-testid="trace-card"
      aria-label={t("trace.card.title")}
      aria-hidden={!open}
    >
      <header className="plan-card__head">
        <span className="plan-card__title">{t("trace.card.title")}</span>
        <span className="plan-card__count">{counts.join(" · ")}</span>
      </header>
      {/* No denominator, so no fill fraction: while the run is live the
          meter carries a slow sweep (the card's one moving element); settled,
          it rests as a solid line — the same "done" register as the plan
          meter reaching its end. */}
      <div className="plan-card__meter" aria-hidden="true">
        <span
          className={`trace-card__meter-fill${trace.running ? " is-live" : ""}`}
        />
      </div>
      <ol
        ref={listRef}
        className={`plan-card__list${edges.top ? " has-fog-top" : ""}${
          edges.bottom ? " has-fog-bottom" : ""
        }`}
      >
        {rows.map((row) => {
          const op = row.item.op;
          return (
            <li
              key={row.key}
              className={`plan-card__row trace-card__row is-${op.status}${rowPhaseClass(row.phase)}`}
              aria-hidden={row.phase === "leave" || undefined}
            >
              <span className="plan-card__mark" aria-hidden="true">
                {op.status === "ok" && (
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
                {op.status === "fail" && (
                  <svg
                    viewBox="0 0 10 10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M2 2l6 6M8 2l-6 6" />
                  </svg>
                )}
                {op.status === "running" && (
                  <svg
                    className="plan-card__caret"
                    viewBox="0 0 8 10"
                    aria-hidden="true"
                  >
                    <path d="M1.4 1.6l5.2 3.4-5.2 3.4z" />
                  </svg>
                )}
              </span>
              <span className="trace-card__text" title={opTitle(op, t)}>
                <span className="trace-card__verb">{verbText(op, t)}</span>{" "}
                {op.arg}
              </span>
              {op.note !== undefined && (
                <span
                  className={`trace-card__note${
                    op.status === "fail" ? " is-fail" : ""
                  }`}
                >
                  {noteText(op.note)}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const EMPTY: readonly TraceOp[] = [];
const keyOf = (k: { readonly id: string }): string => k.id;

type T = ReturnType<typeof useT>;

/** Localized verb via the record rows' own map; an unknown verb (a newer
 *  record on an older renderer) falls back to the raw token rather than a
 *  blank. */
function verbText(op: TraceOp, t: T): string {
  const key = VERB_KEY[op.verb];
  return key !== undefined ? t(key) : op.verb;
}

/** Full row text for the hover title — the visible row ellipsizes. */
function opTitle(op: TraceOp, t: T): string {
  return `${verbText(op, t)} ${op.arg}`;
}
