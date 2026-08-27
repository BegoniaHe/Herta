import type { TerminalRecordBlock } from "@herta/app-server";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useActiveSession } from "../../hooks/useActiveSession.js";
import { usePresence } from "../../hooks/usePresence.js";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import { useT } from "../../i18n/LocaleProvider.js";
import { dealiasBrickDraft } from "../../lib/banzhuan-mention.js";
import { ErrorBoundary } from "../ErrorBoundary.js";
import { ActivityBlock } from "./ActivityBlock.js";
import { ConversationPinProvider } from "./ConversationPin.js";
import {
  ENTRANCE_DURATION_MS,
  ENTRANCE_STAGGER_MS,
  planStaggerEntrance,
} from "./conversation-entrance.js";
import { GalaxyTravelRow } from "./GalaxyTravelRow.js";
import {
  activityHasTerminalMarker,
  groupRecord,
  liftUserImages,
  type SystemBlock,
} from "./group-record.js";
import { HertaBubble } from "./HertaBubble.js";
import { MorphClone } from "./MorphClone.js";
import { PendingActivity } from "./PendingActivity.js";
import { planContext } from "./plan-context.js";
import { RecapCompactRow } from "./RecapCompactRow.js";
import { StreamingReply } from "./StreamingReply.js";
import { SupervisorHoldRow } from "./SupervisorHoldRow.js";
import { TopicRail } from "./TopicRail.js";
import { TurnFailedRow } from "./TurnFailedRow.js";
import {
  needsRoom,
  preGlideScrollTop,
  targetExtentFor,
} from "./turn-headroom.js";
import {
  imageViewsFromBlocks,
  UserBubble,
  type UserImageView,
} from "./UserBubble.js";
import { useConversationScroll } from "./useConversationScroll.js";
import {
  E_OUT_CUBIC,
  easeOutCubic,
  easeOutQuart,
  useRiseAnimation,
} from "./useRiseAnimation.js";
import { useWorkspaceRefs } from "./WorkspaceRefs.js";

// The composer "glass" frost should only read while the bubble is lifting off
// the input — not for the bubble's whole rise. Drop it shortly after the lift
// so the composer isn't dimmed for the full travel.
const GLASS_MS = 150;

// Small grace before the galaxy row APPEARS, so a long-session recap can lead.
// The primary fix is in the backend: compaction now runs BEFORE intent-routing,
// so `recap.compaction start` fires at turn-start and (with motion) lands well
// before the ~860ms send-morph settles → the recap row leads, no flash. This
// grace is the remaining safety net for the reduced-motion path, where there is
// no send-morph to cover the few-tens-of-ms event latency. Hiding is immediate.
//
// Raised 200→400 (user 2026-07-31): a fast first token lands 300–500ms after
// the settle, and a 200ms trigger put the row up just in time to be loud-cut
// mid-entrance — the "quick flash before 处理中" report. Waits that deserve
// the row are seconds long; starting it 200ms later costs nothing.
export const GALAXY_APPEAR_DELAY_MS = 400;

// Once the in-flight indicator IS up, it stays up this long. A @板砖 turn
// whose dispatch lands quickly used to flash it for under half a second before
// the coprocessor's own row replaced it (user 2026-07-30) — too short to read,
// so it registered as a glitch rather than as a message. 800ms covers the
// row's own 450ms entrance plus enough stillness to actually read it.
//
// The hold is deliberately NOT a blanket one: see `inFlightVisible` for why a
// stream or a morph still hides it in the same render.
export const IN_FLIGHT_MIN_VISIBLE_MS = 800;

// How long the row stays mounted fading OUT after a QUIET hide (user
// 2026-07-31: the galaxy→处理中 swap was a hard same-commit switch). Matches
// the .status-row.is-exiting CSS transition. Loud hides (a stream, a morph)
// still unmount in the same render — that boundary is load-bearing for the
// incoming-rise morph measurement (bug 2026-07-10) and stays instant.
export const IN_FLIGHT_EXIT_MS = 220;

// How long the VISIBLE reveal must sit still (no revealed-text growth) during
// a pending supervisor judgment before the 伽马风暴 row appears. Keyed to the
// reveal, not the judgment (user 2026-07-10): the supervisor starts the moment
// generation completes, but the paced reveal often has a BACKLOG still typing
// — visible progress needs no explanation. Only a genuinely stuck cursor earns
// the hint. Hiding is immediate on the verdict.
export const SUPERVISOR_HINT_DELAY_MS = 2000;
// Poll cadence for the stall check above (a ref timestamp, not state, tracks
// growth — polling avoids per-frame re-renders).
const SUPERVISOR_HOLD_POLL_MS = 250;

// How long the send glide owns the scroller (turn headroom, 2026-07-29).
// Chromium's smooth scroll runs a few hundred ms for a pane-sized move; this
// is the outer bound after which control returns to geometry and the landing
// is re-asserted.
export const GLIDE_WINDOW_MS = 700;
/** Travel time of the outgoing send rise. The page's climb into the reserved
 *  room waits for this flight to land (2026-07-30), so the send's fallback
 *  release has to outlast it — hence a named constant rather than a literal at
 *  the `rise.start` call. */
export const OUTGOING_FLIGHT_MS = 860;

// Unpinned live-window trim (2026-08-25). Deliberately laxer than the pinned
// 260→200: the reader is IN this history, so trims should be rare and only
// ever claim rows provably off-screen above. Begin considering a cut past
// this many mounted blocks…
export const UNPINNED_TRIM_AT = 500;
/** …never cut into the newest blocks (mirror of the pinned tail bound —
 *  scrolling back down must land on real history, not a paging button)… */
export const UNPINNED_TRIM_KEEP_TAIL = 200;
/** …and don't bother for cuts smaller than this (each trim costs a geometry
 *  read and a full-window commit; tiny ones would churn per append). */
export const UNPINNED_TRIM_MIN = 50;

/** Per-row crash fallback (audit 2026-07-13 T2.2): the row renderers are
 *  fed model-shaped record blocks every turn, so a malformed one must cost
 *  one muted line — not unmount the whole conversation. */
function RowRenderError(): JSX.Element {
  const t = useT();
  return (
    <div className="row-render-error" role="note">
      {t("conversation.rowError")}
    </div>
  );
}

function renderBlock(
  block: TerminalRecordBlock,
  index: number,
  // Conversation language, for the 板砖→Brick display alias on the bubbles.
  lang: "zh" | "en",
  // Set only on the LATEST user block when idle — wires its rewind control.
  onRewind?: () => void,
  // Pictures sent WITH this message (ADR 0048 §4), lifted onto the bubble.
  images?: readonly SystemBlock[],
): JSX.Element | null {
  // Blocks → bubble views here rather than in UserBubble, so the optimistic
  // echo (whose pictures come from the composer strip, not the record) can
  // feed the same prop.
  const imageViews = images !== undefined ? imageViewsFromBlocks(images) : [];
  // Per-block timestamp (Slice 4): `at` is stamped at the output boundaries
  // (live sink emit + JSONL persist), so each bubble shows its own time.
  // Pre-timestamp blocks lack `at` → the bubble hides its timestamp line
  // rather than fabricating a shared "now" (the old all-same bug). The
  // adaptive label (just now / N min ago / time / date+time) is derived in
  // the bubble's BubbleTime leaf off the shared coarse clock (perf
  // 2026-08-25), so the current time never enters this render — a clock
  // tick invalidates label leafs, not row elements.
  switch (block.kind) {
    case "user":
      return (
        <UserBubble
          key={index}
          absIndex={index}
          text={block.text}
          at={block.at}
          lang={lang}
          {...(onRewind !== undefined ? { onRewind } : {})}
          {...(imageViews.length > 0 ? { images: imageViews } : {})}
        />
      );
    case "herta":
      if (block.surface === "thought") return null; // per SPEC D8
      return (
        <HertaBubble key={index} text={block.text} at={block.at} lang={lang} />
      );
    default:
      return null;
  }
}

