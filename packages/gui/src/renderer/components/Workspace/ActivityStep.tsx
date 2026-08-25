import { useLayoutEffect, useRef, useState } from "react";
import type { TFn } from "../../i18n/LocaleProvider.js";
import { Tooltip } from "../Tooltip/Tooltip.js";
import { CollapsibleBody } from "./CollapsibleBody.js";
import { useUnpinConversation } from "./ConversationPin.js";
import { DiffBody } from "./DiffBody.js";
import { DiffStat, type DiffStatValue } from "./DiffStat.js";
import { StepIcon, type StepIconKey, stepIcon } from "./step-icon.js";

export interface ActivityStepProps {
  readonly body: string;
  /** SESSION-scoped translator, forwarded to CollapsibleBody's diff toggle —
   *  the whole activity line follows the session lang (ADR 0019), and `body`
   *  arrives already localized with this same `t`. */
  readonly t: TFn;
  /** Icon key derived from the CANONICAL body (stable English verbs from
   *  workflowLabel). Pass it when `body` is a LOCALIZED display string —
   *  stepIcon can't parse a translated verb. Omitted → derived from `body`
   *  (pre-localization callers and tests). */
  readonly icon?: StepIconKey;
  /** The currently-running step shimmers (Pillar B). */
  readonly active: boolean;
  /** Failure row (tool-fail digest): distinct color + ✗ icon (2026-07-23). */
  readonly failed?: boolean;
  /**
   * The block's `evidenceDetail` — the fuller evidence Herta's prompt reads
   * (command-output tail, 改动文件 / 风险 / 待办 roll-ups). Rendered as a
   * collapsed-by-default expander (2026-07-23): the screen stays terse (the
   * original evidenceDetail design intent) while the evidence becomes
   * inspectable on demand (PHILOSOPHY §9) — before this the user could see
   * NONE of what Herta reads from these fields.
   */
  readonly detail?: string;
  /**
   * Take-back handler for an attachment row (ADR 0033, owner 2026-08-10).
   * Present only on a live, not-yet-removed attachment while the session is
   * idle — the removal rides the same out-of-turn record write as the attach,
   * so the parent withholds it mid-turn rather than letting a click earn a
   * refusal.
   */
  readonly onRemove?: () => void;
  /** Label + aria for the take-back control. Required when `onRemove` is set;
   *  passed rather than translated here so the row keeps following the SESSION
   *  lang (ADR 0019) like every other string in it. */
  readonly removeLabel?: string;
  /**
   * A standalone patch row's magnitude (2026-08-25) — rendered as an animated
   * element in place of the body's first line, because the digits count up.
   *
   * Only reached when the preview has no write to fold into (a DENIED edit:
   * the permission rule previews the patch, the tool never runs, so no
   * `Writing` row follows it). The normal case is `patch` below.
   */
  readonly stat?: DiffStatValue;
  /**
   * The patch this operation wrote, folded into the row (2026-08-25 evening).
   *
   * `patch.preview` is published by the permission RULE, which runs BEFORE
   * the tool — so the diff was projected AHEAD of its own `Writing` row and
   * the history read backwards: a wall of diff, then the action that caused
   * it. Folded here, the row states the action and its magnitude, and the
   * evidence opens underneath it on a click.
   */
  readonly patch?: {
    readonly stat: DiffStatValue;
    /** Diff content without the ```diff fence. */
    readonly diff: string;
  };
}

