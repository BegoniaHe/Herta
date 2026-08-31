import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import { makeT } from "../../i18n/LocaleProvider.js";
import { useFileViewerOpen } from "../FileViewer/file-viewer-context.js";
import { ActivityStep } from "./ActivityStep.js";
import { useUnpinConversation } from "./ConversationPin.js";
import { DiffStat, type DiffStatValue } from "./DiffStat.js";
import { type DiffSummary, summarizeDiff } from "./diff-summary.js";
import {
  activityChipLabel,
  activityHasTerminalMarker,
  activityRows,
  activitySteps,
  activitySummary,
  type SystemBlock,
} from "./group-record.js";
import { composeMarkerSummary } from "./marker-summary.js";
import type { PlanContext } from "./plan-context.js";
import { SwapText } from "./SwapText.js";
import {
  latestOpStep,
  latestTodoProgressStep,
  middleTruncateName,
  stepDisplayBody,
  stepDisplayDetail,
} from "./step-display.js";
import { stepIcon } from "./step-icon.js";

export interface ActivityBlockProps {
  readonly blocks: readonly SystemBlock[];
  /** True while this is the last group and the turn is still running. */
  readonly active: boolean;
  /** Renderer turn start (Date.now); used to time a live run. */
  readonly turnStartedAt: number | null;
  /** Actual 板砖 backend start (Date.now at backend-layer turn.started);
   *  preferred over turnStartedAt as the timer anchor. */
  readonly backendStartedAt: number | null;
  /** Active session interaction language: the whole activity line (chip,
   *  markers, step verbs, duration) follows the SESSION, not the UI locale
   *  (GUI record-label parity, ADR 0018 / ADR 0015 §4). */
  readonly lang: "zh" | "en";
  /** Number of backend tool calls currently in flight (from the raw agent
   *  stream). >1 during a parallel read-only batch (ADR 0025 slice 5) —
   *  the last N op rows shimmer together instead of only the last-started
   *  one. Optional: omitted/1 keeps the classic single-row shimmer. */
  readonly inFlightCount?: number;
  /**
   * The CURRENT dispatch's 任务清单 (ADR 0025 todo list), or null when there
   * is none. A PROP, deliberately: the plan is a property of the dispatch,
   * not of the group that happens to render it — an in-turn beat splits one
   * backend run into several activity groups, and this component only ever
   * sees its OWN blocks, so a continuation group would forget the plan
   * entirely. `Conversation` scans the whole record with `planContext()` and
   * passes the result ONLY to the group it renders as active (mirroring
   * `inFlightCount`), so a historical group can never show a live plan.
   *
   * Rendered as a quiet checklist strip UNDER the status line: the strip
   * answers "where are we in the plan", the header keeps answering "what is
   * it doing this second". They are deliberately not merged.
   */
  readonly plan?: PlanContext | null;
  /**
   * Factory for an attachment row's take-back handler, or undefined when
   * removal is unavailable (no session, or a turn in flight). A FACTORY keyed
   * on the stored path rather than a handler taking one, so the row itself
   * never has to hold or forward record state.
   *
   * A prop, not a hook call here: this component is `memo`'d over a stable
   * `blocks` identity, and reaching for the bridge inside it would make every
   * historical group re-render on unrelated store churn — the same reasoning
   * that keeps `plan` a prop.
   */
  readonly onRemoveAttachment?: (path: string) => () => void;
}

/** Visible plan rows before the "+n more" tail. A bound, not a layout: real
 *  lists are 3-8 items, and an unbounded strip could push the conversation
 *  off-screen on a pathological plan. */
const PLAN_MAX_ROWS = 8;

/**
 * The magnitude recorded on a patch block, or the honest absence of one.
 *
 * The digest is the source of truth. The fallback to counting the fenced diff
 * is for records written before the `patch` digest existed (their preview is a
 * `skip` with no counts) — and it is the SAME computation the projector runs
 * at write time, not an inference, so those rows get a real number instead of
 * silence. No diff at all → `unmeasured`, which renders nothing.
 */
