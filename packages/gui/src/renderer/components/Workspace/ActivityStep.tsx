import { useState } from "react";
import type { TFn } from "../../i18n/LocaleProvider.js";
import { Tooltip } from "../Tooltip/Tooltip.js";
import { CollapsibleBody } from "./CollapsibleBody.js";
import { useUnpinConversation } from "./ConversationPin.js";
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
   * A patch row's magnitude (2026-08-25) — rendered as an animated element in
   * place of the body's first line, because the digits count up.
   *
   * A write used to be the one operation with no `↳` outcome row; its patch
   * block said `patch preview: <files>`, which restates the `Writing` row
   * above it and says nothing about size.
   */
  readonly stat?: DiffStatValue;
  /** Localized text for a change with no per-file diff (a command wrote it).
   *  Required when `stat` is set. */
  readonly statUnmeasuredLabel?: string;
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
        <div className="activity-step__headline">
          <CollapsibleBody
            body={body}
            preClassName="activity-step__body"
            t={props.t}
            {...(props.stat !== undefined
              ? {
                  headline: (
                    <DiffStat
                      value={props.stat}
                      unmeasuredLabel={props.statUnmeasuredLabel ?? ""}
                    />
                  ),
                }
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