// memo (user profile 2026-07-12): Conversation takes no props, so every
// PARENT re-render — notably the sidebar toggle flipping Workbench state,
// which profiled as an 89ms long task on the click — re-rendered the whole
// row tree for nothing. Store updates still flow via useActiveSession.
export const Conversation = memo(function Conversation(): JSX.Element {
  const t = useT();
  const {
    record,
    recordStart,
    status,
    streamingText,
    retryText,
    pendingUser,
    pendingUserImages,
    retracting,
    retractKeepLen,
    turnStartedAt,
    backendStartedAt,
    backendActive,
    backendInFlight,
    recapCompacting,
    supervisorChecking,
    sessionId,
    pendingJump,
    turnFailed,
    turnFailedStatus,
    turnFailedProviderCode,
    topics,
    lang,
  } = useActiveSession();
  const { bridge, sessionStore } = useHertaBridge();
  const reduced = useReducedMotion();
  // No clock here: adaptive timestamps ("just now" → "N min ago") refresh via
  // the shared coarse tick each BubbleTime leaf subscribes to (lib/now-tick,
  // perf 2026-08-25). Keeping `now` in this component put the tick in the row
  // memo's deps, so every 30s rebuilt and reconciled every mounted row element
  // to refresh at most a few labels.
  // The per-FRAME reveal (useRevealedText / useRetractMorph) lives in the
  // StreamingReply leaf, not here: its state commits once per rAF frame while
  // tokens stream, and hosting it in Conversation re-rendered the ENTIRE
  // conversation (every historical bubble) 60×/s. Conversation re-renders per
  // DELTA (streamingText identity), which the memoized rows absorb.

  // The optimistic echo's pictures as bubble views (ADR 0048 §4). No caption
  // yet — it is being computed main-side; the record row carries it. The
  // sniffed dimensions ride along so the echo reserves the real box before
  // the thumbnails load (the morph measures this slot).
  const pendingEchoImages = useMemo<readonly UserImageView[]>(
    () =>
      (pendingUserImages ?? []).map((s) => ({
        path: s.path,
        name: s.name,
        ...(s.width !== undefined ? { width: s.width } : {}),
        ...(s.height !== undefined ? { height: s.height } : {}),
      })),
    [pendingUserImages],
  );

  // Outgoing send morph: on the pendingUser null→value edge, mount a flying
  // clone in the workspace overlay and rise it from the composer to its
  // resting slot (crisp left/top). The flow bubble stays hidden until settle.
  const { composerRef, overlayRef } = useWorkspaceRefs();
  const outgoingRise = useRiseAnimation();
  const incomingRise = useRiseAnimation();
  /** The `.conversation-flow` column — the morphs watch its WIDTH so a
   *  container reflow mid-flight (sidebar toggle, rail gutter) settles them
   *  early instead of landing at the pre-reflow slot. */
  const flowRef = useRef<HTMLDivElement>(null);
  const cloneRef = useRef<HTMLDivElement>(null);
  const pendingUserBubbleRef = useRef<HTMLDivElement>(null);
  const [outgoingClone, setOutgoingClone] = useState<{
    text: string;
    images: readonly UserImageView[];
    /** The hidden pending row's strip width, so the clone's strip wraps
     *  EXACTLY like the one it will swap for — a max-content clone laid
     *  three pictures in one oversized line while the landed row wrapped
     *  them into two (seen live 2026-08-27). */
    imagesWidthPx?: number;
  } | null>(null);
  const [hidePendingUser, setHidePendingUser] = useState(false);
  const prevPendingUser = useRef<string | null>(null);
  /** Whether THIS send will actually fly a clone (set by the detection layout
   *  effect below, read by the send effect in the same commit). The sequenced
   *  travel is handed to the flight's settle, so a send with no flight has to
   *  keep travelling immediately or the reserved room never comes on screen. */
  const outgoingFlightArmedRef = useRef(false);

  // Detection: on the pendingUser null→value edge, mount the flying clone +
  // hide the flow bubble. Geometry/animation happens in the effect below,
  // AFTER the clone has committed (so cloneRef is attached).
  // LAYOUT effect, deliberately: a passive useEffect runs after the browser
  // paints, so the flow bubble got one painted frame at its final position
  // before the hide flag landed — a visible flash, then the rise replayed
  // from the composer (seen live 2026-06-13). Setting the flag before paint
  // means the bubble is never painted until the morph settles.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on the pendingUser null→value edge
  useLayoutEffect(() => {
    const appeared = prevPendingUser.current === null && pendingUser !== null;
    prevPendingUser.current = pendingUser;
    if (pendingUser === null) {
      outgoingRise.cancel();
      setOutgoingClone(null);
      setHidePendingUser(false);
      composerRef.current?.classList.remove("is-glass");
      return;
    }
    if (!appeared) return;
    if (
      overlayRef.current === null ||
      composerRef.current === null ||
      reduced ||
      // Reading history: the send no longer yanks the pane (see the send
      // effect), so this clone's destination — the flow bubble's slot — is
      // below the fold. Flying to it would launch the bubble off the bottom
      // edge of a view the reader never asked to leave. Let the bubble land
      // in the flow unseen, exactly like the reduced-motion path.
      //
      // A DISCLOSURE unpin does not count as reading history, and must be
      // tested the same way here as in the send effect below — the two
      // decisions have to agree or the send hands its travel to a flight that
      // was never armed. Expanding a detail pane and then sending lost the
      // animation entirely until this matched (owner 2026-08-10).
      (!scroll.pinnedRef.current && !scroll.syntheticUnpinRef.current)
    ) {
      // No overlay/composer or reduced motion → the flow bubble shows directly,
      // and nothing will fly. Recorded because the send effect below decides
      // whether to hand its travel to a flight that may not exist, and this
      // layout effect runs FIRST in the same commit, so the answer is current.
      outgoingFlightArmedRef.current = false;
      return;
    }
    outgoingFlightArmedRef.current = true;
    setHidePendingUser(true);
    // The clone carries the message's pictures too (set in the same store
    // emit as pendingUser, so this commit sees them): the strip's images
    // lift off with the bubble instead of popping in at the landing. The
    // hidden pending row is already in the DOM (this is a layout effect),
    // so its strip's width can be measured for the clone to reproduce.
    const rowStrip =
      pendingUserBubbleRef.current?.parentElement?.querySelector(
        ".message-images",
      );
    const imagesWidth = rowStrip?.getBoundingClientRect().width;
    setOutgoingClone({
      text: pendingUser,
      images: pendingEchoImages,
      ...(imagesWidth !== undefined && imagesWidth > 0
        ? { imagesWidthPx: imagesWidth }
        : {}),
    });
  }, [pendingUser, reduced]);

  // Animate once the clone has mounted (cloneRef attaches only after the portal
  // commits — measuring in the detection effect via rAF raced the commit and
  // left the clone unpositioned at the overlay's top-left). FLIP-style: measure
  // the real flow bubble's slot (held in layout via visibility:hidden) and rise
  // the clone to exactly that rect so it lands where the bubble actually goes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the clone mounting
  useEffect(() => {
    if (outgoingClone === null) return;
    const el = cloneRef.current;
    const composer = composerRef.current;
    const overlay = overlayRef.current;
    const slot = pendingUserBubbleRef.current;
    if (el === null || composer === null || overlay === null || slot === null)
      return;
    const ws = overlay.getBoundingClientRect();
    const comp = composer.getBoundingClientRect();
    const dest = slot.getBoundingClientRect();
    // Diagonal lift: start at the composer's left (the input), settle at the
    // flow bubble's actual slot (right-aligned, wherever it lands in the flow).
    const startLeft = comp.left + 20 - ws.left;
    const startTop = comp.top - ws.top + 6;
    const targetLeft = dest.left - ws.left;
    // `dest` is where the slot IS, and that is where the clone lands (2026-07-30).
    // It used to subtract the scroll still owed by an in-flight send glide,
    // because the page climbed into the reserved room WHILE the bubble crossed
    // it — the clone had to aim at where the slot would end up. The two are
    // sequenced now: the send parks at the bottom of the real content and the
    // climb waits for this flight's settle, so nothing is owed and the slot
    // cannot move underneath it.
    const targetTop = dest.top - ws.top;
    el.style.left = `${Math.round(startLeft)}px`;
    el.style.top = `${Math.round(startTop)}px`;
    el.classList.add("is-visible");
    composer.classList.add("is-glass");
    const glassTimer = window.setTimeout(() => {
      composer.classList.remove("is-glass");
    }, GLASS_MS);
    outgoingRise.start({
      el,
      from: { left: startLeft, top: startTop },
      to: { left: targetLeft, top: targetTop },
      durationMs: OUTGOING_FLIGHT_MS,
      easing: easeOutCubic,
      // Runs the flight on the COMPOSITOR (see useRiseAnimation): this rise
      // overlaps the heaviest main-thread moment in the app — the committed
      // turn's style/layout/paint plus, on a full page, the headroom glide —
      // and on a slow machine it used to freeze with it.
      cssEasing: E_OUT_CUBIC,
      // A sidebar toggle or the rail gutter easing in mid-flight moves the
      // slot with no window resize — settle early on a flow WIDTH change
      // (deferred-fix 2026-07-31).
      ...(flowRef.current !== null ? { watchWidthOf: flowRef.current } : {}),
      onSettle: () => {
        composer.classList.remove("is-glass");
        setHidePendingUser(false);
        setOutgoingClone(null);
      },
    });
    return () => window.clearTimeout(glassTimer);
  }, [outgoingClone]);

  // Incoming rise-while-streaming morph: on the streamingText null→value edge,
  // mount a clone that mirrors the live tokens and rise it from behind the
  // composer to its resting slot (mirrors the outgoing morph). The flow
  // streaming bubble stays hidden until settle, where it keeps streaming.
  const incomingCloneRef = useRef<HTMLDivElement>(null);
  const streamingBubbleRef = useRef<HTMLDivElement>(null);
  const [incomingClone, setIncomingClone] = useState(false);
  const [hideStreaming, setHideStreaming] = useState(false);
  const prevStreaming = useRef<string | null>(null);
  // (The detection layout effect — the null→value edge that mounts the clone —
  // lives below the in-flight block: it keys on `visibleStreamingText`, the
  // stream as the flow shows it, which is defined there.)

  // Animate once the incoming clone has mounted (same rationale as outgoing).
  // FLIP-style: measure the real streaming bubble's slot (held in layout via
  // visibility:hidden) for BOTH left and top, so the clone aligns with the
  // indented Herta column and rises to the bubble's actual resting slot.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the clone mounting
  useEffect(() => {
    if (!incomingClone) return;
    const el = incomingCloneRef.current;
    const composer = composerRef.current;
    const overlay = overlayRef.current;
    const slot = streamingBubbleRef.current;
    if (el === null || composer === null || overlay === null || slot === null)
      return;
    const ws = overlay.getBoundingClientRect();
    const comp = composer.getBoundingClientRect();
    const dest = slot.getBoundingClientRect();
    const h = el.offsetHeight;
    const left = dest.left - ws.left; // align to the Herta column
    const startTop = comp.bottom - ws.top - h * 0.32; // behind the composer
    // The send's climb into the reserved room may still be running (2026-07-30):
    // it now starts at the outgoing flight's settle rather than at send, which
    // puts it squarely in the window where a first delta arrives. Every pixel
    // of scroll still owed lifts this slot by one, so aim at where it will be —
    // the compensation the outgoing flight no longer needs, moved to the flight
    // that now needs it. Zero whenever no scroll is pending, which keeps every
    // other path byte-identical.
    const pane = scroll.scrollRef.current;
    const owedScroll =
      pane === null || !scroll.glidingRef.current
        ? 0
        : Math.max(0, pane.scrollHeight - pane.clientHeight - pane.scrollTop);
    const targetTop = dest.top - ws.top - owedScroll; // the real flow slot
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(startTop)}px`;
    el.classList.add("is-visible");
    composer.classList.add("is-glass");
    const glassTimer = window.setTimeout(() => {
      composer.classList.remove("is-glass");
    }, GLASS_MS);
    incomingRise.start({
      el,
      from: { left, top: startTop },
      to: { left, top: targetTop },
      durationMs: 760,
      easing: easeOutQuart,
      anchor: "bottom",
      // The aim above compensates for the climb still owed — but the two
      // clocks are independent, and a flight that ends mid-climb would swap
      // onto a slot still travelling toward the aimed position (deferred-fix
      // 2026-07-31: a fast first token made the bubble visibly drop at
      // hand-off, then get dragged back up). Hold at the aimed slot until
      // the climb's own lifecycle ends: converge (seamless swap), the
      // runaway cap, or a user takeover — all flip glidingRef, and every
      // cancel path (session switch, rePin, unmount) clears it too.
      holdSettle: () => scroll.glidingRef.current,
      // Same early settle on a flow width change as the outgoing flight.
      ...(flowRef.current !== null ? { watchWidthOf: flowRef.current } : {}),
      onSettle: () => {
        composer.classList.remove("is-glass");
        setHideStreaming(false);
        setIncomingClone(false);
      },
    });
    return () => window.clearTimeout(glassTimer);
  }, [incomingClone]);

  const scroll = useConversationScroll({ outgoingClone, incomingClone });

  // Rewind the latest 开拓者 turn: play a brief withdraw animation over the tail
  // rows (latest user row + everything below it), then ask the server to truncate
  // every record store. On success the reset event shrinks the record (the rows
  // unmount) and the withdrawn user text is staged back into the composer. The
  // animation is skipped under reduced motion (the truncation still happens).
  // Re-entry guard: the handler is async (220ms animation + IPC round-trip), so a
  // double-click could fire it twice and truncate two turns. One rewind at a time.
  const rewindingRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: bridge/sessionStore/scrollRef are stable; `reduced`, `t`, and `lang` are the varying inputs
  const handleRewind = useCallback(async () => {
    if (rewindingRef.current) return;
    // Idle-only, checked HERE rather than by withholding the handler
    // (2026-07-30). The gate used to be a `canRewind` prop computed from
    // `status`, which put the turn's status in the row memo's dependencies and
    // re-rendered every row in the session on every send — for a control that
    // belongs to one row. Visibility is now CSS (`.conversation-flow.is-busy`)
    // and this is the actual guard: a live turn must not be truncated
    // underneath itself.
    if (sessionStore.getSnapshot().status !== "idle") return;
    rewindingRef.current = true;
    // Bind the destructive call to the session the user clicked in. The 220ms
    // animation below can race a sidebar session switch; both the renderer
    // check after the await AND main's sessionId match prevent the rewind
    // from truncating the newly-active session's turn.
    const clickedSessionId = sessionStore.getSnapshot().sessionId;
    let withdrawing: HTMLElement[] = [];
    try {
      if (clickedSessionId === null) return;
      const container = scroll.scrollRef.current;
      if (container !== null && !reduced) {
        const rows = Array.from(
          container.querySelectorAll<HTMLElement>(
            ".message-row, .activity-line-group",
          ),
        );
        let lastUserRow = -1;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i]?.classList.contains("user-row")) {
            lastUserRow = i;
            break;
          }
        }
        if (lastUserRow !== -1) {
          withdrawing = rows.slice(lastUserRow);
          for (const el of withdrawing) el.classList.add("is-withdrawing");
          await new Promise<void>((resolve) => setTimeout(resolve, 220));
        }
      }
      if (sessionStore.getSnapshot().sessionId !== clickedSessionId) {
        // Session switched during the animation — the rows we faded belong to
        // a record that is no longer on screen; nothing to truncate here.
        return;
      }
      const result = await bridge.rewindLastTurn(clickedSessionId);
      // Re-check AFTER the await too (audit 2026-07-10): main's sessionId
      // bind makes the truncation safe, but a session switch racing the
      // invoke reply could land the withdrawn text in the NEW session's
      // composer — the store now mirrors a different session. The rewind
      // itself succeeded; only the draft staging is session-bound.
      if (sessionStore.getSnapshot().sessionId !== clickedSessionId) {
        return;
      }
      if (result.ok) {
        // The record stores the wire token @板砖; an EN user typed/saw @Brick —
        // restore the draft in the form they sent (round-trip via the
        // composer's input alias, ADR 0015 §3).
        sessionStore.requestComposerDraft(
          dealiasBrickDraft(result.userText, lang),
          result.editedFiles ? t("workspace.editsNotReverted") : null,
        );
      } else {
        // Truncation didn't happen (e.g. a turn started in the gap) — un-fade the
        // rows so they don't hang in the withdrawn state. On success the rows
        // unmount with the reset, carrying the class away.
        for (const el of withdrawing) el.classList.remove("is-withdrawing");
      }
    } catch {
      // A REJECTED invoke (audit 2026-07-24, M3). The driver truncates the
      // JSONL durable-first and unguarded, so a filesystem failure (locked
      // file, full disk, read-only dir — plausible on Windows with AV or a
      // sync client) rejects here. Without this arm the tail rows kept
      // `.is-withdrawing`, whose animation ends at opacity 0 with
      // pointer-events:none — the turn stayed on screen as an invisible,
      // un-clickable gap, and only a session switch revealed it was never
      // withdrawn. React never rewrites these imperative classes (the rows
      // are memo'd), so nothing else could clean them up.
      for (const el of withdrawing) el.classList.remove("is-withdrawing");
      if (sessionStore.getSnapshot().sessionId === clickedSessionId) {
        // A silent failed rewind is indistinguishable from a no-op.
        sessionStore.requestComposerDraft(null, t("workspace.rewindFailed"));
      }
    } finally {
      rewindingRef.current = false;
    }
  }, [reduced, t, lang]);

  // Both in-flight indicators — the recap-compaction row and the galaxy-travel
  // row — share ONE lifecycle. What the user sees, in order, after a send:
  //
  //   the bubble flies (send morph) → the row ("消息正在穿越银河", or the
  //   recap row while compacting) → it stays up at least
  //   IN_FLIGHT_MIN_VISIBLE_MS → it fades out → whatever comes next mounts
  //   in its place: Herta's reply bubble, the 处理中… placeholder, or the
  //   turn-failed notice.
  //
  // Owner decision 2026-08-17 ("we are mimicking sending a message to the
  // space station"): the row shows on EVERY send, for at least the minimum,
  // regardless of how fast the other side answers. Before this, the row
  // appeared only if the wait outlasted a 400 ms grace, so a fast direct
  // @板砖 turn showed it on some sends and not others; and a reply or a
  // failure took it down in the same render, so a fast one could still cut
  // it to a sub-second flash. Now every hide reason except a NEW send is
  // "quiet": the row keeps its minimum, fades, and the successor UI defers
  // on `inFlightPresent` (处理中… already did; the streaming bubble and the
  // failure row now do too — that is what keeps the 2026-07-10 morph-slot
  // invariant: the incoming-rise morph measures its landing slot only after
  // the row is gone, because the bubble is not mounted until then).
  //
  // What still does NOT show it: a send that never became a turn (no
  // DeepSeek key → the key prompt takes the message; a rejected submit that
  // hands the text back to the composer) — nothing was sent, so nothing
  // travels. A turn that fails while the bubble is still flying (a 401/402
  // comes back in a few hundred ms) DOES show it: the message went out, then
  // the reply was lost — the notice follows the fade.
  //
  // Turns that are not sends (the opening seed, an orphan reply) keep the
  // older debounce: shown after GALAXY_APPEAR_DELAY_MS only if the wait is
  // still on — there is no "send" to honour and no morph to wait behind.
  //
  // "Wait is on" gates on "turn in flight" (status !== "idle"), NOT
  // status === "thinking" (bug 3, 2026-07-09): after a @板砖 run's
  // done-marker the turn stays in flight while Herta's synthesis completion
  // generates — often the longest silent wait of a delegation turn — but
  // `status` is a STALE "speaking" from the pre-dispatch speech.
  const inFlightSettled =
    status !== "idle" &&
    streamingText === null &&
    outgoingClone === null &&
    !backendActive &&
    !supervisorChecking;
  const [showInFlight, setShowInFlight] = useState(false);
  /** When the row actually became visible — the clock the minimum-visible hold
   *  is measured from. Null whenever it is down. */
  const inFlightShownAtRef = useRef<number | null>(null);
  /** True while the row is fading OUT after a quiet hide (user 2026-07-31:
   *  the swap to 处理中 was a hard same-commit switch). The row stays mounted
   *  without `is-shown` for IN_FLIGHT_EXIT_MS, then unmounts; the successor
   *  UI defers until the fade is done so the two hand off in place instead
   *  of stacking. */
  const [inFlightExiting, setInFlightExiting] = useState(false);
  /** A send is ARMED from the moment the user's message leaves the composer
   *  (the pendingUser echo appears) until the row it guarantees is up, or
   *  until it turns out no turn ever started. See the block comment. */
  const [sendArmed, setSendArmed] = useState(false);
  const prevPendingUserForArm = useRef<string | null>(null);
  useEffect(() => {
    const appeared =
      prevPendingUserForArm.current === null && pendingUser !== null;
    prevPendingUserForArm.current = pendingUser;
    if (appeared) setSendArmed(true);
  }, [pendingUser]);
  // A send that never became a turn: the echo is gone, nothing is in flight,
  // nothing failed — the key prompt took the message, or the submit was
  // rejected and the text went back to the composer. Disarm; no row.
  // (Ordering note: a REAL turn's status goes non-idle within milliseconds of
  // the send — the lifecycle event precedes the user block by the whole
  // router phase — so an idle status with the echo gone is not a race.)
  useEffect(() => {
    if (sendArmed && pendingUser === null && status === "idle" && !turnFailed) {
      setSendArmed(false);
    }
  }, [sendArmed, pendingUser, status, turnFailed]);
  /** The armed row may appear: the send morph has settled (or there was
   *  none) and the turn is real — in flight, or already failed. */
  const armedShow =
    sendArmed && outgoingClone === null && (status !== "idle" || turnFailed);
  useEffect(() => {
    const showNow = (): void => {
      inFlightShownAtRef.current = Date.now();
      setInFlightExiting(false); // a re-show mid-fade resumes the row
      setShowInFlight(true);
      // The send's promise is kept the moment the row is up — disarm HERE,
      // not when the timer is armed: a re-run of this effect (the wait-is-on
      // predicate flipping while the reduced-motion grace runs) cancels the
      // timer, and a still-armed send simply re-arms it.
      setSendArmed(false);
    };
    const shownAt = inFlightShownAtRef.current;
    if (shownAt === null) {
      // ── Row is down. Should it come up? ──
      if (armedShow) {
        // A send: show now (the morph already gave the recap event its lead;
        // under reduced motion there is no morph, so give it the same small
        // grace the non-send path uses — the minimum still applies after).
        if (!reduced) {
          showNow();
          return;
        }
        const id = window.setTimeout(showNow, GALAXY_APPEAR_DELAY_MS);
        return () => window.clearTimeout(id);
      }
      if (inFlightSettled) {
        // Not a send (opening / orphan reply): only if the wait outlasts the
        // grace — nothing promised a row here.
        const id = window.setTimeout(showNow, GALAXY_APPEAR_DELAY_MS);
        return () => window.clearTimeout(id);
      }
      setShowInFlight(false);
      return;
    }
    // ── Row is up. ──
    if (inFlightSettled) {
      // Its hide condition reversed inside the hold (a supervisor check
      // ending, a backend blip): keep it, keep its clock — the effect cleanup
      // already disarmed the pending exit.
      setInFlightExiting(false);
      setShowInFlight(true);
      return;
    }
    // The wait is over. If the row has not had its minimum yet, hold it for
    // the remainder instead of yanking it; either way it leaves through the
    // fade (reduced motion skips the fade — there is no transition to play).
    const beginExit = (): void => {
      // A hold timer can outlive the row: this effect doesn't re-run on a
      // session switch (settled is false on both sides of the reset) or on a
      // loud hide, and both clear the shown clock. Pre-exit-fade the stale
      // fire only re-wrote false state; entering the fade here would render
      // a 220ms ghost row in whatever context came next.
      if (inFlightShownAtRef.current === null) return;
      inFlightShownAtRef.current = null;
      setShowInFlight(false);
      if (!reduced) setInFlightExiting(true);
    };
    const remaining = IN_FLIGHT_MIN_VISIBLE_MS - (Date.now() - shownAt);
    if (remaining <= 0) {
      beginExit();
      return;
    }
    const id = window.setTimeout(beginExit, remaining);
    return () => window.clearTimeout(id);
  }, [inFlightSettled, armedShow, reduced]);
  // End of the exit fade → unmount. Keyed on the phase flag alone; a loud
  // event mid-fade clears the flag through the watcher below and this timer's
  // cleanup disarms it.
  useEffect(() => {
    if (!inFlightExiting) return;
    const id = window.setTimeout(
      () => setInFlightExiting(false),
      IN_FLIGHT_EXIT_MS,
    );
    return () => window.clearTimeout(id);
  }, [inFlightExiting]);
  // The one LOUD hide: a NEW send morph (the composer unlocks at idle, so a
  // fast next send can catch the previous row still holding or fading). The
  // new bubble's flight owns the screen; the row goes down in the same
  // render (`inFlightVisible` below) and this clears its state so the hold
  // cannot resurface it. The new send's own arm brings the row back at its
  // settle. (Streams and failures used to be loud too — see the block
  // comment for why they now wait out the minimum instead.)
  useEffect(() => {
    if (outgoingClone === null) return;
    if (!showInFlight && !inFlightExiting) return;
    inFlightShownAtRef.current = null;
    setShowInFlight(false);
    setInFlightExiting(false);
  }, [outgoingClone, showInFlight, inFlightExiting]);
  // The hold has no session identity (Class A, 2026-07-24 audit):
  // Conversation stays mounted across a switch, `inFlightSettled` is false on
  // both sides of the reset, and the loud watcher above sees only quiet in
  // the new session — so a hold armed by a fast turn-end rode into the next
  // session's entrance cascade for up to its remainder (review 2026-07-31).
  // The stale timer stays armed but only re-writes the same false state. The
  // send arm goes with it: the send belonged to the session you left.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the clear trigger, not an input
  useEffect(() => {
    inFlightShownAtRef.current = null;
    setShowInFlight(false);
    setInFlightExiting(false);
    setSendArmed(false);
    prevPendingUserForArm.current = null;
  }, [sessionId]);
  /** Is an in-flight row on screen right now? `showInFlight` is the whole
   *  story except for the one loud hide, which must be render-synchronous:
   *  a new send morph takes the row down in the same render (the state
   *  clears one commit later through the watcher above). */
  const inFlightVisible = showInFlight && outgoingClone === null;
  /** The exit fade, with the same render-synchronous loud-hide guard. */
  const inFlightExitingVisible = inFlightExiting && outgoingClone === null;
  /** Row mounted at all — visible or fading out. The successor UI (处理中…,
   *  the streaming bubble, the failure notice) defers on THIS, not on
   *  `inFlightVisible`, so nothing ever mounts under a still-fading row.
   *  For the streaming bubble that is also the 2026-07-10 morph-slot
   *  invariant: the incoming-rise morph measures its landing slot at mount,
   *  which now happens only after the row is gone. */
  const inFlightPresent = inFlightVisible || inFlightExitingVisible;
  /** The stream as the FLOW shows it: held back (null) while an in-flight
   *  row is still on screen, so Herta's reply enters after the row's fade
   *  instead of cutting it. The store's `streamingText` (status, device
   *  state, the wait-is-over signal above) is untouched — only the bubble
   *  and its rise morph wait. The reveal is paced anyway; it starts with a
   *  small backlog and types it out. */
  const visibleStreamingText = inFlightPresent ? null : streamingText;

  // Detection: on the VISIBLE stream's null→value edge, mount the incoming
  // clone + hide the flow streaming bubble. The fixed width pins wrap so the
  // bubble doesn't reflow while it fills during the rise.
  // LAYOUT effect for the same reason as the outgoing detection above: the
  // hide flag must land before the browser paints the freshly-mounted flow
  // bubble, or it flashes at its resting slot for one frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on the visibleStreamingText null→value edge
  useLayoutEffect(() => {
    const appeared =
      prevStreaming.current === null && visibleStreamingText !== null;
    prevStreaming.current = visibleStreamingText;
    if (visibleStreamingText === null) {
      incomingRise.cancel();
      setIncomingClone(false);
      setHideStreaming(false);
      composerRef.current?.classList.remove("is-glass");
      return;
    }
    // `retracting` is defensive: retry deltas buffer in retryText, so
    // streamingText can't do a null→value edge mid-retract.
    if (!appeared || retracting) return;
    const composer = composerRef.current;
    const overlay = overlayRef.current;
    if (composer === null || overlay === null || reduced) return;
    // The clone's size is driven by the shared measurer effect (it mirrors the
    // in-place bubble); here we only flag it active and hide the flow bubble
    // until the rise settles.
    setHideStreaming(true);
    setIncomingClone(true);
  }, [visibleStreamingText, reduced, retracting]);

  // Supervisor judgment hint (bug 4, 2026-07-09; stall-gated 2026-07-10):
  // while the verdict is pending the paced reveal HOLDS its tail, so a slow
  // judgment reads as a frozen cursor. The row shows only when the judgment
  // is pending AND the visible reveal has actually STALLED — the supervisor
  // runs while the reveal is often still draining its backlog, and a moving
  // cursor needs no explanation. `lastGrowRef` is stamped by every reveal
  // growth frame (see onGrow below); a cheap poll compares it against the
  // stall window. Hiding is immediate on phase:end (verdict landed → the
  // reveal resumes or retracts).
  const lastGrowRef = useRef(0);
  const [showSupervisorHold, setShowSupervisorHold] = useState(false);
  useEffect(() => {
    if (!supervisorChecking) {
      setShowSupervisorHold(false);
      return;
    }
    // Start the stall clock at judgment start, not at the last pre-judgment
    // growth — the check often begins while the reveal is mid-drain.
    lastGrowRef.current = Date.now();
    const id = window.setInterval(() => {
      setShowSupervisorHold(
        Date.now() - lastGrowRef.current >= SUPERVISOR_HINT_DELAY_MS,
      );
    }, SUPERVISOR_HOLD_POLL_MS);
    return () => window.clearInterval(id);
  }, [supervisorChecking]);
  // The reveal's growth signal: stamps the stall clock, lights the jump chip
  // for an unpinned reader, then follows the pinned autoscroll (the original
  // onGrow behavior).
  const onRevealGrow = useCallback((): void => {
    lastGrowRef.current = Date.now();
    if (
      !scroll.pinnedRef.current &&
      !scroll.jumpingRef.current &&
      !scroll.syntheticUnpinRef.current
    ) {
      scroll.setNewBelow(true);
    }
    scroll.scrollToEndIfPinned();
  }, []);

  // Appended blocks light the chip the same way (record identity changes per
  // block, not per delta). Windowing (2026-07-12): compare ABSOLUTE end
  // indices so a "load earlier" PREPEND — which also changes record identity
  // while the reader is scrolled up — never lights the chip; only genuine
  // growth at the bottom does. A session switch re-baselines silently.
  const lastEndRef = useRef<{ sid: string | null; end: number }>({
    sid: null,
    end: 0,
  });
  useEffect(() => {
    const end = recordStart + record.length;
    const prev = lastEndRef.current;
    lastEndRef.current = { sid: sessionId, end };
    if (prev.sid !== sessionId) return; // new session — baseline only
    if (
      end > prev.end &&
      !scroll.pinnedRef.current &&
      !scroll.jumpingRef.current &&
      !scroll.syntheticUnpinRef.current
    ) {
      scroll.setNewBelow(true);
    }
  }, [record, recordStart, sessionId]);

  // The chip's click: glide back to the latest content. The scroll handler
  // re-pins when the glide lands at the bottom; `jumpingRef` keeps mid-glide
  // growth from re-lighting the chip, with a timeout fallback for a glide
  // interrupted by the user wheeling away.
  const jumpToLatest = useCallback((): void => {
    scroll.jumpingRef.current = true;
    scroll.setNewBelow(false);
    if (scroll.jumpTimerRef.current !== null)
      window.clearTimeout(scroll.jumpTimerRef.current);
    scroll.jumpTimerRef.current = window.setTimeout(() => {
      scroll.jumpTimerRef.current = null;
      scroll.jumpingRef.current = false;
    }, 1000);
    const el = scroll.scrollRef.current;
    if (el === null) return;
    // The TRUE bottom, for the same reason `scrollToBottom` exists: aligning
    // `endRef` leaves the approval reserve unscrolled, so with a gate open the
    // chip would land short of the bottom, leave the chip's own condition
    // still true, and spend reserved room on the way (2026-07-30). Smooth is
    // native here — this is a short hop the reader asked for, not the send's
    // page-sized climb (scroll-glide.ts).
    el.scrollTo({
      top: el.scrollHeight - el.clientHeight,
      behavior: reduced ? "auto" : "smooth",
    });
  }, [reduced]);
  useEffect(
    () => () => {
      if (scroll.jumpTimerRef.current !== null)
        window.clearTimeout(scroll.jumpTimerRef.current);
      if (scroll.jumpPollRef.current !== null)
        window.clearTimeout(scroll.jumpPollRef.current);
    },
    [],
  );
  // Presence-managed chip: the entrance transition arms one frame after
  // mount, and hiding (click, manual scroll-back, re-pin) plays the reverse
  // slide-fade before the unmount (user 2026-07-11 — it used to vanish with
  // no motion). 240ms exit ≥ the CSS's 200ms transition.
  const jumpChip = usePresence(!scroll.pinnedState && scroll.newBelow, 240);

  // ── Load-earlier paging (long sessions, 2026-07-12) ─────────────────────
  // The store holds only the trailing window; recordStart > 0 means older
  // blocks exist on the main side. Clicking pages them in; the viewport is
  // ANCHORED across the prepend (content grows ABOVE the scroll position and
  // overflow-anchor is disabled on the pane, so scrollTop must be offset by
  // the height delta manually or the visible content slides away).
  const prependAnchorRef = useRef<{
    /** The window start at click time — the offset applies only to the
     *  prepend this click caused (recordStart strictly decreases); any other
     *  window change (rewind/heal reset) clears the anchor instead. */
    expectFrom: number;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  /** The prepend anchor's mirror, armed by the unpinned live-window trim
   *  below: rows leave ABOVE the scroll position, so scrollTop must slide
   *  down by the removed height or the visible content jumps. Same clearing
   *  discipline as prependAnchorRef (rewind, session switch). */
  const trimAnchorRef = useRef<{
    /** The window start at trim time — consumed only by the recordStart
     *  INCREASE this trim caused. */
    expectFrom: number;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const loadEarlier = useCallback((): void => {
    const el = scroll.scrollRef.current;
    prependAnchorRef.current =
      el === null
        ? null
        : {
            expectFrom: sessionStore.getSnapshot().recordStart,
            scrollHeight: el.scrollHeight,
            scrollTop: el.scrollTop,
          };
    // Reading older history: drop the pin so the append-follow effect can't
    // yank the view to the bottom when the prepend lands.
    scroll.pinnedRef.current = false;
    scroll.setPinnedState(false);
    void sessionStore.loadOlderBlocks();
  }, [sessionStore]);
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    if (anchor === null) return;
    prependAnchorRef.current = null;
    if (recordStart >= anchor.expectFrom) return; // not this click's prepend
    const el = scroll.scrollRef.current;
    if (el === null) return;
    el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
  }, [recordStart]);

  // ── Topic-rail jump (2026-07-12) ─────────────────────────────────────────
  // Jump to a topic's anchoring user block. The anchor may be OLDER than the
  // loaded window — page history in first (bounded; bails if a fetch makes
  // no progress). Unpins up front so the prepends' append-follow effect can't
  // yank the view to the bottom mid-jump; the jump chip is the way back down.
  const jumpToTopic = useCallback(
    (anchorIndex: number): void => {
      void (async () => {
        // Session-bound (audit 2026-07-24, M4). Both halves below are async
        // continuations that re-read LIVE global state, so after a session
        // switch mid-jump they acted on the NEW session: the loop paged B's
        // history (visible jank on arrival) and the poll smooth-scrolled B to
        // an arbitrary older message, fighting the entrance effect that had
        // just pinned it. Captured identity + re-check after every await —
        // the pattern handleRewind already uses.
        const jumpSessionId = sessionStore.getSnapshot().sessionId;
        scroll.pinnedRef.current = false;
        scroll.setPinnedState(false);
        let guard = 0;
        while (
          sessionStore.getSnapshot().recordStart > anchorIndex &&
          guard < 60
        ) {
          guard += 1;
          const before = sessionStore.getSnapshot().recordStart;
          await sessionStore.loadOlderBlocks(
            Math.min(500, before - anchorIndex),
          );
          if (sessionStore.getSnapshot().sessionId !== jumpSessionId) return;
          if (sessionStore.getSnapshot().recordStart >= before) return; // no progress — bail
        }
        // Scroll once the anchor row exists: immediately when it is already
        // in the DOM (the common in-window case), else poll briefly for the
        // prepend's React commit. A TIMER, deliberately not rAF: rAF never
        // fires in a hidden/background window (found live in the website
        // demo pane, where a rAF-gated jump parked forever), while timers
        // run everywhere.
        const tryScroll = (attempt: number): void => {
          // The poll outlives the click: bail the moment the session changes,
          // and keep the handle so the session-entrance effect can cancel a
          // still-pending tick (M4 — it was previously stored nowhere, so
          // nothing could stop it).
          if (sessionStore.getSnapshot().sessionId !== jumpSessionId) return;
          const el = scroll.scrollRef.current?.querySelector(
            `[data-abs-index="${anchorIndex}"]`,
          );
          if (el !== null && el !== undefined) {
            el.scrollIntoView({
              block: "start",
              behavior: reduced ? "auto" : "smooth",
            });
            return;
          }
          if (attempt < 10) {
            scroll.jumpPollRef.current = window.setTimeout(
              () => tryScroll(attempt + 1),
              50,
            );
          }
        };
        tryScroll(0);
      })();
    },
    [sessionStore, reduced],
  );

  // Search-result landing (2026-07-27): a sidebar card that matched by CONTENT
  // asks, via the store, to land on the matched turn instead of the latest —
  // the search knew the moment and the open used to throw it away. Reuses the
  // topic jump wholesale: it already pages older blocks in, waits for the row
  // to commit, and bails on a session switch. Consumed once, then cleared, so
  // a later record change cannot re-fire it.
  useEffect(() => {
    // Only once the REQUESTED session is the one on screen: the request is
    // made before `openSession`, so consuming it unconditionally would fire
    // against the transcript still displayed and jump in the wrong session
    // (whose guard would then bail on the switch, landing nowhere).
    if (pendingJump === null || pendingJump.sessionId !== sessionId) return;
    sessionStore.clearPendingJump();
    jumpToTopic(pendingJump.blockIndex);
  }, [pendingJump, sessionId, sessionStore, jumpToTopic]);

  // Follow appended blocks / status rows while pinned. The per-frame reveal
  // growth is followed via StreamingReply's onGrow (this component no longer
  // re-renders per frame, so it can't watch the fill from here). EVERY
  // conditionally-mounted row below the flow needs its trigger here, or it
  // mounts below the fold on a full pane (user bug 2026-07-11: the 伽马风暴
  // hold row appeared behind the composer while the galaxy row — covered by
  // showInFlight — scrolled into view; the turn-failed row rides its
  // `status` → idle edge).
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are intentional scroll triggers, not effect inputs
  useEffect(() => {
    scroll.scrollToEndIfPinned();
  }, [
    record,
    pendingUser,
    status,
    showInFlight,
    // The row leaves on its own timer, and its removal changes the flow's
    // height like any other row's — a pinned reader must follow that too; the
    // deferred successors (处理中, the failure notice, the reply bubble) mount
    // on that same edge, and on the send arm resolving.
    inFlightExiting,
    sendArmed,
    showSupervisorHold,
    backendActive,
    recapCompacting,
  ]);

  // Sending re-pins — but only for a reader who was already AT the bottom.
  // This fires on the commit BEFORE the morph clone mounts and measures, so
  // the slot rects the rise captures are post-scroll.
  //
  // It used to re-pin unconditionally ("your own send always lands you at the
  // bottom"), which yanked the pane out from under anyone reading history: type
  // a message while scrolled up in a long thread, press send, and the view
  // teleported to the end (user 2026-08-03). Sending is not a request to stop
  // reading. Scrolled up, the send now leaves the viewport exactly where it is
  // and lights the jump-to-bottom chip instead — the reader returns when they
  // choose to, and the chip is the affordance that already exists for it.
  useEffect(() => {
    if (pendingUser === null) return;
    // A DISCLOSURE unpin is not "reading history" (owner 2026-08-10). Opening
    // an activity history or a detail pane unpins on purpose — the follow must
    // not yank the viewport past what was just opened — but the reader is
    // still sitting at the bottom, and sending IS a request to see their own
    // message. Treated as scrolled-away it lost both halves of the send at
    // once: no flight (the clone declines to fly into a blind spot) and the
    // jump chip lit while the reader had never left. `syntheticUnpinRef` is
    // cleared by the first real scroll event, so a reader who expands and THEN
    // scrolls away is genuinely reading history and still gets the chip.
    if (!scroll.pinnedRef.current && !scroll.syntheticUnpinRef.current) {
      // Reading history. The message still lands in the flow below; the chip
      // says so. No re-pin, no headroom reservation (its measurements describe
      // an anchor that is off screen), no travel — and the detection effect
      // above has already declined to fly a clone into the same blind spot.
      scroll.setNewBelow(true);
      return;
    }
    scroll.rePin();
    // Fix the extent BEFORE the scroll, so "the end" is already the anchored
    // position when we land there — one scroll, not a jump followed by a
    // correction. The morph clone mounts on the next commit and measures a
    // slot that is final in both axes.
    //
    // The question is what the reader can SEE: is there already blank pane
    // under the conversation for this answer to land in? A short previous
    // answer leaves most of its reservation unused, and re-anchoring there
    // scrolled the thread up to make room that was already on screen (user
    // 2026-07-29). Holding the extent instead drops this message into that
    // blank without moving anything, and only re-fixes it once the answers
    // have actually eaten the room.
    //
    // LATCHED here, for this turn. Asked continuously, a growing reply would
    // cross the threshold mid-answer and reserve underneath it — a jump,
    // from a decision that belongs to the moment you pressed send.
    const el = scroll.scrollRef.current;
    const anchorTop = scroll.measureAnchorTop();
    const reserve =
      el !== null &&
      anchorTop !== null &&
      needsRoom({
        contentBottom: scroll.measureContentBottom(),
        maxScroll: el.scrollHeight - el.clientHeight,
        viewport: el.clientHeight,
      });
    if (reserve && el !== null && anchorTop !== null) {
      scroll.headroomExtentRef.current = targetExtentFor({
        anchorTop,
        viewport: el.clientHeight,
      });
    }
    scroll.syncHeadroom();
    // Making room moves the view a long way — most of a pane — so it GLIDES.
    // An instant landing reads as the page having been replaced rather than
    // scrolled (user 2026-07-29). Landing in room that already existed has
    // nothing to travel, and keeps the immediate landing it always had.
    const glide = reserve && !reduced;
    // ONE MOVE AT A TIME (user 2026-07-30). The climb and the bubble's flight
    // used to start together, so the page slid upward while the bubble was
    // still crossing it — two motions competing for the same eye, and the
    // flight had to aim at a slot that was moving. Sequenced: park at the
    // bottom of the REAL content, where the message lands flush against the
    // bottom edge with the reserved room still off screen, and hand the climb
    // to the flight's settle (see runPendingGlide).
    if (glide && el !== null && outgoingFlightArmedRef.current) {
      scroll.pendingGlideRef.current = true;
      // The scroller is OURS from here until the climb lands, and saying so
      // before parking is load-bearing: parking is a scroll AWAY from the
      // bottom, and the scroll handler's ratchet reads exactly that as the
      // reader stepping out of the reserved room and spends it (measured live
      // 2026-07-30 — the reservation evaporated on the park and the climb then
      // had 0px to travel). The fallback release covers a flight that never
      // settles; `beginGlide` replaces it with the real window when the climb
      // actually starts.
      scroll.glidingRef.current = true;
      scroll.jumpingRef.current = true;
      if (scroll.jumpTimerRef.current !== null) {
        window.clearTimeout(scroll.jumpTimerRef.current);
      }
      scroll.jumpTimerRef.current = window.setTimeout(() => {
        scroll.jumpTimerRef.current = null;
        scroll.jumpingRef.current = false;
        scroll.glidingRef.current = false;
        scroll.pendingGlideRef.current = false;
        scroll.scrollToEndIfPinned();
      }, OUTGOING_FLIGHT_MS + GLIDE_WINDOW_MS);
      el.scrollTop = preGlideScrollTop({
        contentBottom: scroll.measureContentBottom(),
        viewport: el.clientHeight,
      });
      // Record the parked position (post-assignment, so it carries the
      // browser's clamp): the scroll handler treats any OTHER position seen
      // during the park as the reader taking over.
      scroll.parkedScrollTopRef.current = el.scrollTop;
      return;
    }
    // Nothing is going to fly (no overlay/composer, or reduced motion), so
    // there is no settle to wait for: travel now, as it always did.
    if (glide) scroll.beginGlide();
    else scroll.scrollToBottom();
  }, [pendingUser, reduced]);

  // Live-window trim (audit T3.5): live appends grow the windowed record
  // without bound — the 200-block tail bound (RECORD_TAIL_BLOCKS) applies
  // only to reset/open payloads — so a marathon sitting climbs mounted DOM
  // rows and per-commit reconcile cost forever. While the reader is PINNED
  // at the bottom, drop the window back to the tail bound once it runs 60
  // past it (hysteresis, not a per-block slice): the removed rows sit far
  // above the fold, the browser clamps scrollTop at the shrunken bottom
  // (still pinned), and "load earlier" pages them back on demand. Never
  // trims under an unpinned reader (they may be reading those rows — the
  // geometry-guarded sibling below owns that case) or while a morph clone
  // is measuring row slots (a shrinking flow would move its landing slot —
  // the same bug class the morphs just escaped).
  useEffect(() => {
    if (!scroll.pinnedRef.current || scroll.morphInFlightRef.current) return;
    if (record.length > 260) {
      // An armed reservation is a content-coordinate total; trimming rows
      // above it without sliding it down converts their height into spacer,
      // shoving the pinned view (streaming reply included) off the top
      // (review 2026-07-31). The height isn't knowable until the shrunken
      // flow lays out, so flag the next sync to rebase — the spacer keeps
      // its current size across the trim.
      if (scroll.headroomExtentRef.current !== null) {
        scroll.headroomRebaseRef.current = true;
      }
      sessionStore.trimRecordWindow(200);
    }
  }, [record, sessionStore]);

  // Unpinned live-window trim (2026-08-25): the T3.5 trim above stands down
  // while the reader is scrolled up, which left a marathon run under an
  // unpinned reader growing the mounted window without bound — every commit
  // re-grouping and reconciling every mounted row. This sibling claims only
  // rows the reader provably is not looking at: the cut lands on a user row
  // (`data-abs-index` rows are in flow order, so everything before one sits
  // strictly above it — and a user block always starts a fresh groupRecord
  // run, so survivors regroup identically) whose top sits at least one
  // viewport ABOVE the visible region, so a casual scroll-up never lands
  // straight on the load-earlier cliff. The viewport is anchored across the
  // commit by trimAnchorRef — the load-earlier prepend anchor in reverse —
  // so visible content does not move. Nothing is lost: "load earlier" pages
  // the dropped rows back on demand.
  //
  // Fires only on APPEND growth (the record END advancing): a load-earlier
  // prepend is the reader ASKING for old rows, so it must never trip a trim
  // however large it grows the window. Stands down whenever the scroll
  // geometry is spoken for — morph flights (clones measured their slots),
  // glides/jumps/parks (a scripted scroll is mid-travel), a pending
  // topic-jump poll (its anchor row must stay mounted), an armed headroom
  // reservation (a content-coordinate total the trim would shove), or an
  // unconsumed prepend/trim anchor. The residual unbounded case is a reader
  // camped mid-history for a whole marathon: rows from their viewport DOWN
  // to the live end can never be trimmed (the window is one contiguous
  // tail), so growth below the fold remains — this bounds everything above.
  const prevUnpinnedEndRef = useRef(0);
  useEffect(() => {
    const end = recordStart + record.length;
    const prevEnd = prevUnpinnedEndRef.current;
    prevUnpinnedEndRef.current = end;
    if (end <= prevEnd) return; // reset/rewind/trim/prepend — not append growth
    if (scroll.pinnedRef.current) return; // the pinned trim above owns this
    if (record.length <= UNPINNED_TRIM_AT) return;
    if (
      scroll.morphInFlightRef.current ||
      scroll.glidingRef.current ||
      scroll.jumpingRef.current ||
      scroll.jumpPollRef.current !== null ||
      scroll.headroomExtentRef.current !== null ||
      prependAnchorRef.current !== null ||
      trimAnchorRef.current !== null
    ) {
      return;
    }
    const el = scroll.scrollRef.current;
    if (el === null) return;
    // Cheap pre-guard: with less than one viewport of content above the
    // fold, no margin-respecting cut exists — skip the DOM scan entirely.
    if (el.scrollTop <= el.clientHeight) return;
    const paneTop = el.getBoundingClientRect().top;
    const rows = el.querySelectorAll<HTMLElement>("[data-abs-index]");
    if (rows.length === 0) return;
    // Last user row whose top sits ≥ one viewport above the visible top.
    // Rows are in flow order, so their tops are monotonic: binary search,
    // ~10 rect reads (the TopicRail scrollspy lesson) — and at most one
    // forced layout, since nothing writes between reads.
    const limit = paneTop - el.clientHeight;
    let lo = 0;
    let hi = rows.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const row = rows[mid];
      if (row !== undefined && row.getBoundingClientRect().top <= limit) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found === -1) return;
    const cut = Number(rows[found]?.dataset.absIndex);
    if (!Number.isFinite(cut)) return;
    const trimCount = Math.min(
      cut - recordStart,
      record.length - UNPINNED_TRIM_KEEP_TAIL,
    );
    if (trimCount < UNPINNED_TRIM_MIN) return;
    trimAnchorRef.current = {
      expectFrom: recordStart,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
    };
    sessionStore.trimRecordWindow(record.length - trimCount);
  }, [record, recordStart, sessionStore]);
  // Anchor consumption — the prepend consumer's mirror: the trimmed rows
  // left from ABOVE the scroll position, so scrollTop slides down by the
  // removed height in the same pre-paint pass (overflow-anchor is disabled
  // on the pane; nothing else compensates). Keyed on recordStart — a trim
  // strictly raises it, so the guard is the increase this trim caused.
  useLayoutEffect(() => {
    const anchor = trimAnchorRef.current;
    if (anchor === null) return;
    trimAnchorRef.current = null;
    if (recordStart <= anchor.expectFrom) return; // not this trim's commit
    const el = scroll.scrollRef.current;
    if (el === null) return;
    el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
  }, [recordStart]);

  // A tail-shrink of the record is a rewind: the reservation belonged to the
  // withdrawn turn, so it leaves with it (review 2026-07-31 — "the headroom
  // belongs to a turn YOU sent", and that turn is gone). Left armed, the
  // spacer grew by exactly the withdrawn rows' height and the pinned follow
  // parked the view on blank pane. Layout effect: the spacer must shrink in
  // the same commit the rows unmount, not a paint later. Session switches
  // also pass through here when the next session is shorter — harmless, the
  // entrance effect below releases the extent regardless.
  const prevRecordEndRef = useRef(0);
  useLayoutEffect(() => {
    const end = recordStart + record.length;
    const prev = prevRecordEndRef.current;
    prevRecordEndRef.current = end;
    if (end < prev) {
      // A rewind also invalidates a still-armed load-earlier anchor (review
      // 2026-07-31): its saved geometry predates the truncation, and it can
      // survive here when the reset happens not to move recordStart (the
      // anchor-consuming effect keys on that alone). The trim anchor saves
      // the same kind of geometry — same discipline.
      prependAnchorRef.current = null;
      trimAnchorRef.current = null;
      if (scroll.headroomExtentRef.current !== null) {
        scroll.headroomExtentRef.current = null;
        scroll.syncHeadroom();
      }
    }
  }, [record, recordStart]);

  // Session-scoped transients the entrance effect predates (review
  // 2026-07-31, Class A): `jumpingRef` is cleared only by a scroll that
  // lands pinned, so a switch mid-jump or mid-park left it latched in the
  // NEW session, silently suppressing the jump chip until the reader
  // touched bottom once; the park's fallback timer could fire its
  // scrollToEndIfPinned up to ~1.5s into the next session; and a
  // load-earlier anchor that survived a failed fetch would apply its saved
  // offset against another session's geometry entirely.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the clear trigger, not an input
  useEffect(() => {
    scroll.jumpingRef.current = false;
    if (scroll.jumpTimerRef.current !== null) {
      window.clearTimeout(scroll.jumpTimerRef.current);
      scroll.jumpTimerRef.current = null;
    }
    prependAnchorRef.current = null;
    trimAnchorRef.current = null;
  }, [sessionId]);

  // Session-switch stagger entrance (SPEC 2026-06-20-session-switch-transition).
  // On a genuine switch between two sessions, the newly-loaded conversation's
  // VISIBLE rows settle in with a staggered fade + upward drift; rows scrolled
  // out of view above just snap to their final state — no point animating unseen
  // content, and it keeps the cascade short on long threads. Runs on a switch
  // between sessions AND on entering one from the connect screen; skipped on a
  // blanking reset (→ no session), a same-session re-open, and reduced motion.
  // Imperative because it needs post-layout measurement of which rows
  // are visible; it doesn't fight React (the styles sit on record rows that have
  // no `style` prop, and self-clear once the cascade finishes).
  const prevSessionId = useRef<string | null>(null);
  const entranceTimer = useRef<number | null>(null);
  useLayoutEffect(() => {
    const prev = prevSessionId.current;
    prevSessionId.current = sessionId;
    // Animate any change INTO a session — a switch between two sessions, OR
    // entering one from the connect screen (prev null → session). Skip a
    // blanking reset (→ no session) and a same-session re-open.
    if (sessionId === null || prev === sessionId) {
      // A blanking reset (current session deleted → connect page) still
      // clears the pin/chip state — Conversation stays mounted behind the
      // connect screen, so a live 回到底部 chip otherwise floats over it
      // (user bug 2026-07-24). No scroll or entrance cascade: there is no
      // session to land in.
      if (sessionId === null && prev !== null) {
        scroll.rePin();
        scroll.headroomExtentRef.current = null;
        scroll.pendingGlideRef.current = false;
        scroll.scrollGlideRef.current?.cancel();
        scroll.scrollGlideRef.current = null;
        scroll.syncHeadroom();
        if (scroll.jumpPollRef.current !== null) {
          window.clearTimeout(scroll.jumpPollRef.current);
          scroll.jumpPollRef.current = null;
        }
      }
      return;
    }
    // Any session change cancels a topic-jump poll left over from the one we
    // are leaving (audit 2026-07-24, M4).
    if (scroll.jumpPollRef.current !== null) {
      window.clearTimeout(scroll.jumpPollRef.current);
      scroll.jumpPollRef.current = null;
    }
    // Entering a session normally lands pinned at the bottom (even under
    // reduced motion, where the entrance cascade below is skipped) — UNLESS
    // it was opened from a search hit, which asked for a specific turn
    // (2026-07-27). Both used to run: this re-pinned and scrolled to the end
    // while the jump scrolled elsewhere from an async continuation, so the
    // landing came down to which won.
    //
    // The store read is reliable because the request is issued BEFORE
    // `openSession` (see SessionItem) and `onReset` preserves it — so by the
    // time this fires on the session change, the intent is already recorded.
    const jumpRequested =
      sessionStore.getSnapshot().pendingJump?.sessionId === sessionId;
    // The headroom belongs to a turn YOU sent, in the session you sent it
    // from. Arriving somewhere new lands at the real bottom, as it always
    // has — reserving space under someone else's last turn would read as a
    // rendering fault, not as room for an answer.
    scroll.headroomExtentRef.current = null;
    scroll.glidingRef.current = false;
    // A climb owed to a flight in the session we are LEAVING must not fire in
    // the one we are entering — the flight's clone unmounts on the switch, and
    // its settle effect would otherwise travel this session's scroller. A
    // climb already RUNNING is worse: flags alone don't stop its rAF loop.
    scroll.pendingGlideRef.current = false;
    scroll.scrollGlideRef.current?.cancel();
    scroll.scrollGlideRef.current = null;
    scroll.syncHeadroom();
    if (!jumpRequested) {
      scroll.rePin();
      scroll.scrollToBottom();
    }
    if (reduced) return;
    const container = scroll.scrollRef.current;
    if (container === null) return;
    const rowEls = Array.from(
      container.querySelectorAll<HTMLElement>(
        ".message-row, .activity-line-group",
      ),
    );
    if (rowEls.length === 0) return;
    if (entranceTimer.current !== null) {
      window.clearTimeout(entranceTimer.current);
      entranceTimer.current = null;
    }
    // Rows are reused across switches (keyed by index): clear any stale entrance
    // styles before measuring. The getBoundingClientRect reads below force the
    // reflow that lets re-applying the same keyframe restart cleanly.
    for (const el of rowEls) {
      el.style.animation = "";
      el.style.animationDelay = "";
    }
    const cr = container.getBoundingClientRect();
    const plan = planStaggerEntrance({
      rows: rowEls.map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top - cr.top, bottom: r.bottom - cr.top };
      }),
      viewport: { top: 0, bottom: cr.height },
      staggerMs: ENTRANCE_STAGGER_MS,
    });
    let maxDelay = 0;
    const animated: HTMLElement[] = [];
    plan.forEach((delay, idx) => {
      const el = rowEls[idx];
      if (el === undefined) return;
      el.style.animation = `conv-switch-in ${ENTRANCE_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1) both`;
      el.style.animationDelay = `${delay}ms`;
      animated.push(el);
      if (delay > maxDelay) maxDelay = delay;
    });
    entranceTimer.current = window.setTimeout(
      () => {
        for (const el of animated) {
          el.style.animation = "";
          el.style.animationDelay = "";
        }
        entranceTimer.current = null;
      },
      ENTRANCE_DURATION_MS + maxDelay + 80,
    );
    return () => {
      if (entranceTimer.current !== null) {
        window.clearTimeout(entranceTimer.current);
        entranceTimer.current = null;
      }
    };
    // sessionStore is provider-stable; it is a dep only because the
    // stand-down check reads the pending jump straight off the snapshot.
  }, [sessionId, reduced, sessionStore]);

  // Memoized on record identity: the store mutates `record` only per BLOCK
  // (deltas accumulate in streamingText), so the grouping — O(n) over all
  // blocks — reruns per block, not per delta/frame.
  const items = useMemo(
    // Pictures sent with a message ride the bubble rather than the activity
    // run that carries them in the record (ADR 0048 §4) — same record,
    // different overlay.
    () => liftUserImages(groupRecord(record)),
    [record],
  );
  // The CURRENT dispatch's 任务清单, scanned across the WHOLE record — an
  // in-turn beat splits one backend run into several activity groups, and
  // each ActivityBlock sees only its own blocks, so the continuation group
  // has no todo projection of its own to read. Computed once here (O(n)
  // backward from the end, memoized on the record like `items`) and handed
  // ONLY to the group rendered as active, below.
  const plan = useMemo(() => planContext(record), [record]);
  // Attachment take-back (ADR 0033, owner 2026-08-10). Undefined while a turn
  // runs or with no session — the removal rides the same out-of-turn record
  // write as the attach, so an ✕ that could only earn a refusal is not shown
  // at all. A FACTORY per stored path so ActivityStep holds no record state;
  // memoized on the two things it closes over, keeping the rows memo stable
  // between turns.
  const removeAttachmentFactory = useMemo(() => {
    if (sessionId === null || status !== "idle") return undefined;
    return (path: string) => () => {
      void bridge
        .removeAttachment(sessionId, path)
        .then((r) => {
          if (!r.ok) {
            sessionStore.setComposerNotice(
              t("activity.attachment.removeFailed"),
            );
          }
        })
        .catch(() =>
          sessionStore.setComposerNotice(t("activity.attachment.removeFailed")),
        );
    };
  }, [sessionId, status, bridge, sessionStore, t]);
  // The rewind control shows only on the LATEST user turn, and only when idle
  // (no in-flight turn to race the truncation). Find the last `user` block index.
  const lastUserIndex = useMemo(() => {
    for (let i = record.length - 1; i >= 0; i--) {
      if (record[i]?.kind === "user") return i;
    }
    return -1;
  }, [record]);
  // The optimistic echo's send time, stamped once per pending message: a
  // fresh ISO string per render would change the bubble's `at` prop on every
  // reveal frame and defeat its memo. `pendingUser` always passes through
  // null between sends, so the memo cannot serve a stale stamp to a repeat
  // of the same text.
  const pendingUserAt = useMemo(
    () => (pendingUser === null ? undefined : new Date().toISOString()),
    [pendingUser],
  );
  // ── the bubble rows ──────────────────────────────────────────────────────
  // Memoized on their REAL inputs (user profile 2026-07-12): per-frame state
  // flickers during the sidebar slide (pinned, fog edges) re-rendered
  // Conversation ~60×/s, and every render re-ran renderBlock — 240 × Intl date
  // formatting — measured as 119ms scripting per 210ms of animation plus an
  // 89ms long task on the toggle click itself.
  //
  // Split out from the activity rows (2026-07-30) so that "their real inputs"
  // is actually true. Sharing one memo with the activity groups meant sharing
  // their dependencies — status, turnStartedAt, backendStartedAt,
  // backendInFlight, backendActive, plan, canRewind — every one of which flips
  // at the moment of a send, so pressing send re-rendered every bubble in the
  // session, and again when the turn ended. None of them can change what a
  // bubble looks like. Now they cannot reach one: this memo survives a send,
  // the elements it holds stay referentially identical, and React skips those
  // subtrees outright.
  //
  // Aligned with `items` (activity slots hold null) so the assembly below can
  // index straight into it.
  const blockRows = useMemo(
    () =>
      items.map((item) =>
        item.kind === "block" ? (
          // Every row wrapped in a boundary (audit 2026-07-13 T2.2): a
          // render throw in one bubble is contained to that bubble. The
          // boundary renders its child directly (no wrapper DOM), so the
          // entrance-stagger child scan is unaffected.
          //
          // ABSOLUTE index as the key (windowing): a load-earlier
          // prepend shifts every relative index, which would remount
          // (and re-run entrance styles on) every existing row.
          <ErrorBoundary
            key={recordStart + item.index}
            label="record-row"
            fallback={<RowRenderError />}
          >
            {renderBlock(
              item.block,
              recordStart + item.index,
              lang,
              // Handed over whenever this IS the latest user turn; whether a
              // rewind is allowed right now is no longer part of the row's
              // render (see handleRewind's own idle check, and the
              // `.is-busy` rule that hides the control mid-turn).
              item.index === lastUserIndex ? handleRewind : undefined,
              item.images,
            )}
          </ErrorBoundary>
        ) : null,
      ),
    // The 30s clock is deliberately absent (perf 2026-08-25): timestamps
    // subscribe to the shared tick in their BubbleTime leaf, so a tick
    // invalidates label leafs, never these row elements.
    [items, recordStart, lang, lastUserIndex, handleRewind],
  );

  // ── assembly ────────────────────────────────────────────────────────────
  // Re-runs when the turn state moves, but only the activity groups are built
  // here; the bubble rows come from `blockRows` by reference.
  const rows = useMemo(
    () =>
      items.map((item, idx, all) => {
        if (item.kind === "block") return blockRows[idx];
        const isLast = idx === all.length - 1;
        // "Live" requires the CURRENT turn to actually own this group (audit
        // 2026-07-24, L1). The terminal-marker guard only recognizes 板砖's
        // done/noop markers, so an out-of-turn 系统 note (a workspace set /
        // reset) has none — and the moment the NEXT turn started, that
        // already-committed historical row began pulsing with a shimmering
        // header and a duration counting from 0s, as if 板砖 were performing
        // it right now. A backend anchor is the honest signal: it is null
        // until a dispatch actually starts, and the turn-start handler
        // clears it.
        const isActive =
          isLast &&
          status !== "idle" &&
          !activityHasTerminalMarker(item.blocks) &&
          (backendActive || backendStartedAt !== null);
        return (
          <ErrorBoundary
            key={`a${recordStart + item.startIndex}`}
            label="activity-row"
            fallback={<RowRenderError />}
          >
            <ActivityBlock
              blocks={item.blocks}
              active={isActive}
              // Live-turn state reaches only the live TURN's groups — every
              // group after the last user block, which includes the born-done
              // parts a beat split minted (they freeze their whole-run
              // duration from backendStartedAt while it is still set, so
              // strict `isActive` would starve them). Handed to every group,
              // the timestamps' null↔value flips at each turn boundary
              // defeated ActivityBlock's memo for the whole mounted history —
              // the last live-turn state still reaching historical rows after
              // adf67dc (perf review 2026-07-31).
              turnStartedAt={
                item.startIndex > lastUserIndex ? turnStartedAt : null
              }
              backendStartedAt={
                item.startIndex > lastUserIndex ? backendStartedAt : null
              }
              lang={lang}
              inFlightCount={isActive ? backendInFlight : 1}
              // Same discipline as inFlightCount: a historical group must
              // never receive live state. `plan` describes the dispatch in
              // flight, so a past group showing it would claim 板砖 is
              // working through a plan it finished turns ago.
              plan={isActive ? plan : null}
              onRemoveAttachment={removeAttachmentFactory}
            />
          </ErrorBoundary>
        );
      }),
    [
      items,
      blockRows,
      recordStart,
      lang,
      status,
      turnStartedAt,
      backendStartedAt,
      backendInFlight,
      plan,
      removeAttachmentFactory,
      // Read by the activity group's `isActive` (L1) — without it the rows
      // memo would keep rendering the last group as live after the backend
      // stopped.
      backendActive,
      // The live-turn gate above. Changes only with the record, which
      // already invalidates via `items` — listed for the lint contract.
      lastUserIndex,
    ],
  );
  // Mirrors TopicRail's own render guard: when the rail is up, the shell
  // reserves a left gutter so ticks never overlap content (activity LEDs)
  // on panes narrower than the flow's centered measure.
  const railVisible = topics.length >= 2;
  return (
    <ConversationPinProvider unpin={scroll.unpin}>
      <div
        className={`conversation-shell${railVisible ? " has-topic-rail" : ""}`}
      >
        <div
          className={`conversation${scroll.fog.top ? " has-fog-top" : ""}${
            scroll.fog.bottom ? " has-fog-bottom" : ""
          }`}
          ref={scroll.scrollRef}
        >
          {/* Centered readable column (user feedback 2026-07-06): with the left
            sidebar hidden the pane widens and fixed-width bubbles hugging the
            edges left the middle empty. The flow caps at a readable measure
            and centers; below the cap it is width-neutral. */}
          {/* `is-busy` hides the rewind control while a turn runs (the CSS
            rule, 2026-07-30). It used to be withheld as a prop, which put the
            turn's status inside the row memo and re-rendered every row in the
            session on send; a class on this one element costs nothing and the
            handler carries the real guard. */}
          <div
            ref={flowRef}
            className={`conversation-flow${status === "idle" ? "" : " is-busy"}`}
          >
            {/* Load-earlier paging: the window's start > 0 means older blocks
              exist main-side. In-flow (scrolls with the history it extends);
              the viewport is anchored across the prepend (see loadEarlier). */}
            {recordStart > 0 && (
              <button
                type="button"
                className="load-earlier"
                onClick={loadEarlier}
              >
                {t("workspace.loadEarlier", { n: recordStart })}
              </button>
            )}
            {/* Rows are keyed by record index, which COLLIDES across sessions —
            the panel stays mounted through a switch, so React would reuse row
            instances and leak per-row state (an ActivityBlock's expanded
            toggle / frozen duration from session A showing on session B's
            group at the same index). The session-keyed Fragment remounts the
            row set per session; within one session, indices are stable
            (append-only record). */}
            <Fragment key={sessionId ?? "none"}>{rows}</Fragment>
            {pendingUser !== null && (
              <UserBubble
                text={pendingUser}
                lang={lang}
                // Optimistic local echo of the just-sent message — stamped at
                // the send (pendingUserAt), so it reads "just now". Once it
                // lands in the record it carries the stamped `at` (same
                // minute), so the label stays stable.
                at={pendingUserAt}
                hidden={hidePendingUser}
                bubbleRef={pendingUserBubbleRef}
                {...(pendingEchoImages.length > 0
                  ? { images: pendingEchoImages }
                  : {})}
              />
            )}
            {outgoingClone !== null && pendingUser !== null && (
              <MorphClone
                ref={cloneRef}
                overlay={overlayRef}
                variant="user"
                text={outgoingClone.text}
                lang={lang}
                {...(outgoingClone.images.length > 0
                  ? { images: outgoingClone.images }
                  : {})}
                {...(outgoingClone.imagesWidthPx !== undefined
                  ? { imagesWidthPx: outgoingClone.imagesWidthPx }
                  : {})}
              />
            )}
            <StreamingReply
              lang={lang}
              // Held back while an in-flight row is still on screen — the
              // reply enters after the row's fade (see visibleStreamingText).
              streamingText={visibleStreamingText}
              retryText={retryText}
              retracting={retracting}
              retractKeepLen={retractKeepLen}
              reduced={reduced}
              hideStreaming={hideStreaming}
              showIncomingClone={incomingClone}
              streamingBubbleRef={streamingBubbleRef}
              incomingCloneRef={incomingCloneRef}
              overlayRef={overlayRef}
              onGrow={onRevealGrow}
            />

            {/* Supervisor judgment hold (bug 4): sits right under the held
            streaming bubble; mutually exclusive with the in-flight rows
            (inFlightSettled excludes supervisorChecking, and a live stream
            excludes the galaxy anyway). */}
            {showSupervisorHold && <SupervisorHoldRow />}
            {/* Both rows ride `inFlightPresent` — which carries the
            render-synchronous hide, the minimum-visible hold, AND the quiet
            exit fade; see the definitions for why those are one expression. */}
            {inFlightPresent && recapCompacting && (
              <RecapCompactRow exiting={inFlightExitingVisible} />
            )}
            {inFlightPresent && !recapCompacting && (
              <GalaxyTravelRow exiting={inFlightExitingVisible} />
            )}
            {/* Non-interrupt turn failure (slice 4): the reply was lost to a
            provider/connection error and nothing committed — say so instead
            of silently evaporating the half-typed sentence. */}
            {/* Deferred like 处理中… below: while the in-flight row is up or
            fading (or the send that will bring it up has not settled yet), the
            notice waits — the message went out, the row travels, THEN "the
            reply was lost". Never both at once (review 2026-07-31). */}
            {turnFailed &&
              status === "idle" &&
              !inFlightPresent &&
              !sendArmed && (
                <TurnFailedRow
                  status={turnFailedStatus}
                  providerCode={turnFailedProviderCode}
                />
              )}
            {/* The 处理中… backend placeholder sits at the BOTTOM of the flow —
          backend work happens after Herta speaks the @板砖 delegation, so it
          must appear below her reply (record block or still-streaming bubble),
          never above it. Hidden once the real activity group is active. Also
          deferred while the in-flight row is still holding its minimum OR
          fading out — that row renders ABOVE this slot, so mounting under it
          shoved this row down and let it slide back up when the row left;
          instead the row leaves first (through its exit fade) and this one
          fades in where it stood (user 2026-07-31). */}
            {backendActive &&
              !inFlightPresent &&
              // …and while a send is armed but its row not yet up (the bubble
              // is still flying), so a backend that starts before the morph
              // settles does not put 处理中 under a bubble in flight, only to
              // yield to the row a moment later.
              !sendArmed &&
              (() => {
                const last = items[items.length - 1];
                const lastIsActive =
                  last !== undefined &&
                  last.kind === "activity" &&
                  status !== "idle" &&
                  !activityHasTerminalMarker(last.blocks);
                return lastIsActive ? null : (
                  <PendingActivity
                    turnStartedAt={turnStartedAt}
                    backendStartedAt={backendStartedAt}
                    lang={lang}
                  />
                );
              })()}
            {/* Turn headroom: empty room reserved under the newest turn so
              the answer fills a region instead of crawling along the bottom
              edge. Height is written imperatively (turn-headroom.ts); it is
              0 until you send, and 0 again once a turn outgrows the pane. */}
            <div
              ref={scroll.headroomRef}
              className="turn-headroom"
              aria-hidden="true"
            />
            <div ref={scroll.endRef} aria-hidden="true" />
          </div>
        </div>
        {/* Jump-to-latest chip: new content arrived below a reader who scrolled
          up (pinned autoscroll correctly stays off; this is the one-click way
          back). Floats over the bottom scroll.fog; hidden the moment the reader is
          back at the bottom — by click or by scrolling there themselves. */}
        {/* Topic guide rail: one tick per topic on the left edge; hover swells
          the neighborhood + raises the topic card, click jumps (paging older
          history in if the anchor is outside the loaded window). Keyed by
          session so its transient state (fold expansion, hover) never leaks
          across a switch. */}
        <TopicRail
          key={sessionId ?? "none"}
          topics={topics}
          lang={lang}
          onJump={jumpToTopic}
          scrollerRef={scroll.scrollRef}
        />
        {jumpChip.mounted && (
          <button
            type="button"
            className={`jump-to-latest${jumpChip.open ? " is-open" : ""}`}
            onClick={jumpToLatest}
          >
            <span className="jump-to-latest__arrow" aria-hidden="true">
              ↓
            </span>
            {t("workspace.jumpToLatest")}
          </button>
        )}
      </div>
    </ConversationPinProvider>
  );
});
