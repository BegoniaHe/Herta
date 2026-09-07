import type {
  ListTransitionOpts,
  TransitionRow,
} from "../../hooks/useListTransitions.js";

/**
 * The rail cards' row motion (ADR 0058 §5.7), shared by the repository,
 * plan and trace cards: a row that arrives eases in where it sits, a row
 * that leaves eases out where it was. Lengths MUST match
 * `.plan-card__row.is-entering` / `.is-leaving` in reference-ux.css.
 */
export const CARD_ROW_ENTER_MS = 300;
export const CARD_ROW_LEAVE_MS = 220;

/** The hook options for a card: motion off under reduced motion, and off
 *  until the card's first content has been on screen (`settled`) — the
 *  card's own slide is its entrance; the rows move for CHANGES after it. */
export function cardRowMotion(
  reduced: boolean,
  settled: boolean,
): ListTransitionOpts {
  return {
    enterMs: CARD_ROW_ENTER_MS,
    leaveMs: CARD_ROW_LEAVE_MS,
    reduced: reduced || !settled,
  };
}

/** The class a row's phase adds; "" when settled. */
export function rowPhaseClass(phase: TransitionRow<unknown>["phase"]): string {
  return phase === "enter"
    ? " is-entering"
    : phase === "leave"
      ? " is-leaving"
      : "";
}