function patchStat(block: SystemBlock, summary?: DiffSummary): DiffStatValue {
  const d = block.digest;
  if (d?.kind === "patch" && d.add !== undefined && d.del !== undefined) {
    return { add: d.add, del: d.del };
  }
  const s = summary ?? summarizeDiff(block.body);
  if (s.hasDiff && s.diffLineCount > 0) {
    return { add: s.addCount, del: s.delCount };
  }
  return "unmeasured";
}

/** What a write's row folds in: its magnitude, and the diff it wrote. */
function foldedPatch(block: SystemBlock): {
  stat: DiffStatValue;
  diff: string;
} {
  const summary = summarizeDiff(block.body);
  return { stat: patchStat(block, summary), diff: summary.diffText };
}

function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${`${s}`.padStart(2, "0")}`;
}

/**
 * Backend activity rendered as a single live status line: pulsing LED +
 * label + the latest step swapping in place + elapsed time. Default-
 * collapsed even while running — clicking toggles the quiet hairline
 * history; the done state shows the summary + duration + chevron
 * (spec 2026-06-12 §6). Owns its own timing so a live run shows a duration
 * even though the record carries none (historical groups show no duration).
 *
 * memo: `blocks` identity is stable per record snapshot (groupRecord is
 * memoized on the record), so historical groups bail out of Conversation's
 * per-delta re-renders; the live group still updates via its own 1 Hz tick
 * and its changing props. `plan` does not weaken that: a historical group
 * receives the literal `null`, which never changes identity.
 */
export const ActivityBlock = memo(function ActivityBlock(
  props: ActivityBlockProps,
): JSX.Element {
  const { blocks, active, turnStartedAt, backendStartedAt, lang } = props;
  const inFlightCount = props.inFlightCount ?? 1;
  const plan = props.plan ?? null;
  const onRemoveAttachment = props.onRemoveAttachment;
  const t = useMemo(() => makeT(lang), [lang]);
  const chip = activityChipLabel(blocks);
  const summary = activitySummary(blocks);
  const done = activityHasTerminalMarker(blocks);
  // Localized header summary composed from the structured marker (or the
  // canonical body verbatim for pre-structured records). D7: the record body
  // is untouched; this is display-only.
  const headline =
    done && summary !== null ? composeMarkerSummary(summary, t) : null;
  const steps = activitySteps(blocks);
  // Rendered rows, not raw blocks: a patch preview folds into the write it
  // previews (the permission rule emits it BEFORE the tool runs, so the record
  // holds diff-then-action and the history read backwards). The live-line
  // lookups above stay on `steps` — a patch block is neither an op nor a todo,
  // so folding cannot change what they find.
  const rows = activityRows(blocks);
  // The terminal marker's evidenceDetail (改动文件 / 风险 / 待办 / output
  // roll-up — what Herta's prompt reads) surfaces as one expandable row at
  // the end of the history (2026-07-23).
  const markerBlock = blocks.find(
    (b) => b.role === "done-marker" || b.role === "noop-marker",
  );
  const markerDetail =
    markerBlock === undefined ? undefined : stepDisplayDetail(markerBlock, t);
  // Expandable only when there are operational rows to reveal. A group that
  // is just a terminal marker (e.g. 完成 · 1 file) has nothing behind the
  // chevron — so it gets no chevron and the line isn't a toggle (bug 1) —
  // unless the marker carries evidence detail worth expanding.
  const expandable = rows.length > 0 || markerDetail !== undefined;

  const reduced = useReducedMotion();
  const unpin = useUnpinConversation();
  // Stable opener (or null when no viewer is available — the demo, bare
  // tests): its identity never changes, so reading it here cannot
  // invalidate the load-bearing record-identity memo (ADR 0050 §1).
  const openFile = useFileViewerOpen();
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  // An all-attachment group is a USER act filed under the system chip (ADR
  // 0033): "which files did I just hand over" is the whole point of the row,
  // so it defaults OPEN — a collapsed `系统 ›` with the filenames behind a
  // click answered nothing (owner 2026-08-10). Backend activity keeps the
  // default-collapsed contract below: the line IS the rendering (F4). Mixed
  // groups (an attachment swept into a dispatch run by an edge-case record
  // tail) count as activity, not as an attach act.
  const isAttachmentGroup =
    blocks.length > 0 && blocks.every((b) => b.digest?.kind === "attachment");
  // Default-collapsed even while running — the line IS the rendering (F4).
  const expanded = expandable ? (userToggled ?? isAttachmentGroup) : false;
  // Entrance for a LIVE attach (owner 2026-08-10: the row popped in with no
  // motion). Same adopted feel as the session-switch entrance (350ms / 12px /
  // easeOutQuint — one motion vocabulary, not two). Recency-gated off the
  // block's own `at` stamp, decided ONCE at mount: a live append is seconds
  // old, a session switch or reload mounts blocks that are not — so history
  // never replays the entrance. Deliberately no store flag ("animate the next
  // group") — cross-component transient state is the exact class the
  // 2026-07-24 audit catalogued.
  const [entering, setEntering] = useState(() => {
    if (!isAttachmentGroup || reduced) return false;
    const at = blocks[blocks.length - 1]?.at;
    if (at === undefined) return false;
    const age = Date.now() - Date.parse(at);
    // `5000 > age`, not `age < 5000`: the no-hardcoded-english guard scans
    // .tsx lines for `>text<` JSX-text shapes, and the `<` here after the
    // `>=` reads as a text node ">= 0 && age<" to its regex.
    return Number.isFinite(age) && age >= 0 && 5000 > age;
  });

  const startRef = useRef<number | null>(null);
  const [frozenMs, setFrozenMs] = useState<number | null>(null);
  const [, forceTick] = useState(0);
  const lastBlockAt = blocks[blocks.length - 1]?.at;

  useEffect(() => {
    if (active) {
      if (startRef.current === null)
        startRef.current = backendStartedAt ?? turnStartedAt ?? Date.now();
      const id = window.setInterval(() => forceTick((t) => t + 1), 1000);
      return () => window.clearInterval(id);
    }
    if (startRef.current !== null && frozenMs === null) {
      setFrozenMs(Date.now() - startRef.current);
      return undefined;
    }
    // Born-done part: a beat split the run so the 完成 part was never active and
    // carries no live timing. Freeze the whole-run total from backendStartedAt —
    // captured here while it is still set (the backend turn.finished keeps it;
    // only the later actor turn-finished clears it). End at the 完成 block's own
    // timestamp so the frozen value is stable across re-renders. On a reloaded
    // session backendStartedAt is null, so historical groups stay duration-less.
    if (
      !active &&
      done &&
      frozenMs === null &&
      startRef.current === null &&
      backendStartedAt !== null
    ) {
      const parsed =
        lastBlockAt !== undefined ? Date.parse(lastBlockAt) : Number.NaN;
      const end = Number.isNaN(parsed) ? Date.now() : parsed;
      // The anchor must actually BELONG to this group (audit 2026-07-24,
      // 1.14). Nothing tied them together except the absence of the group's
      // own timing, and `backendStartedAt` is passed to EVERY group — so
      // clicking 加载更早 during a live run mounted historical rows fresh
      // (both refs null) against the running dispatch's anchor, making a past
      // multi-minute run render 用时 0s: `end - backendStartedAt` went
      // negative and the clamp below hid it. A group whose last block predates
      // the anchor cannot be part of that run.
      if (end >= backendStartedAt) setFrozenMs(end - backendStartedAt);
    }
    return undefined;
  }, [active, backendStartedAt, turnStartedAt, frozenMs, done, lastBlockAt]);

  const anchor = backendStartedAt ?? turnStartedAt;
  const elapsedMs =
    frozenMs ??
    (startRef.current !== null
      ? Date.now() - startRef.current
      : active && anchor !== null
        ? Date.now() - anchor
        : null);
  const durationText = elapsedMs === null ? null : formatDuration(elapsedMs);
  // One duration per 板砖 run, not per split part. When a beat bubble lands
  // between backend blocks it splits the run into separate activity groups;
  // only the FINAL part (the one carrying the 完成/terminal marker) shows the
  // total — anchored to backendStartedAt, so it's the whole run, not just the
  // last segment. The active part shows a live timer; the frozen intermediate
  // parts (not terminal) show nothing.
  const durationLabel =
    durationText === null
      ? null
      : active
        ? durationText
        : done
          ? `${t("workspace.took")} ${durationText}`
          : null;
  // Live line shows the latest OPERATION, localized (bugs 3+4, 2026-07-10):
  // a result row ("↳ exit 1 · 0 lines") as the "current activity" reads
  // wrong while the backend works, and the projected verbs are canonical
  // English regardless of locale. Result rows still appear in the history.
  // With a 任务清单 in play (2026-07-23, user request) the line leads with
  // the step-level context — "步骤 2/4 · <item> · 写入 x" — so the current
  // task is visible throughout, not only at the flip. Dispatches without a
  // todo list keep the op-only line.
  const latestOp = latestOpStep(steps);
  const latestTodo = latestTodoProgressStep(steps);
  const opText = latestOp !== undefined ? stepDisplayBody(latestOp, t) : "";
  const latestStep =
    latestTodo === undefined || latestTodo === latestOp
      ? opText
      : opText === ""
        ? stepDisplayBody(latestTodo, t)
        : `${stepDisplayBody(latestTodo, t)} · ${opText}`;

  // ── Live plan strip (2026-07-26) ────────────────────────────────────────
  // Derived from props every render — NO state. Anything remembered here
  // (a frozen row set, a "seen it" latch) would outlive the turn and the
  // session that produced it, which is the exact hazard class the
  // 2026-07-24 transient-state audit catalogued.
  //
  // Only while the run is LIVE: `plan` is already null for a historical
  // group (Conversation passes it to the active one only) and `planContext`
  // stops at a terminal marker, so this guard is the third, local, one —
  // the strip is live status and must vanish the moment the run ends,
  // leaving the collapsed done-marker rendering exactly as it was.
  //
  // `itemsKnown` false = a record persisted before the digest carried its
  // items: the list is UNKNOWN, not empty, so there is nothing honest to
  // draw as rows. The header's 步骤 k/n keeps working from the counts.
  const planItems = active && plan?.itemsKnown ? plan.items : undefined;
  const planRows = planItems?.slice(0, PLAN_MAX_ROWS) ?? [];
  const planHidden = (planItems?.length ?? 0) - planRows.length;

  // Animated reveal of the history (bug 2). The panel is always mounted (when
  // expandable) and grows/shrinks via a measured max-height transition, so the
  // blocks below are pushed DOWN smoothly instead of jumping. The conversation
  // scroller sets `overflow-anchor: none` so the growth always points downward
  // — without it the browser's scroll anchoring intermittently compensates
  // scrollTop and shoves the blocks ABOVE upward instead (bug 2c).
  const historyRef = useRef<HTMLDivElement>(null);
  const prevExpandedRef = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    const el = historyRef.current;
    if (el === null) return;
    const prev = prevExpandedRef.current;
    prevExpandedRef.current = expanded;
    // The panel stays `overflow: hidden` throughout (the CSS default here) so
    // the max-height reveal clips cleanly. An earlier pass lifted the clip
    // while open, to stop it cutting a row's hover tooltip; that is gone —
    // the tooltip is portaled to <body> now (see Tooltip `portal`), which
    // fixes the clipping for every ancestor rather than this one, and lets
    // the reveal keep the simple always-clipped behaviour it was written for.
    // First commit for this element: set the resting state, no animation.
    if (prev === null) {
      el.style.maxHeight = expanded ? "none" : "0px";
      return;
    }
    // Steps changed but the open/closed state held — never animate on step
    // churn; keep an open panel free-growing and a closed one collapsed.
    if (prev === expanded) {
      if (expanded) el.style.maxHeight = "none";
      return;
    }
    if (reduced) {
      el.style.maxHeight = expanded ? "none" : "0px";
      return;
    }
    if (expanded) {
      // 0 → measured content height; onTransitionEnd then releases the ceiling
      // to `none` so a later inner-diff expand isn't clipped.
      el.style.maxHeight = `${el.scrollHeight}px`;
    } else {
      // `none` → pinned px → reflow → 0, giving the collapse a start value.
      el.style.maxHeight = `${el.scrollHeight}px`;
      void el.offsetHeight;
      el.style.maxHeight = "0px";
    }
    // `steps.length` is intentionally NOT a dep: once open, onTransitionEnd
    // releases maxHeight to `none`, so later-appended steps grow freely
    // without re-running this effect.
  }, [expanded, reduced]);

  return (
    <div
      className={`activity-line-group${active ? " is-active" : ""}${
        entering ? " is-attach-enter" : ""
      }`}
      // Drop the class once it has played. `animation-fill-mode: both` keeps
      // a FINISHED animation applied, and an element with a filling
      // opacity/transform animation stays a stacking context — which would
      // trap a row's tooltip z-index inside this group forever. The entrance
      // is a one-shot; nothing should outlive it. Gated on the animation
      // NAME: React's onAnimationEnd fires for BUBBLED descendant animations
      // too, and a future child animation ending first would otherwise clear
      // the entrance mid-flight.
      onAnimationEnd={
        entering
          ? (e) => {
              if (e.animationName === "conv-switch-in") setEntering(false);
            }
          : undefined
      }
      data-testid="activity-block"
    >
      {/* The toggle shrinks to its CONTENT; the row around it holds the
          right-anchored duration (owner 2026-07-27: `.activity-line` was
          `width: 100%`, so the wide empty gap between the summary and the
          right edge was part of the button — clicking dead space expanded
          the row, and the cursor turned into a pointer over a region with
          no affordance in it at all). The clickable area is now exactly
          what it looks like: the LED, the label, the summary, the chevron. */}
      <div className="activity-line-row">
        <button
          type="button"
          className={`activity-line${expandable ? "" : " is-static"}`}
          aria-expanded={expandable ? expanded : undefined}
          onClick={
            expandable
              ? () => {
                  // Opening the history grows the record below the line with
                  // no scroll event — unpin so the follow machinery can't
                  // later yank the viewport past it (see ConversationPin.tsx).
                  if (!expanded) unpin();
                  setUserToggled(!expanded);
                }
              : undefined
          }
        >
          <span
            className={`activity-line__led${active ? " is-pulsing" : ""}`}
            aria-hidden="true"
          />
          <span className="activity-line__label">
            {t(
              chip === "差分协处理器"
                ? "record.chip.coprocessor"
                : "record.chip.system",
            )}
          </span>
          {active ? (
            <SwapText text={latestStep} reduced={reduced} shimmer />
          ) : (
            headline !== null && (
              <span className="activity-line__summary">
                {headline}
                {/* The dispatch's total, as an element so the digits count up
                    like the per-write rows they sum. Present only when every
                    changed file had a real diff — see DoneMarkerSummary.lines. */}
                {summary?.kind === "structured" &&
                  summary.marker.lines !== undefined && (
                    <>
                      {" · "}
                      <DiffStat
                        value={summary.marker.lines}
                        rollup
                        {...(summary.at !== undefined
                          ? { at: summary.at }
                          : {})}
                      />
                    </>
                  )}
              </span>
            )
          )}
          {/* Chevron INLINE after the summary text (user 2026-07-07: it
            floated detached at the far edge); only the duration stays
            right-anchored (its margin-left:auto in CSS). */}
          {!active && expandable && (
            <svg
              className="activity-line__chevron"
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              aria-hidden="true"
            >
              <path d={expanded ? "M2 6.5l3-3 3 3" : "M3.5 2l3 3-3 3"} />
            </svg>
          )}
        </button>
        {/* Outside the button: the duration is a fact about the run, not part
          of the toggle's label, and it is what pinned the button to the full
          row width. */}
        {durationLabel !== null && (
          <span className="activity-line__duration">{durationLabel}</span>
        )}
      </div>
      {/* The plan strip is a SIBLING of the collapsible history, never a
          child of it: the history's reveal animates a MEASURED max-height,
          so anything growing inside it while the backend works would either
          be clipped by a stale ceiling or fight the transition. Here it
          simply pushes the (collapsed or open) panel down. */}
      {planRows.length > 0 && (
        <ul className="activity-plan" aria-label={t("activity.todo.list")}>
          {planRows.map((item, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: todo_write is full-list replacement, so item text is neither unique nor stable (板砖 rewords rows mid-run) — position is the only usable identity, and the rows carry no per-row state to mis-associate.
              key={i}
              className={`activity-plan__row is-${item.status.replace("_", "-")}`}
              // The full text, for a row the single-line ellipsis truncates.
              title={item.content}
            >
              {/* ✓ / ▸ / ○ — the CLI plan strip's mark triad (plan-strip.ts
                  MARK), form instead of motion: the 2026-07-27 dot redesign
                  leaves the activity LED as the one pulsing element. */}
              <span className="activity-plan__mark" aria-hidden="true">
                {item.status === "completed" && (
                  <svg
                    className="activity-plan__check"
                    viewBox="0 0 10 10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M1.5 5.2l2.4 2.4L8.5 2.6" />
                  </svg>
                )}
                {item.status === "in_progress" && (
                  <svg
                    className="activity-plan__caret"
                    viewBox="0 0 8 10"
                    aria-hidden="true"
                  >
                    <path d="M1.4 1.6l5.2 3.4-5.2 3.4z" />
                  </svg>
                )}
              </span>
              {/* Backend-authored task text, rendered VERBATIM (D7): this is
                  the same string the record shows Herta. Only the chrome
                  around it localizes. */}
              <span className="activity-plan__text">{item.content}</span>
            </li>
          ))}
          {planHidden > 0 && (
            <li className="activity-plan__row activity-plan__more">
              {t("activity.plan.more", { n: planHidden })}
            </li>
          )}
        </ul>
      )}
      {expandable && (
        <div
          ref={historyRef}
          className={`activity-line__history${expanded ? " is-open" : ""}`}
          onTransitionEnd={(e) => {
            if (e.propertyName !== "max-height") return;
            const el = historyRef.current;
            if (el !== null && expanded) el.style.maxHeight = "none";
          }}
        >
          <div className="activity-line__history-inner">
            {rows.map((row, i) => {
              const b = row.block;
              const failed = b.digest?.kind === "tool-fail";
              // The file NAME as a click target (ADR 0050 §1): op rows
              // whose digest arg is the path — reads, writes, and the
              // folded-patch edit rows all carry one. Attachment rows too
              // (owner 2026-08-31): the NAME in the body opens the STORED
              // copy under .herta/attachments/ — text attachments only
              // (pictures already have the thumbnail + lightbox), and only
              // while the store still holds the file (not removed/failed).
              const fileTarget: {
                readonly path: string;
                readonly name?: string;
                readonly label?: string;
              } | null =
                openFile === null
                  ? null
                  : b.digest?.kind === "op" &&
                      (b.digest.verb === "Reading" ||
                        b.digest.verb === "Writing") &&
                      b.digest.arg.length > 0
                    ? { path: b.digest.arg }
                    : b.digest?.kind === "attachment" &&
                        b.digest.path.length > 0 &&
                        b.digest.image === undefined &&
                        b.digest.unreadable === undefined
                      ? {
                          path: b.digest.path,
                          // The row DISPLAYS the middle-truncated name
                          // (long names wrapped the row, owner 2026-08-10)
                          // — split on what is actually on screen or a long
                          // name silently loses its click affordance. The
                          // panel breadcrumb gets the WHOLE name.
                          name: middleTruncateName(b.digest.name),
                          label: b.digest.name,
                        }
                      : null;
              // A parallel batch (ADR 0025 slice 5) has several ops in
              // flight at once — shimmer the last `inFlightCount` op rows
              // together; the classic single-row shimmer otherwise.
              const shimmer =
                active &&
                (i === rows.length - 1 ||
                  (inFlightCount > 1 &&
                    b.digest?.kind === "op" &&
                    i >= rows.length - inFlightCount));
              return (
                <ActivityStep
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows are append-only and stable-order; bodies can duplicate (repeated "↳ exit 0 · N lines" rows), so body keys would collide and shimmer/reconcile the wrong row.
                  key={i}
                  body={stepDisplayBody(b, t)}
                  t={t}
                  // Icon parses the CANONICAL body — the display body may be
                  // a localized verb stepIcon can't recognize. Failure and
                  // todo rows key off the structured digest instead.
                  icon={
                    failed
                      ? "fail"
                      : b.digest?.kind === "todo"
                        ? "todo"
                        : b.digest?.kind === "attachment"
                          ? "attach"
                          : stepIcon(b.body)
                  }
                  active={shimmer}
                  failed={failed}
                  detail={stepDisplayDetail(b, t)}
                  // The write states its own magnitude, and the diff it wrote
                  // folds in underneath (2026-08-25 evening).
                  {...(row.patch !== undefined
                    ? { patch: foldedPatch(row.patch) }
                    : {})}
                  // The row's own stamp gates the magnitude's count-up: live
                  // appends animate, a reloaded session's history does not.
                  {...(b.at !== undefined ? { at: b.at } : {})}
                  // A patch with no write to fold into (a DENIED edit) still
                  // answers with its magnitude, in place of the body's first
                  // line — the element, because the digits count up.
                  {...(row.patch === undefined && b.digest?.kind === "patch"
                    ? { stat: patchStat(b) }
                    : {})}
                  // Take-back, offered only where it can actually work: a
                  // stored attachment (a path to delete), not already removed,
                  // and no turn in flight — the removal rides the same
                  // out-of-turn record write as the attach.
                  {...(onRemoveAttachment !== undefined &&
                  b.digest?.kind === "attachment" &&
                  b.digest.path.length > 0 &&
                  b.digest.unreadable !== "removed"
                    ? {
                        onRemove: onRemoveAttachment(b.digest.path),
                        removeLabel: t("activity.attachment.remove"),
                      }
                    : {})}
                  {...(fileTarget !== null && openFile !== null
                    ? {
                        file: {
                          path: fileTarget.path,
                          ...(fileTarget.name !== undefined
                            ? { name: fileTarget.name }
                            : {}),
                          onOpen: () =>
                            openFile(fileTarget.path, fileTarget.label),
                          ariaLabel: `${t("activity.file.openAria")} ${fileTarget.name ?? fileTarget.path}`,
                        },
                      }
                    : {})}
                />
              );
            })}
            {markerDetail !== undefined && (
              <ActivityStep
                body={t("activity.result.detail")}
                t={t}
                icon="result"
                active={false}
                detail={markerDetail}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
});