/** One row in an activity block: a verb icon + the (collapsible) body. */
export function ActivityStep(props: ActivityStepProps): JSX.Element {
  const icon = props.icon ?? stepIcon(props.body);
  const continuation = icon === "result" || icon === "fail";
  // The projected body carries a literal "↳ " prefix for the CLI (which has no
  // icons). In the GUI the continuation is shown by the result arrow icon, so
  // strip the literal arrow to avoid a doubled "↳ ↳".
  const body = continuation ? props.body.replace(/^\s*↳\s*/, "") : props.body;
  const [detailOpen, setDetailOpen] = useState(false);
  const unpin = useUnpinConversation();
  const hasDetail = props.detail !== undefined && props.detail.length > 0;
  const patch = props.patch;
  const [patchOpen, setPatchOpen] = useState(false);
  // Mount the diff on FIRST open and keep it mounted, so collapsing animates
  // out instead of vanishing. A closed row costs nothing until it is opened —
  // a long dispatch can carry dozens of patches, each thousands of lines.
  const [patchMounted, setPatchMounted] = useState(false);
  const foldRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = foldRef.current;
    if (el === null) return;
    // Same measured max-height reveal as the activity history panel: a px
    // target is the only way to transition to `auto`, and the scroller's
    // overflow-anchor:none keeps the growth pointing downward.
    el.style.maxHeight = patchOpen ? `${el.scrollHeight}px` : "0px";
  }, [patchOpen]);
  return (
    <div
      className={`activity-step${props.active ? " is-active" : ""}${
        continuation ? " is-continuation" : ""
      }${props.failed === true ? " is-failure" : ""}`}
    >
      <span className="activity-step__icon">
        <StepIcon kind={icon} />
      </span>
      <div className="activity-step__text">
        {/* The body and the ✕ share one row so the control tracks the
            FILENAME, not the text column (owner 2026-08-10: expanding the
            detail pane widened the column and carried the ✕ rightward with
            it). The toggle and the detail sit below, full width. */}
        {patch !== undefined ? (
          // The action states itself and its magnitude; the evidence opens
          // underneath on a click. The whole headline is the control (the
          // reference tools put the target on the file row, not on a separate
          // "expand" link), so the accessible name is the row's own text.
          <button
            type="button"
            className={`activity-step__fold-head${patchOpen ? " is-open" : ""}`}
            aria-expanded={patchOpen}
            onClick={() => {
              // Opening grows the record BELOW this row with no scroll event —
              // unpin so the follow machinery can't later yank the viewport
              // past the diff (see ConversationPin.tsx).
              if (!patchOpen) {
                unpin();
                setPatchMounted(true);
              }
              setPatchOpen((v) => !v);
            }}
          >
            <span className="activity-step__body">{body}</span>
            <DiffStat value={patch.stat} />
            <svg
              className="activity-step__fold-chevron"
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3.5 2l3 3-3 3" />
            </svg>
          </button>
        ) : (
          <div className="activity-step__headline">
            <CollapsibleBody
              body={body}
              preClassName="activity-step__body"
              t={props.t}
              {...(props.stat !== undefined
                ? { headline: <DiffStat value={props.stat} /> }
                : {})}
            />
            {props.onRemove !== undefined && (
              // The app's styled pill, not the native `title` (owner
              // 2026-08-10 — the same OS-beige-box mismatch the paperclip had),
              // and PORTALED. This row sits inside the activity history panel
              // inside the conversation scroller; an in-flow pill was cut there
              // twice, by two different causes (the panel's reveal clip, then
              // whatever paints past its bottom edge once the detail pane is
              // closed). Rendering to <body> at fixed coords ends the class —
              // nothing can clip an element it does not contain — and the
              // placement auto-flips when the viewport bottom is close.
              <Tooltip
                label={props.removeLabel ?? ""}
                placement="bottom"
                align="center"
                portal
              >
                <button
                  type="button"
                  className="activity-step__remove"
                  aria-label={props.removeLabel}
                  onClick={props.onRemove}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M3 3l6 6M9 3l-6 6" />
                  </svg>
                </button>
              </Tooltip>
            )}
          </div>
        )}
        {patch !== undefined && (
          <div
            ref={foldRef}
            className={`activity-step__fold${patchOpen ? " is-open" : ""}`}
          >
            {patchMounted && <DiffBody text={patch.diff} />}
          </div>
        )}
        {hasDetail && (
          <button
            type="button"
            className="activity-step__detail-toggle"
            aria-expanded={detailOpen}
            onClick={() => {
              // Same disclosure contract as the activity history's chevron
              // (ConversationPin.tsx), which this toggle never joined when it
              // was added: opening grows the flow BELOW the toggle, the
              // scroller's ResizeObserver watches the scroller's own box and
              // so never fires, and the focus-scroll that follows the click
              // reaches the scroll handler as a plain "reader left the
              // bottom" — lighting the jump chip nobody asked for and
              // disarming the next send's travel (owner 2026-08-10).
              if (!detailOpen) unpin();
              setDetailOpen((v) => !v);
            }}
          >
            {props.t(
              detailOpen ? "activity.detail.hide" : "activity.detail.show",
            )}
          </button>
        )}
        {hasDetail && detailOpen && (
          <pre className="activity-step__detail">{props.detail}</pre>
        )}
      </div>
    </div>
  );
}
