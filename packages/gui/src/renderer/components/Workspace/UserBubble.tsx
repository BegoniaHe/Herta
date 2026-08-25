import { memo, type Ref } from "react";
import { useT } from "../../i18n/LocaleProvider.js";
import { renderBanzhuanText } from "../../lib/banzhuan-text.js";
import { Tooltip } from "../Tooltip/Tooltip.js";
import { BubbleTime } from "./BubbleTime.js";

/**
 * Rewind / undo glyph — Heroicons arrow-uturn-down (from
 * `reference_UX_design/icons/RewindIcon_outline.svg`). Rendered inline so CSS
 * owns size + stroke-width + hover color (see `.message-rewind-svg`).
 */
function RewindIcon(): JSX.Element {
  return (
    <svg
      className="message-rewind-svg"
      data-icon="rewind"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m15 15-6 6m0 0-6-6m6 6V9a6 6 0 0 1 12 0v3" />
    </svg>
  );
}

export interface UserBubbleProps {
  readonly text: string;
  /** ISO send time (the block's stamped `at`); the adaptive label is derived
   *  in the BubbleTime leaf, off the shared coarse clock. Omitted for
   *  pre-timestamp blocks → the line is hidden rather than showing a
   *  fabricated time. */
  readonly at?: string;
  /** When true, the bubble is kept in layout (holds its slot) but invisible —
   *  used while the send morph's flying clone rises to this slot. */
  readonly hidden?: boolean;
  /** Ref to the inner .message-bubble, so the morph can measure the slot. */
  readonly bubbleRef?: Ref<HTMLDivElement>;
  /** When set, a rewind control shows in the hover action row — only the LATEST
   *  user turn, only when idle. Clicking withdraws this turn (and everything
   *  below it) and restores its text to the composer. */
  readonly onRewind?: () => void;
  /** ABSOLUTE record index, stamped as `data-abs-index` on the row so the
   *  topic rail's jump can find its anchor block in the DOM. */
  readonly absIndex?: number;
  /** Conversation language for the 板砖→Brick display alias (default "zh"). */
  readonly lang?: "zh" | "en";
}

/** memo: bails historical bubbles out of Conversation's per-delta re-renders
 *  (props are primitives + the stable rewind callback / bubbleRef). */
export const UserBubble = memo(function UserBubble(
  props: UserBubbleProps,
): JSX.Element {
  const t = useT();
  const lang = props.lang ?? "zh";
  const hasActions = props.onRewind !== undefined || props.at !== undefined;
  return (
    <div
      className="message-row user-row"
      data-abs-index={props.absIndex}
      style={props.hidden ? { visibility: "hidden" } : undefined}
    >
      <div ref={props.bubbleRef} className="message-bubble user-bubble">
        <div className="message-text">
          {renderBanzhuanText(props.text, "bubble", lang)}
        </div>
      </div>
      {/* Hover-revealed action row BELOW the bubble (a sibling, not a child) —
          Codex/Claude-style: [rewind] … timestamp, shown only on bubble hover. */}
      {hasActions && (
        <div className="message-actions">
          {props.onRewind !== undefined && (
            <Tooltip label={t("workspace.rewind")} placement="bottom">
              <button
                type="button"
                className="message-rewind"
                aria-label={t("workspace.rewind")}
                onClick={props.onRewind}
              >
                <RewindIcon />
              </button>
            </Tooltip>
          )}
          {props.at !== undefined && <BubbleTime at={props.at} />}
        </div>
      )}
    </div>
  );
});
