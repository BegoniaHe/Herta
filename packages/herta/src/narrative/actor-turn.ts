import type {
  AgentEvent,
  CodingAgentRuntime,
  CompletionProviderAdapter,
  EventBus,
  ProviderAdapter,
  SystemBlock,
  TerminalRecord,
  TerminalRecordBlock,
} from "@herta/core";
import {
  type ActorHints,
  defaultActorHintsFor,
  selectBeatHint,
} from "./actor-hints.js";
import {
  type ActorPrompt,
  type StaticHertaPrefix,
  serializeActorPrompt,
} from "./actor-prompt.js";
import type { BeatFirer } from "./backend-bridge.js";
import { invokeBanzhuanBridge } from "./backend-bridge.js";
import { BeatPolicy } from "./beat-policy.js";
import {
  isPlaceholderOnly,
  isUnusableBlock,
  type RetryCause,
  retryCause,
  stripHintScaffolding,
} from "./block-shape.js";
import { commonPrefixLen } from "./common-prefix.js";
import { sanitizeActorText } from "./escape.js";
import { lastNTurnsForSupervisor } from "./intent-router.js";
import type { AttachedMetaThink, MoodState } from "./meta-think.js";
import {
  neutralizeBanzhuanTrigger,
  parseHertaBlock,
  stripBanzhuanTrigger,
} from "./parse.js";
import type { PromptLang } from "./prompt-lang.js";
import {
  type PreparedRecap,
  prepareTurnRecap,
  type RecapRuntime,
} from "./session-recap-runtime.js";
import type {
  ActorStreamingSink,
  LiveSlowStreamController,
  SlowStreamController,
} from "./streaming-sink.js";
import {
  safeEmitBoundary,
  stripDanglingStopPrefix,
  stripStopSequence,
} from "./streaming-sink.js";
import {
  buildSupervisorPrompt,
  formatSupervisorOutDump,
  isTriggerRelatedFinding,
  judgeMissingDispatch,
  parseSupervisorVerdict,
  recheckTrigger,
  sessionMarkerReceipts,
} from "./supervisor.js";
import {
  BRANCH_OPEN_TAG,
  buildSupervisorVetoHint,
  FINAL_RETRY_BODY_SEED,
  FORCED_SPEECH_OPEN_TAG,
  formatSelfCorrectionText,
  STOP_SPEECH_CLOSE,
  STOP_THOUGHT_CLOSE,
} from "./thought-hint.js";

export interface ActorTurnDeps {
  readonly provider: CompletionProviderAdapter;
  readonly model: string;
  /** Static Herta prefix, structured form. See `StaticHertaPrefix` in
   *  `actor-prompt.ts`. Built once at startup via
   *  `buildStaticHertaPrefix`; passed through the driver to the actor
   *  unchanged. */
  readonly staticPrefix: StaticHertaPrefix;
  /** Shared bus — backend events flow through here for projection. */
  readonly bus: EventBus<AgentEvent>;
  /** Factory that creates a fresh CodingAgentRuntime per `@板砖` invocation. */
  readonly runtimeFactory: () => CodingAgentRuntime;
  /** Outer abort signal; passed through to provider and backend. */
  readonly signal?: AbortSignal;
  /**
   * Attachment blocks the 开拓者 sent WITH this message (ADR 0048 §4) —
   * appended immediately after the user block, inside the turn's span, so the
   * picture and the words arrive as one episode and a rewind takes both.
   *
   * Already sanitized by their producer (`ingestAttachment` /
   * `captionStoredImage`), like every other system block: the serializer does
   * not sanitize at read, so construction is the only gate.
   */
  readonly userAttachments?: readonly SystemBlock[];
  /** Max speech iterations before the loop terminates defensively. Default 5. */
  readonly maxIterations?: number;
  /**
   * Optional streaming sink (Slice 9). When provided, the actor:
   *   - calls sink.flushBlocks(record) at the start of each iteration
   *     (renders side-effect blocks from prior iterations);
   *   - calls sink.beginHertaStream(surface) once per block stream;
   *   - emits text-delta chunks via sink.streamHertaToken AS THEY ARRIVE,
   *     respecting safeEmitBoundary so partial stop sequences never reach
   *     stdout (thought surface: no-op in the sink implementation);
   *   - calls sink.endHertaStream() exactly once per Herta block stream
   *     (primary OR beat).
   *
   * When absent, behavior is identical to pre-Slice 9: buffers tokens
   * internally and commits an atomic herta block on `finish`.
   */
  readonly sink?: ActorStreamingSink;
  /**
   * Optional: fires ONCE per turn, at the start of the FIRST non-empty SPEECH
   * block's stream, with that block's leading text. Lets the caller play a
   * "particle" voice cue synced to the first character. Never fires for
   * thoughts, in-turn beats, the supervisor veto-retry replay, or later speech
   * blocks of the same turn (a per-turn latch). The driver omits it for
   * regenerate. See SPEC 2026-06-23 particle-voice.
   */
  readonly onPrimarySpeechStart?: (leadingText: string) => void;
  /**
   * Optional: fires at most ONCE PER TURN (per-turn latch), on the first
   * supervisor REJECTION of a candidate speech (verdict `block`), the instant
   * the rejection is known — before the retract. Note the supervisor itself
   * can veto more than once per turn (every supervised speech iteration is
   * checked, including post-@板砖 commentary); only the CLIP is latched.
   * Lets the caller play a "veto" voice clip (Herta catching herself). Fires
   * only on a real candidate rejection, never on the trigger re-pass recheck,
   * an OK verdict, or an unsupervised turn. The driver omits it for regenerate.
   * See SPEC 2026-06-23 veto-voice.
   */
  readonly onSupervisorVeto?: () => void;
  /**
   * Optional prompt-dump callback for debugging. Fires once per
   * `streamCompletion` call (both primary block streams and in-turn beat
   * streams), receiving a label identifying the call site:
   *   - "primary"     — main loop iteration prompt (request)
   *   - "primary-out" — same call: prompt + model's full completion
   *   - "beat"        — in-turn beat prompt fired during `@板砖` execution
   *   - "beat-out"    — beat prompt + model's full completion
   *   - "phase2"      — two-phase body prompt (request)
   *   - "phase2-out"  — phase2 prompt + model's full completion
   *   - "state"       — resolved mood state name (e.g. "默认"), one per turn
   *   - "state-out"   — router prompt + "---" + raw model output, dumped
   *                     once per turn before the resolved-state dump
   *   - "supervisor"     — supervisor prompt (system + "---评审消息---" +
   *                        user message). Fired BEFORE the provider
   *                        call begins, so the request side is captured
   *                        even when the response side fails.
   *   - "supervisor-out"  — supervisor prompt + "\n\n---\n\n" + raw
   *                        model output. Fires after the supervisor
   *                        call completes. On supervisor throw, the
   *                        output portion is the synthetic literal
   *                        `[supervisor failed: <error message>]`.
   *
   * The `prompt` argument is the literal bytes sent to DeepSeek's
   * completion endpoint (or, for *-out labels, prompt + completion).
   * Wired by main.ts when `HERTA_DUMP_PROMPTS` is truthy;
   * written to `<sessionId>.prompts/turn-NNN-<label>.txt`.
   */
  readonly onPrompt?: (
    label:
      | "primary"
      | "primary-out"
      | "beat"
      | "beat-out"
      | "phase2"
      | "phase2-out"
      | "state"
      | "state-out"
      | "supervisor"
      | "supervisor-out"
      | "supervisor-retry"
      | "supervisor-retry-out",
    prompt: string,
  ) => void;
  /**
   * Optional intent router state (Slice 13). When provided, the actor
   * runs in two-phase mood-routing mode: every iteration always thinks
   * first (（我 想）), then the soft guard forces speech on the next
   * iteration. When absent, the actor runs the Slice 10 single-phase
   * path.
   *
   * As of the meta-think attachment refactor, two-phase mode is no
   * longer gated on corpus presence — corpus content is the driver's
   * concern via `attachedMetaThink`. Two-phase + no attachment is a
   * valid configuration: think-then-speak rhythm without specific
   * mood guidance on a given turn.
   */
  readonly intentState?: MoodState;
  /**
   * Optional meta-think attachment (Slice 13 sticky-positioned refactor).
   * Owned and managed by `V2ActorDriver`. When provided, the actor
   * splices the appropriate (pre_think or pre_speak) text into the
   * serialized record at the attachment's surface-specific splice
   * index before appending the open tag. The text is bare preamble
   * (no enclosing heading markers). When absent, no preamble is
   * emitted this turn — the model relies on prior turns' outputs
   * (which are in the serialized record) to maintain Herta's voice.
   *
   * The driver creates a new attachment when the routed state changes
   * or when the same-state attachment has gone stale (per
   * `META_THINK_REFRESH_INTERVAL` in `V2ActorDriver`). Same-state
   * non-refresh turns keep the existing attachment in place; the model
   * sees the meta-think at its original position earlier in the record.
   *
   * See `AttachedMetaThink` JSDoc for the full lifecycle contract.
   */
  readonly attachedMetaThink?: AttachedMetaThink;
  /**
   * Optional supervisor chat-mode provider (typically the same instance
   * as the router, or another `deepseekProvider({thinking: "high"})`
   * adapter). When set together with a non-empty `supervisorReference`,
   * the actor runs a supervisor check on every non-empty phase-2
   * speech before commit. When either is missing, the supervisor is
   * skipped entirely.
   */
  readonly supervisorProvider?: ProviderAdapter;
  /**
   * Authored supervisor reference content. Loaded once at startup via
   * `loadSupervisorReference`. Empty string disables the supervisor
   * (graceful "no reference authored" path).
   */
  readonly supervisorReference?: string;
  /** Editable actor hints, loaded from `.herta/narrative/hints/*.txt` at
   *  startup. Optional: when absent, resolves to `DEFAULT_ACTOR_HINTS`. */
  readonly hints?: ActorHints;
  /** When set, long-session compaction is active for this turn. Built at the
   *  app bootstrap (router summarizer + persisted cache). Undefined → no compaction. */
  readonly recap?: RecapRuntime;
  /** One-shot: force a recap re-derive this turn (the /compact command). */
  readonly forceCompact?: boolean;
  /**
   * Interaction language of LLM-facing prompt prose (slice 4). Threaded
   * into the supervisor check, the trigger re-pass recheck, and the
   * fallback hint set used when no `hints` dep is provided. Default
   * "zh" — byte-identical to pre-slice-4 prompts. Structural narrative
   * grammar tokens stay CN in both (D2/D7/D8).
   */
  readonly lang?: PromptLang;
  /** Recap precomputed by the driver BEFORE intent-routing, so the recap hint
   *  (recap.compaction start/end) fires at turn-start instead of after the
   *  router LLM call. When provided, the turn uses it as-is and the driver owns
   *  the notify; undefined (e.g. a direct test call) → the turn computes it
   *  inline below (firing the notify itself). */
  readonly precomputedRecap?: PreparedRecap;
}

export interface ActorTurnState {
  record: TerminalRecord;
}

/**
 * Tag the model uses when hallucinating the user's next message —
 * if the close tag for Herta's own surface (`（/我 说）` / `（/我 想）`)
 * gets skipped, the model often rolls straight into emitting
 * `（开拓者 说）` followed by a fabricated user turn. Stopping on
 * the opening of this tag keeps the runaway content out of the
 * record and out of the prompt for the next turn.
 *
 * Defensive: Herta never writes this string in regular speech
 * (full-width parens + space + open tag is a corpus envelope, not
 * natural prose), so adding it as a stop sequence has zero false-
 * positive risk on valid runs.
 */
const STOP_OPENER_USER = "（开拓者 说）";

/**
 * Stop sequences passed to the LLM provider. The two surface close
 * tags terminate Herta's own surface as expected; `（开拓者 说）`
 * catches the runaway case where the model skips its own close tag
 * and starts emitting the user's next-turn envelope.
 *
 * History note: an earlier revision also watched mid-stream for
 * inline `read_file("…")` / `list_files("…")` calls and aborted the
 * stream client-side via a linked `AbortController`. Inline tools
 * were removed entirely in the 2026-05-23 sweep because the model
 * occasionally hallucinated calls against non-existent paths during
 * casual conversation. File reads / directory listings are now
 * delegated to the backend via `@板砖`.
 */
const STOP_SEQS = [
  STOP_SPEECH_CLOSE,
  STOP_THOUGHT_CLOSE,
  STOP_OPENER_USER,
] as const;

/** Stray duplicate open tags the model sometimes re-emits mid-body. The
 *  commit path removes them (`stripStrayOpenTags`); slice 4 removes them
 *  from the LIVE stream too, so what types on screen equals what commits. */
const STRAY_OPEN_TAGS = ["（我 说）", "（我 想）"] as const;

/** Emit-boundary hold set for the live stream (slice 4): stop sequences PLUS
 *  the stray open tags, so a tag split across provider chunks is held until
 *  resolved and `stripStrayFromChunk` only ever sees complete tags. Used for
 *  the emit boundary ONLY — end-of-stream cleaning keeps STOP_SEQS (a
 *  dangling partial `（我` at stream end is committed verbatim, and streams
 *  verbatim via the final tail flush: still equal). */
const LIVE_EMIT_HOLD_SEQS = [...STOP_SEQS, ...STRAY_OPEN_TAGS] as const;

/** Chunk-local half of `stripStrayOpenTags` for the live stream: drops
 *  complete stray tags, no trim (the stream's own leading-skip/trailing-hold
 *  owns whitespace). Chunk-local equals whole-string because
 *  `LIVE_EMIT_HOLD_SEQS` guarantees a tag never spans emitted chunks. */
function stripStrayFromChunk(chunk: string, surface: Surface): string {
  if (surface === "thought") return chunk.replaceAll("（我 想）", "");
  return chunk.replaceAll("（我 说）", "").replaceAll("（我 想）", "");
}

/**
 * Temperature ladder for the empty-speech retry path. The first
 * (non-retry) attempt uses the provider/model's baked-in default
 * (DeepSeek's chat default is 1.3 per their public parameter-settings
 * guide). When that attempt returns an empty body, successive retries
 * bump the temperature to break the model out of the deterministic
 * empty-output trap: it's emitting `（/我 说）` at position 0 because
 * the preceding thought + meta-think context led it to assign very
 * high probability mass to the close tag. Sampling at a higher
 * temperature spreads that mass and gives the model a chance to write
 * actual content first.
 *
 * Anchor: the provider's default temperature is 1.0 (DeepSeek
 * completion default). Gentle +0.1 bumps per retry keep the sampler
 * within a narrow band around that anchor. Bigger jumps (revision
 * history had 1.5 / 1.7 / 1.8) caused the retry's content to drift
 * in tone away from the rest of the turn — a high-temperature reply
 * mid-turn reads as a different speaker than the surrounding speech.
 * The +0.1 ladder gives the sampler just enough room to escape the
 * close-tag local minimum without also blowing the voice apart.
 *   1.0   ← attempt 1 (provider default, no override)
 *   1.1   ← retry 1
 *   1.2   ← retry 2
 *   1.3   ← retry 3
 *
 * Length matters: max number of retries is `EMPTY_SPEECH_RETRY_TEMPERATURES.length`.
 * After that many failures the actor terminates the turn quietly
 * (returning the partial record), same as the pre-2026-05-23 behavior
 * but reached only after exhausting the ladder.
 */
const EMPTY_SPEECH_RETRY_TEMPERATURES = [1.1, 1.2, 1.3] as const;

/** Leading speech code points buffered before the live path fires the particle
 *  voice. matchLeadingParticle needs at most the longest catalog token (2 cp)
 *  plus one following char to confirm the delimiter, so 3 is sufficient and the
 *  cue lands while the particle is on screen (SPEC particle-voice 2026-06-23). */
const PARTICLE_LEAD_LOOKAHEAD = 3;

/** Wall-clock deadline on the supervisor call. Fail-soft covers THROWS, not
 *  hangs: a supervisor stream that stalls (connection up, nothing emitted)
 *  leaves the verdict gate closed and the paced stream frozen in its hold
 *  forever. The supervisor runs in THINKING mode, so an output-token cap is
 *  not viable (it would truncate reasoning and garble the verdict) — a
 *  generous deadline is the hang protection instead. Reaching it fail-softs
 *  to OK, exactly like a thrown provider error. */
const SUPERVISOR_DEADLINE_MS = 60_000;

/**
 * Per-turn dispatch budget (chained dispatch, 2026-07-10 — supersedes the
 * one-bridge-per-turn cap). Herta's post-run synthesis speech may carry a
 * follow-up `@板砖` that dispatches AGAIN within the same user turn — real
 * multi-step delegation ("跑完测试有一个挂了——@板砖 修掉"). The budget bounds
 * a self-exciting chain; a token beyond it is neutralized at commit exactly
 * like the old cap. Each dispatch also consumes a speech iteration, so
 * `maxIterations` (default 5) is a second independent bound. The user's
 * pre-empt dispatch counts against the budget. Beats NEVER dispatch
 * regardless (trigger-neutralized in makeFireBeat).
 */
export const MAX_DISPATCHES_PER_TURN = 3;

/**
 * Output-token cap on the PRIMARY actor completions (slice 3). A runaway
 * generation (no close tag, stop sequences never matched) used to stream
 * until the provider's own limit, locking the turn for its whole duration.
 * Sized far above the longest legitimate （我 想）/（我 说） block (a few
 * hundred CJK chars ≈ a few hundred tokens) so real speech is never
 * clipped. Deliberate asymmetry: the SUPERVISOR stays UNCAPPED — it runs in
 * thinking mode, where a token cap truncates reasoning and garbles the
 * verdict; its hang protection is SUPERVISOR_DEADLINE_MS instead (standing
 * user constraint — do not add a cap there).
 */
const PRIMARY_COMPLETION_MAX_TOKENS = 2048;

type Surface = "speech" | "thought";

/**
 * Thrown when the turn's signal aborts at an iteration boundary — typically
 * an interrupt landing during (or right after) a @板砖 bridge run. Carries
 * the ACCUMULATED record so the driver can adopt the blocks the user already
 * saw (backend projections, beats, the done-marker) instead of discarding
 * the turn wholesale, while the turn still surfaces as failed/cancelled to
 * the session layer (interrupt semantics unchanged). `name` is "AbortError"
 * so generic isAbortError classification treats it as a cancellation.
 */
export class ActorTurnAbortedError extends Error {
  constructor(readonly partialRecord: TerminalRecord) {
    super("turn aborted");
    this.name = "AbortError";
  }
}

/**
 * Index of the FIRST complete stop marker in `buffered`, or `buffered.length`
 * when none is present. Fence-fuzz finding (2026-07-09): a provider that
 * fails to honor its stop sequences can stream text PAST a complete
 * `（/我 说）` / `（/我 想）` / `（开拓者 说）` — the commit path always
 * truncated at a marker, but the LIVE path streamed the marker plus the
 * runaway tail to the screen (streamed != committed, envelope text visible).
 * Both paths now cut at this index: it is exactly where a stop-honoring
 * provider would have ended the stream, so on well-behaved providers this is
 * a no-op.
 */
function firstStopIndex(buffered: string, stops: readonly string[]): number {
  let min = buffered.length;
  for (const stop of stops) {
    const i = buffered.indexOf(stop);
    if (i >= 0 && i < min) min = i;
  }
  return min;
}

/** Strip stray duplicate open tags the model sometimes re-emits mid-body
 *  (e.g. `[s1] （我 说） [s2]`) so the literal tag never leaks into the
 *  committed block or future prompts. Surface-aware: thought text strips only
 *  `（我 想）`; speech strips both (defensive cross-surface wander). Applied to
 *  the first pass AND every retry reassignment — the veto retry used to skip
 *  it, so a retry re-emitting the tag streamed it to the user verbatim. */
function stripStrayOpenTags(text: string, surface: Surface): string {
  if (surface === "thought") {
    return text.replaceAll("（我 想）", "").trim();
  }
  return text.replaceAll("（我 说）", "").replaceAll("（我 想）", "").trim();
}

/**
 * Route a turn interrupt into a POST-VERDICT paced drain (slice 3). The
 * reveal runs on the sink's own setTimeout ticks, so the loop-boundary
 * `signal.aborted` check can never stop it — a stop click during a long
 * paced drain used to lock the app until the drain finished (minutes for a
 * long body). Arm this immediately before `await controller.fastForward()`
 * and disarm right after: on abort, `flushRemainder` lands the remaining
 * tail in ONE delta (fast-forward, never truncate — the flushed text equals
 * the text the turn commits) and resolves the drain's `done`, unblocking
 * the await. Scoped to post-verdict drains ONLY: an abort while the verdict
 * is pending takes the interrupt-during-supervisor cancel path instead, so
 * an unapproved candidate never flashes fully on screen.
 */
function armAbortFlush(
  signal: AbortSignal,
  controller: SlowStreamController | undefined,
): () => void {
  if (controller?.flushRemainder === undefined) return () => {};
  const onAbort = (): void => controller.flushRemainder?.();
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/** Best-effort terminal call for a live/slow controller that is being
 *  abandoned on a THROW path (interrupt, provider error): the sink contract
 *  requires exactly one terminal method or its output stream stays parked in
 *  the verdict hold. The contractual done-rejection is swallowed (it is the
 *  expected outcome of cancelling); sink teardown errors are best-effort. */
async function abandonController(
  controller:
    | { done: Promise<void>; cancelAndBackspace(): Promise<void> }
    | undefined,
): Promise<void> {
  if (controller === undefined) return;
  controller.done.catch(() => undefined);
  try {
    await controller.cancelAndBackspace();
  } catch {
    // Sink teardown is best-effort on an already-failing path.
  }
}

function resolveHints(deps: ActorTurnDeps): ActorHints {
  return deps.hints ?? defaultActorHintsFor(deps.lang ?? "zh");
}

// ── Supervisor-side judgment calls ──────────────────────────────────────────
//
// Three model calls gate a candidate speech before it commits: the supervisor
// verdict, the trigger re-pass (judgeTriggerAndNeutralize), and the
// missing-dispatch judge (ADR 0036). Until 2026-08-19 each carried its own
// copy of the same discipline inline in the main loop — a wall-clock deadline
// (SUPERVISOR_DEADLINE_MS) linked to the turn signal, the ephemeral
// `supervisor.check` start/end bracket on the bus, cleanup in `finally` — so
// a fix to one (the deadline, bug 4's hint bracket) had to be made three
// times. `withJudgmentWindow` is that discipline once; the three judges sit
// on top of it with their own fail-soft rules.

/**
 * Run one judgment call under the shared discipline. The call gets its OWN
 * abort signal — the deadline (SUPERVISOR_DEADLINE_MS; fail-soft covers
 * THROWS, not hangs — a stalled stream would park the turn) and the turn's
 * interrupt both abort the CALL, never the turn. The `supervisor.check`
 * start/end bracket is the renderer's judgment-window hint (bug 4,
 * 2026-07-09: the paced reveal holds its tail while a verdict is pending, so
 * a slow judge read as a frozen cursor); `end` fires in the finally, covering
 * OK / veto / fail-soft / deadline alike. Whatever `fn` throws propagates —
 * each judge decides fail-soft vs interrupt itself, and can read
 * `judgeSignal.aborted` to tell a deadline from a provider error.
 */
async function withJudgmentWindow<T>(
  bus: EventBus<AgentEvent>,
  turnSignal: AbortSignal,
  fn: (judgeSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const judgeAbort = new AbortController();
  const deadlineTimer = setTimeout(
    () => judgeAbort.abort(),
    SUPERVISOR_DEADLINE_MS,
  );
  const onTurnAbort = (): void => judgeAbort.abort();
  if (turnSignal.aborted) judgeAbort.abort();
  else turnSignal.addEventListener("abort", onTurnAbort, { once: true });
  bus.publish({ type: "supervisor.check", layer: "actor", phase: "start" });
  try {
    return await fn(judgeAbort.signal);
  } finally {
    clearTimeout(deadlineTimer);
    turnSignal.removeEventListener("abort", onTurnAbort);
    bus.publish({ type: "supervisor.check", layer: "actor", phase: "end" });
  }
}

interface SupervisorVerdict {
  verdict: "ok" | "block";
  reason?: string;
  blockFindings: ReadonlyArray<{ category: string; detail: string }>;
}

/**
 * Stream the supervisor over the built frame and parse its verdict.
 * Fail-soft (a provider error OR the deadline firing): log the synthetic dump
 * body, return OK, so the candidate commits as-is. A USER INTERRUPT is not a
 * supervisor failure: fail-softing it committed the candidate as if approved
 * (the speech persisted, a @板砖 in it dispatched on a dead signal), so an
 * interrupt tears the visible slow-stream down (exactly-one-terminal-call
 * contract) and aborts record-carrying (audit 2026-07-13 T2.5 — a raw
 * rethrow reverted the driver to its pre-turn record, losing blocks a prior
 * @板砖 dispatch already put on screen and disk, D7).
 */
async function runSupervisorVerdict(opts: {
  deps: ActorTurnDeps;
  supervisorProvider: ProviderAdapter;
  supervisorPrompt: string;
  supervisorFrame: Parameters<ProviderAdapter["streamChat"]>[0];
  signal: AbortSignal;
  record: TerminalRecord;
  /** The paced controller rendering the candidate (torn down on interrupt). */
  controller: SlowStreamController | undefined;
}): Promise<SupervisorVerdict> {
  const { deps, signal } = opts;
  return withJudgmentWindow(deps.bus, signal, async (judgeSignal) => {
    try {
      let buffered = "";
      let reasoning = "";
      for await (const ev of opts.supervisorProvider.streamChat(
        opts.supervisorFrame,
        judgeSignal,
      )) {
        if (ev.type === "text-delta") {
          buffered += ev.text;
        } else if (ev.type === "reasoning-delta") {
          // Captured for diagnostic dumping only. The verdict is decided
          // from the final text-delta line; reasoning lets operators audit
          // whether the stated rationale matches.
          reasoning += ev.text;
        } else if (ev.type === "finish") {
          break;
        }
      }
      deps.onPrompt?.(
        "supervisor-out",
        formatSupervisorOutDump({
          prompt: opts.supervisorPrompt,
          reasoning,
          rawOutput: buffered,
        }),
      );
      return parseSupervisorVerdict(buffered);
    } catch (err) {
      if (signal.aborted) {
        await abandonController(opts.controller);
        throw new ActorTurnAbortedError(opts.record);
      }
      const timedOut = judgeSignal.aborted;
      const errorMsg = err instanceof Error ? err.message : String(err);
      deps.onPrompt?.(
        "supervisor-out",
        formatSupervisorOutDump({
          prompt: opts.supervisorPrompt,
          reasoning: "",
          rawOutput: timedOut
            ? `[supervisor deadline (${SUPERVISOR_DEADLINE_MS}ms): ${errorMsg}]`
            : `[supervisor failed: ${errorMsg}]`,
        }),
      );
      return { verdict: "ok", blockFindings: [] };
    }
  });
}

/**
 * Run the focused trigger judge over a candidate that carries a
 * dispatch-effective `@板砖`, and neutralize the token (`@板砖` → quoted
 * `` `@板砖` ``, visible but inert — 2026-08-17; the stripped `板砖` form only
 * as the malformed-backtick fallback) when it says this is not a dispatch.
 * Returns the text to commit plus any reason to record.
 *
 * Shared by BOTH passes (first pass and veto re-speak). It was the re-pass's
 * alone until a live miss showed why the first pass needs it too (user
 * 2026-07-29): Herta wrote "没有 @板砖，没有场外求助" — a rhetorical negation —
 * the supervisor passed it, and the literal token woke the coprocessor for
 * 24s of nothing. §8 covers that class with near-identical examples; the
 * trouble is that §8 is one rule inside a very long prompt. Measured on the
 * shipped flash-high config (scripts/supervisor-lab.mjs, 3 samples): the full
 * supervisor blocks that sentence 2/3, this judge 3/3 — and does it in ~2.1s
 * against the supervisor's ~10.5s, because its whole prompt IS the question.
 * Both agree on the controls (a bare 板砖 mention, a real in-scope dispatch),
 * so the second look costs no false blocks.
 *
 * Gate order matters: this runs only after the supervisor has PASSED the
 * speech, so it never competes with a veto, and only when a token would
 * really fire (`wouldDispatch`) — no round-trip for a backticked `@板砖`, or
 * one already past the per-turn dispatch budget (commit neutralizes those
 * regardless).
 *
 * Fail-soft on throws, hard-fail on interrupt: an aborted turn must not
 * commit-and-dispatch. The interrupt escapes as the thrown error; the
 * caller owns the controller teardown and the record-carrying abort.
 */
async function judgeTriggerAndNeutralize(opts: {
  deps: ActorTurnDeps;
  supervisorProvider: ProviderAdapter;
  signal: AbortSignal;
  record: TerminalRecord;
  candidate: string;
  thought: string | undefined;
}): Promise<{ text: string; reason?: string }> {
  const { deps, signal, candidate } = opts;
  let recheckPrompt = "";
  return withJudgmentWindow(deps.bus, signal, async (judgeSignal) => {
    try {
      const recheck = await recheckTrigger({
        provider: opts.supervisorProvider,
        recentRecord: lastNTurnsForSupervisor(opts.record, 8),
        ...(opts.thought !== undefined
          ? { currentTurnThought: opts.thought }
          : {}),
        candidateSpeech: candidate,
        lang: deps.lang ?? "zh",
        signal: judgeSignal,
        onPromptBuilt: (p) => {
          recheckPrompt = p;
          // Shares the re-pass's dump channel: it is the same judge, and its
          // prompt names itself in the first line, so a trace reader can
          // tell the two passes apart by content.
          deps.onPrompt?.("supervisor-retry", p);
        },
      });
      deps.onPrompt?.(
        "supervisor-retry-out",
        formatSupervisorOutDump({
          prompt: recheck.prompt,
          reasoning: recheck.reasoning,
          rawOutput: recheck.rawOutput,
        }),
      );
      if (
        recheck.verdict === "block" &&
        recheck.blockFindings.some(isTriggerRelatedFinding)
      ) {
        const triggerReasons = recheck.blockFindings
          .filter(isTriggerRelatedFinding)
          .map((f) => f.detail)
          .join("；");
        // The gate reads the SANITIZED projection (T2.5), but neutralize
        // edits the RAW text — on a zero-width-broken token the raw parse
        // sees no live trigger, neutralize no-ops, and the commit's own
        // sanitize then reassembles the very token the judge just blocked,
        // so it dispatched anyway (review 2026-07-31). When the raw
        // neutralize didn't take, neutralize the sanitized projection and
        // commit THAT — the commit path re-sanitizes idempotently.
        let neutralized = neutralizeBanzhuanTrigger(candidate);
        const projected = sanitizeActorText(
          stripStrayOpenTags(neutralized, "speech"),
          { role: "speech" },
        );
        if (parseHertaBlock(projected).hasBanzhuanTrigger) {
          neutralized = neutralizeBanzhuanTrigger(projected);
        }
        return {
          text: neutralized,
          ...(triggerReasons.length > 0 ? { reason: triggerReasons } : {}),
        };
      }
      return { text: candidate };
    } catch (err) {
      if (signal.aborted) throw err;
      const errorMsg = err instanceof Error ? err.message : String(err);
      deps.onPrompt?.(
        "supervisor-retry-out",
        formatSupervisorOutDump({
          prompt: recheckPrompt,
          reasoning: "",
          rawOutput: `[trigger re-pass failed: ${errorMsg}]`,
        }),
      );
      return { text: candidate };
    }
  });
}

/**
 * Missing-dispatch judge (ADR 0036) — the trigger gate's mirror. A speech the
 * supervisor PASSED can still PROMISE the 开拓者 present 板砖 work while
 * dispatching nothing ("先去翻你代码……一会儿一起看结果" — the persona E2E's
 * fabrication cascade began exactly there: the user came back to collect on
 * the promise, and the smoothest exit was an invented receipt). §8 step 3
 * covers the shape but sits buried in the long prompt (~1/3 on this class,
 * the same reliability gap the trigger recheck was built for). The caller
 * gates it tightly (supervisor passed, the sanitized projection MENTIONS 板砖,
 * no live trigger); a BLOCK is returned as a verdict for the caller to fold
 * into the supervisor veto so the rethink-respeak machinery resolves it — she
 * really dispatches or drops the promise; the harness never injects an `@`
 * itself. Fail-soft: an unavailable judge must not block the commit (returns
 * null). Interrupt: tears the controller down and aborts record-carrying.
 */
async function runMissingDispatchJudge(opts: {
  deps: ActorTurnDeps;
  supervisorProvider: ProviderAdapter;
  signal: AbortSignal;
  record: TerminalRecord;
  candidate: string;
  thought: string | undefined;
  controller: SlowStreamController | undefined;
}): Promise<SupervisorVerdict | null> {
  const { deps, signal } = opts;
  let mdPrompt = "";
  return withJudgmentWindow(deps.bus, signal, async (judgeSignal) => {
    try {
      const md = await judgeMissingDispatch({
        provider: opts.supervisorProvider,
        recentRecord: lastNTurnsForSupervisor(opts.record, 8),
        ...(opts.thought !== undefined
          ? { currentTurnThought: opts.thought }
          : {}),
        candidateSpeech: opts.candidate,
        lang: deps.lang ?? "zh",
        signal: judgeSignal,
        onPromptBuilt: (p) => {
          mdPrompt = p;
          // Shares the re-pass's dump channel (same rationale as the trigger
          // judge): the prompt names itself in its first line, so a trace
          // reader tells the judges apart by content.
          deps.onPrompt?.("supervisor-retry", p);
        },
      });
      deps.onPrompt?.(
        "supervisor-retry-out",
        formatSupervisorOutDump({
          prompt: md.prompt,
          reasoning: md.reasoning,
          rawOutput: md.rawOutput,
        }),
      );
      if (md.verdict === "block" && md.blockFindings.length > 0) {
        return {
          verdict: "block",
          ...(md.reason !== undefined ? { reason: md.reason } : {}),
          blockFindings: md.blockFindings,
        };
      }
      return null;
    } catch (err) {
      if (signal.aborted) {
        await abandonController(opts.controller);
        throw new ActorTurnAbortedError(opts.record);
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      deps.onPrompt?.(
        "supervisor-retry-out",
        formatSupervisorOutDump({
          prompt: mdPrompt,
          reasoning: "",
          rawOutput: `[missing-dispatch judge failed: ${errorMsg}]`,
        }),
      );
      return null;
    }
  });
}

/** Would this candidate's `@板砖` actually fire? Backticked tokens cannot,
 *  and one past the per-turn budget is neutralized at commit regardless —
 *  neither earns a judge round-trip. Reads the SANITIZED projection the
 *  commit path parses (audit 2026-07-13 T2.5), so the gate and the commit
 *  never disagree about which token is live. */
function wouldDispatch(candidate: string, dispatchCount: number): boolean {
  return (
    dispatchCount < MAX_DISPATCHES_PER_TURN &&
    parseHertaBlock(
      sanitizeActorText(stripStrayOpenTags(candidate, "speech"), {
        role: "speech",
      }),
    ).hasBanzhuanTrigger
  );
}

/**
 * Supervisor VETO recovery: the veto voice latch, the retract of the visibly
 * streamed candidate, the two-stage rethink → respeak (2026-07-18), the
 * live-feed re-speak with its retract floor, the empty-respeak ladder, the
 * bounded trigger re-pass, and the re-speak's render finalize. Lifted out of
 * the main loop verbatim on 2026-08-19 (ADR 0041): it is one self-contained
 * arc over the iteration's mutable state, which it now takes in and returns
 * explicitly instead of closing over. Every interrupt path throws the
 * record-carrying `ActorTurnAbortedError` (audit 2026-07-13 T2.5) exactly
 * where it did inline — with `record` as of that moment (a committed
 * rethink thought included).
 */
async function recoverFromVeto(ctx: {
  deps: ActorTurnDeps;
  signal: AbortSignal;
  record: TerminalRecord;
  priorTurnLength: number;
  recap: PreparedRecap["recap"];
  recapBoundaryIndex: PreparedRecap["recapBoundaryIndex"];
  streamResult: { surface: Surface; text: string };
  supervisorVerdict: SupervisorVerdict;
  slowStreamController: SlowStreamController | undefined;
  currentTurnThought: string | undefined;
  supervisorProvider: ProviderAdapter;
  dispatchCount: number;
  vetoSignalled: boolean;
  supervisorVetoReasonForRecord: string | undefined;
}): Promise<{
  record: TerminalRecord;
  streamResult: { surface: Surface; text: string };
  /** Whether the committed speech text has yet to reach the sink (the
   *  caller's unified replay renders it iff still true). */
  speechSinkPending: boolean;
  vetoSignalled: boolean;
  supervisorVetoReasonForRecord: string | undefined;
}> {
  const {
    deps,
    signal,
    priorTurnLength,
    recap,
    recapBoundaryIndex,
    supervisorVerdict,
    slowStreamController,
    currentTurnThought,
    supervisorProvider,
    dispatchCount,
  } = ctx;
  let { record, streamResult, vetoSignalled, supervisorVetoReasonForRecord } =
    ctx;
  let speechSinkPending = false;
  // Veto voice (SPEC 2026-06-23): fire the instant the rejection is known,
  // BEFORE the retract — the "等等…" clip leads, then the text retracts and
  // rewrites. Latched to the FIRST veto of the turn: each supervised
  // speech iteration can veto (a multi-iteration @板砖 turn supervises
  // its commentary too), but the clip must not replay per veto.
  if (!vetoSignalled) {
    vetoSignalled = true;
    deps.onSupervisorVeto?.();
  }
  // Bug 2 (2026-06-27): the divergence the GUI erase will halt at is measured
  // against the text the user actually saw (the trimmed candidate that
  // slowStreamSpeech streamed). Capture it before the retry reassigns
  // streamResult. Stray-stripped (slice 4) to match the live stream,
  // which drops stray tags as they arrive.
  const vetoedShown = stripStrayOpenTags(streamResult.text, "speech");
  // Hand the visibly-streamed speech's retraction to the sink before
  // re-prompting. Sinks MAY block until their retract animation
  // completes (the CLI does); the GUI sink returns immediately and
  // morphs the rejected text into the retry as it streams.
  if (slowStreamController !== undefined) {
    await slowStreamController.cancelAndBackspace();
  }
  // Two-stage veto recovery, stage 1 (rethink-respeak, 2026-07-18):
  // before re-speaking, generate a FRESH （我 想） that digests the
  // veto reason and commit it to the record like any thought — the
  // respeak then sees it. Lab-measured (scripts/respeak-lab.mjs):
  // the single-stage reason-bearing respeak collapses on non-coding
  // vetoes (record vocabulary bleeding into e.g. a grief reply)
  // while the rethink flow lands ~6/9 good vs ~2.5/9. The thought
  // streams through the sink normally (visible re-think — the
  // thought indicator is the UX for the pause). Fail-soft: an
  // empty or failed rethink falls back to the single-stage
  // reason-bearing respeak below, so the veto path never gets
  // WORSE than the pre-rethink behavior.
  let rethinkCommitted = false;
  if (supervisorVerdict.reason !== undefined) {
    try {
      const rethinkResult = await runPhaseTwo({
        deps,
        record,
        priorTurnLength,
        surface: "thought",
        signal,
        supervisorRethinkReason: supervisorVerdict.reason,
        vetoedSpeech: streamResult.text,
        recap,
        recapBoundaryIndex,
      });
      const rethinkText = stripStrayOpenTags(
        rethinkResult.text,
        "thought",
      ).trim();
      if (rethinkText.length > 0) {
        // Same commit discipline as the main-loop thought commit:
        // sanitize at construction so disk, prompts, and every
        // projection inherit the safe text.
        record = [
          ...record,
          {
            kind: "herta",
            surface: "thought",
            text: sanitizeActorText(rethinkText, { role: "thought" }),
          },
        ];
        rethinkCommitted = true;
      }
    } catch (err) {
      if (signal.aborted) throw new ActorTurnAbortedError(record);
      // Fail-soft: the rethink is an enhancement, not a gate. Log
      // via the prompt-dump channel and take the single-stage path.
      deps.onPrompt?.(
        "phase2-out",
        `[rethink stage failed: ${err instanceof Error ? err.message : String(err)}]`,
      );
    }
  }
  // Retry phase-2 speech — after a committed rethink, with the slim
  // post-rethink hint (the reason lives in the fresh thought);
  // otherwise with the veto reason interpolated into the format
  // hint. Either way the rejected speech is replayed in the prompt
  // so the model can see what it's revising. Retry result commits
  // unconditionally — no second supervisor pass, no infinite loop.
  //
  // Live-feed the re-speak when the sink supports it: stream it to the
  // morph as it generates (first char at TTFT) instead of generating
  // silently and replaying afterward. Emit the retract floor the moment
  // the streamed re-speak diverges from the vetoed text. Sinks without
  // slowStreamSpeechLive keep the silent depsWithoutSink + replay path.
  // The raw re-speak streams as-is; a @板砖 the trigger re-pass later
  // neutralizes is corrected at commit (SPEC live-feed-veto-respeak §3/§5).
  const baseRetryOpts: Parameters<typeof runPhaseTwo>[0] = {
    deps,
    record,
    priorTurnLength,
    surface: "speech",
    signal,
    vetoedSpeech: streamResult.text,
    recap,
    recapBoundaryIndex,
  };
  if (rethinkCommitted) {
    // Stage 2 of the rethink flow: the reason already lives in the
    // committed fresh thought — the slim static respeak hint applies.
    baseRetryOpts.isPostRethinkRespeak = true;
  } else if (supervisorVerdict.reason !== undefined) {
    baseRetryOpts.supervisorVetoReason = supervisorVerdict.reason;
  }
  if (supervisorVerdict.reason !== undefined) {
    // Capture for the self-correction block (N8) in BOTH paths. Set
    // even if the retry later turns out empty — the commit-section
    // guard skips emitting the block when there's no speech
    // to anchor it to.
    supervisorVetoReasonForRecord = supervisorVerdict.reason;
  }

  let retryLive: LiveSlowStreamController | undefined;
  let retryFloorEmitted = false;
  if (deps.sink?.slowStreamSpeechLive !== undefined) {
    // Call ATTACHED — the live controller's internals use `this`
    // (this.beginHertaStream, this.bus, this.emitSpeech), so a detached
    // `const f = deps.sink.slowStreamSpeechLive; f()` loses the binding and
    // crashes in the tick. Matches the first-pass call site above.
    const live = deps.sink.slowStreamSpeechLive({});
    retryLive = live;
    let retryAccum = "";
    const onLiveToken = (chunk: string): void => {
      live.pushToken(chunk);
      retryAccum += chunk;
      if (!retryFloorEmitted) {
        // Skip the divergence check while the accumulation ends in an
        // unpaired high surrogate (a provider chunk can split a non-BMP
        // char): the half char would read as a false divergence and
        // latch a one-short floor. The next chunk completes the pair.
        const lastCode = retryAccum.charCodeAt(retryAccum.length - 1);
        if (lastCode >= 0xd800 && lastCode <= 0xdbff) return;
        const cp = commonPrefixLen(vetoedShown, retryAccum);
        // O(n²) over the stream but capped: stops at the first divergence,
        // and speech is short — negligible.
        if (cp < [...retryAccum].length) {
          // A chunk reaching here is past safeEmitBoundary (committed text),
          // so a fired floor implies a non-empty retry — this and the
          // empty-recovery replay floor are mutually exclusive: the floor is
          // emitted exactly once.
          deps.sink?.emitRetractFloor?.(cp);
          retryFloorEmitted = true;
        }
      }
    };
    try {
      streamResult = await runPhaseTwo({ ...baseRetryOpts, onLiveToken });
    } catch (err) {
      // Retry generation threw with the live re-speak controller
      // possibly holding pushed tokens: terminal-call it, then abort
      // record-carrying on interrupt (audit 2026-07-13 T2.5, same
      // D7 reasoning as the first-pass catch above).
      await abandonController(live);
      if (signal.aborted) throw new ActorTurnAbortedError(record);
      throw err;
    }
    if (streamResult.text.trim().length > 0) live.finishInput();
  } else {
    // No live primitive: the raw LLM stream must not hit the sink live.
    // Generate sink-less at full model speed; the FINAL retry text (post
    // recovery ladder, post trigger re-pass — so a neutralized token
    // streams exactly the way it commits) is replayed paced through
    // slowStreamSpeech below.
    const { sink: _retrySink, ...depsWithoutSink } = deps;
    streamResult = await runPhaseTwo({
      ...baseRetryOpts,
      deps: depsWithoutSink,
    });
  }
  // Strip stray open tags from the retry — the first pass is stripped
  // above, but the retry reassigned streamResult past that point, so a
  // retry re-emitting `（我 说）` streamed the literal tag to the user
  // and committed it into every future prompt. The live path settles
  // the corrected text at commit (same accepted-flicker mechanism as
  // the @板砖 neutralization, SPEC live-feed-veto-respeak §5).
  streamResult = {
    surface: streamResult.surface,
    text: stripStrayOpenTags(streamResult.text, streamResult.surface),
  };
  // Nothing has reached the sink yet (non-live), or the live controller
  // holds the stream — the finalize step below (or the one-shot unified
  // replay for sinks without slowStreamSpeech) renders the retry.
  speechSinkPending = true;

  // Empty-veto-retry recovery. The supervisor-veto retry uses
  // `buildSupervisorVetoHint(reason)` which is voice/intent-
  // correction focused; it doesn't address the empty-output
  // failure mode. If the model's veto-retry comes back empty
  // (e.g., it tried to "fix" the rejected speech by closing
  // immediately), fall through to the empty-speech retry
  // ladder — same recovery, rising temperature. Commits the
  // ladder's result unconditionally without a second supervisor
  // pass (per spec §2 "single retry per failure mode" — we've
  // already spent the veto retry; the ladder is the recovery
  // for the NEW failure mode introduced by an empty veto-retry).
  //
  // Defer streaming + render via the unified-replay step below
  // — the live-stream sink path already missed its chance
  // (streamResult was reassigned twice, the cursor isn't sync'd).
  // Slot-only counts as empty here too, and this site is the one that
  // matters most: the veto respeak commits WITHOUT a second supervisor
  // pass, so a degenerate `{需要说的话}` has no other guard. The
  // corrective veto hint is itself instruction-dense — exactly the
  // input that pushes a model toward emitting the slot.
  if (isUnusableBlock(streamResult.text)) {
    // The live re-speak was empty; abandon its controller (it pushed
    // nothing) and render the recovered text via the old replay path.
    retryLive = undefined;
    const vetoRetryCause = retryCause(streamResult.text);
    streamResult = await recoverEmptySpeech({
      ...(vetoRetryCause !== undefined ? { cause: vetoRetryCause } : {}),
      deps,
      record,
      priorTurnLength,
      signal,
      recap,
      recapBoundaryIndex,
    });
    // Same strip discipline as every other reassignment point.
    streamResult = {
      surface: streamResult.surface,
      text: stripStrayOpenTags(streamResult.text, streamResult.surface),
    };
    speechSinkPending = true;
  }

  // Bounded trigger re-pass (2026-06-11 trigger-discipline §3.2).
  // The veto retry commits without re-generation, so if it carries the
  // literal @板砖 token this is its ONLY look. Same judge and same
  // neutralize-on-block as the first pass now runs
  // (judgeTriggerAndNeutralize); the difference is only that here
  // there is no supervisor verdict to defer to.
  if (wouldDispatch(streamResult.text, dispatchCount)) {
    let judged: { text: string; reason?: string };
    try {
      judged = await judgeTriggerAndNeutralize({
        deps,
        supervisorProvider,
        signal,
        record,
        candidate: streamResult.text,
        thought: currentTurnThought,
      });
    } catch (err) {
      // Mirrors the first-pass gate's catch: an escaping throw is the
      // interrupt (the judge fail-softs everything else). The live
      // re-speak controller gets its terminal call first (undefined on
      // the empty-recovery path — abandonController tolerates that),
      // then the abort carries the record (audit 2026-07-13 T2.5, D7).
      // This teardown-then-throw was the OLD re-pass's own contract,
      // lost when 2026-07-29 folded it into the shared judge.
      if (signal.aborted) {
        await abandonController(retryLive);
        throw new ActorTurnAbortedError(record);
      }
      throw err;
    }
    if (judged.text !== streamResult.text) {
      streamResult = { ...streamResult, text: judged.text };
      if (judged.reason !== undefined) {
        supervisorVetoReasonForRecord =
          supervisorVetoReasonForRecord !== undefined
            ? `${supervisorVetoReasonForRecord}；${judged.reason}`
            : judged.reason;
      }
    }
  }

  // Finalize the re-speak render. Live path: the morph already filled from
  // the live deltas as the re-speak generated; emit the floor here only if
  // a strict-extension retry never diverged during streaming, then drain
  // the held tail at base cadence. The commit settles the bubble to
  // retryReplayText (so a trigger-neutralized @板砖 → `@板砖` is corrected
  // here — the accepted two-tick flicker). Non-live / empty-recovery path: emit
  // the floor on the final text and replay it paced, as before.
  const retryReplayText = streamResult.text.trim();
  if (retryLive !== undefined && retryReplayText.length > 0) {
    if (!retryFloorEmitted) {
      deps.sink?.emitRetractFloor?.(
        commonPrefixLen(vetoedShown, retryReplayText),
      );
    }
    // Interruptible drain (slice 3): the retry commits
    // unconditionally, so an abort here flushes rather than cancels.
    const disarm = armAbortFlush(signal, retryLive);
    try {
      await retryLive.fastForward();
    } finally {
      disarm();
    }
    speechSinkPending = false;
  } else {
    deps.sink?.emitRetractFloor?.(
      commonPrefixLen(vetoedShown, retryReplayText),
    );
    if (
      retryReplayText.length > 0 &&
      deps.sink?.slowStreamSpeech !== undefined
    ) {
      const replayCtl = deps.sink.slowStreamSpeech(retryReplayText);
      const disarm = armAbortFlush(signal, replayCtl);
      try {
        await replayCtl.fastForward();
      } finally {
        disarm();
      }
      speechSinkPending = false;
    }
  }
  // Sinks without slowStreamSpeech fall through with
  // speechSinkPending=true → the one-shot unified replay below.
  return {
    record,
    streamResult,
    speechSinkPending,
    vetoSignalled,
    supervisorVetoReasonForRecord,
  };
}

/**
 * Drive a single Herta turn in v0.2 narrative-completion mode. Slice 10
 * adds (a) optional thought blocks via the `（我 想）` branch, (b) a
 * per-call hint that constrains the surface to {思考, 说话}, (c) a soft
 * guard that forces speech after 2 consecutive thoughts, (d) a user-typed
 * `@板砖` pre-empt that fires the bridge before any completion call, and
 * (e) a one-bridge-per-turn cap. See SPEC v0.2 Slice 10 §5.
 */
export async function runActorCompletionTurn(
  state: ActorTurnState,
  userText: string,
  deps: ActorTurnDeps,
): Promise<ActorTurnState> {
  const maxIterations = deps.maxIterations ?? 5;
  const signal = deps.signal ?? new AbortController().signal;

  // Snapshot the pre-turn record length. Thoughts at indices BELOW this
  // boundary are filtered out of every prompt this turn builds — they're
  // prior-turn planning that doesn't help current reasoning. Thoughts at
  // indices >= this boundary are CURRENT-turn thoughts (committed by an
  // earlier iteration of this same call) and stay visible.
  const priorTurnLength = state.record.length;

  // Images the 开拓者 sent WITH this message land immediately after their
  // user block (ADR 0048 §4). Inside the turn's span, so the picture and the
  // words it came with are one episode: Herta reads them together, and a
  // rewind withdraws them together. Empty for every turn without attachments.
  let record: TerminalRecord = [
    ...state.record,
    { kind: "user", text: userText },
    ...(deps.userAttachments ?? []),
  ];

  // Long-session compaction (2026-05-24). Computed EXACTLY ONCE per turn,
  // right after the user block is appended: the recap summarizes history
  // *before* this turn, so any blocks appended later in the turn (thoughts,
  // speech, system/差分协处理器 projections, beats) are always in the verbatim
  // window (index >= recapBoundaryIndex) and never compacted away. Every
  // ActorPrompt the turn builds carries these same once-computed values; the
  // serializer drops blocks below the boundary and renders the recap as a
  // `### 记录：先前` section. When `deps.recap` is undefined, `prepareTurnRecap`
  // returns `{ recapBoundaryIndex: 0 }` (recap undefined) → byte-identical to
  // the no-compaction prompt.
  const { recap, recapBoundaryIndex } =
    deps.precomputedRecap ??
    (await prepareTurnRecap(
      record,
      deps.staticPrefix,
      deps.recap,
      deps.forceCompact === true,
      signal,
      (phase) =>
        deps.bus.publish({ type: "recap.compaction", layer: "actor", phase }),
    ));

  // Dispatch budget (2026-07-10, chained dispatch — supersedes the
  // one-bridge-per-turn cap): Herta's post-run synthesis speech may
  // legitimately carry a follow-up `@板砖` ("测试挂了一个——@板砖 修掉"), so a
  // live token in MAIN-LOOP speech now dispatches again, chaining runs
  // within one user turn. Two bounds keep it deterministic: this hard cap
  // (beyond it the token is neutralized at commit, exactly like the old
  // cap), and `maxIterations` on speech commits. BEATS still never
  // dispatch — every committed beat is trigger-neutralized in makeFireBeat,
  // and the bridge's per-bus latch would refuse a re-entrant run regardless.
  let dispatchCount = 0;

  // -- User-typed @板砖 pre-empt (SPEC §7) ------------------------------
  // Backtick-aware, same scanner as Herta-authored speech (2026-07-04,
  // superseding the 2026-06-11 "deliberately literal" gate): a
  // backticked `@板砖` is quotation on EVERY channel. The GUI composer
  // already renders the backticked form as plain text — no delegation
  // chip (2026-06-16 mention-composer spec) — so dispatching on it
  // made the runtime contradict what the composer told the user.
  // A quoted-only message ("`@板砖` 是什么？") now goes to Herta as a
  // normal turn; she can still delegate herself if it's actually a
  // task. stripBanzhuanTrigger below matches: it removes only bare
  // triggers, so a quoted span stays part of the brief text.
  if (parseHertaBlock(userText).hasBanzhuanTrigger) {
    const brief = stripBanzhuanTrigger(userText).trim();
    if (brief.length > 0) {
      deps.sink?.flushBlocks(record);
      const policy = new BeatPolicy();
      const fireBeat = makeFireBeat(
        deps,
        priorTurnLength,
        recap,
        recapBoundaryIndex,
      );
      record = await invokeBanzhuanBridge(record, [], {
        bus: deps.bus,
        runtimeFactory: deps.runtimeFactory,
        lang: deps.lang,
        signal,
        beatPolicy: policy,
        fireBeat,
        sink: deps.sink,
      });
      dispatchCount += 1;
    }
  }

  // -- Main loop -----------------------------------------------------------
  let speechIterations = 0;
  // Particle voice: fire onPrimarySpeechStart for the FIRST non-empty speech
  // block of the turn only. Latched so later speech blocks, the veto-retry
  // replay, and beats never re-fire. See SPEC 2026-06-23 particle-voice.
  let particleSignalled = false;
  // Per-turn latch for the veto voice clip: the supervisor runs on EVERY
  // supervised speech iteration (post-@板砖 commentary included), so a turn
  // can veto more than once — but the "等等…" clip firing twice in one turn
  // reads as a glitch, not a personality beat. First veto only.
  let vetoSignalled = false;
  let consecutiveThoughts = 0;
  // Tracks consecutive iterations where the phase-2 thought call
  // (plus its inline retry) returned empty content. Used to break out
  // of an empty-thought spin: after one such iteration we force the
  // next iteration into speech so the turn still produces output.
  let consecutiveEmptyThoughtIters = 0;

  while (speechIterations < maxIterations) {
    // Abort at an iteration boundary: an interrupt that landed during (or
    // right after) a @板砖 bridge run must not throw the whole turn away.
    // The projected → 系统 / → 差分协处理器 blocks, beats, and done-marker
    // are already ON SCREEN, and the backend's repo mutations persist — but
    // letting the next provider call throw on the dead signal discarded the
    // accumulated record (the driver keeps its pre-turn copy on a plain
    // throw), so screen, memory, and disk diverged and next turn's prompt
    // carried no trace the backend ever ran (D7/§9). Throw a record-carrying
    // abort instead: the driver adopts the blocks, the session still emits
    // turn.failed (interrupt semantics unchanged).
    if (signal.aborted) throw new ActorTurnAbortedError(record);
    deps.sink?.flushBlocks(record);

    // Slice 13.2: max ONE thought per segment. After a single
    // `（我 想）` commits, the next iteration is forced to speech with
    // pre_speak meta-think — Herta deliberates ONCE, then acts.
    // Was originally `>= 2` (allow two consecutive thoughts) but in
    // practice multi-thought chains read as Herta "stuck in her head".
    // Tightening to 1 makes the rhythm think → speak, never
    // think → think → speak.
    //
    // `consecutiveEmptyThoughtIters >= 1` ALSO forces speech: if the
    // last iteration's phase-2 thought (plus its inline retry) came
    // back empty, give up on thinking for this turn and produce a
    // speech directly. Prevents an infinite spin on the same thought
    // prompt when the model keeps emitting `（/我 想）` at position 0.
    const forceSpeech =
      consecutiveThoughts >= 1 || consecutiveEmptyThoughtIters >= 1;
    const hasMoodRouting = deps.intentState !== undefined;

    let surface: Surface;
    let needsDetect = false;

    if (forceSpeech) {
      // Soft guard: a thought just committed in the previous iteration; the
      // next iteration must be speech. This drives the always-think →
      // forced-speech rhythm Herta is designed around.
      surface = "speech";
    } else if (hasMoodRouting) {
      // Slice 13.3: with mood routing active, Herta ALWAYS thinks before
      // speaking. There's no RNG and no model-decide branch — the soft guard
      // above alternates: iteration 1 = thought, iteration 2 (forced) = speech,
      // and after each speech the loop typically terminates (no side effects)
      // or repeats the cycle (side effects → loop → another thought → speech).
      //
      // Rationale: Herta's character (per the pre_think corpus) is a
      // decision-tree planner. Going straight to speech without a deliberation
      // pass produces stylistically plausible but contextually weak responses
      // (model just leans on few-shot conditioning). The always-think rhythm
      // forces "what's actually being asked / what's my decision?" through
      // pre_think before the speech is generated.
      surface = "thought";
    } else {
      // Slice 10 fallback: no mood routing → autoregressive surface pick via
      // the `〔接下来〕` hint in `consumeBranchStream`.
      needsDetect = true;
      surface = "speech"; // placeholder; overwritten by consumeBranchStream below
    }

    // Compute supervisor enablement once for this iteration. When
    // enabled AND the upcoming call is phase-2 speech, the sink is
    // deferred so the candidate is buffered silently until the verdict.
    // On OK the caller replays to the sink; on veto the retry streams
    // normally (supervisor-veto retry is unsupervised per §6.4).
    // Empty-speech retry follows a different rule: same-state retry
    // is unsupervised and streams live; state-transition retry IS
    // supervised and re-uses the defer/slow-stream path (see the
    // empty-speech-retry block below).
    const supervisorEnabled =
      !needsDetect &&
      surface === "speech" &&
      deps.supervisorProvider !== undefined &&
      deps.supervisorReference !== undefined &&
      deps.supervisorReference.length > 0;

    // Live-feed the supervised first-pass speech when the sink supports it:
    // open the paced controller BEFORE generation so tokens stream in at TTFT.
    // verdictPending is hoisted here (the supervisor block below resolves it).
    const useLiveFeed =
      supervisorEnabled && deps.sink?.slowStreamSpeechLive !== undefined;
    let liveFeedActive = useLiveFeed;
    let resolveVerdictPending: () => void = () => {};
    const hoistedVerdictPending = useLiveFeed
      ? new Promise<void>((resolve) => {
          resolveVerdictPending = resolve;
        })
      : undefined;
    const liveController =
      useLiveFeed && deps.sink?.slowStreamSpeechLive !== undefined
        ? deps.sink.slowStreamSpeechLive(
            hoistedVerdictPending !== undefined
              ? { verdictPending: hoistedVerdictPending }
              : {},
          )
        : undefined;

    // Particle voice (live path): the live reveal shows the leading particle at
    // TTFT, so fire onPrimarySpeechStart from the first revealed chars — keeping
    // the wav synced to the on-screen particle — instead of post-generation (the
    // non-live fire below, which stays synced there because the non-live reveal
    // can't begin until the candidate is buffered). PARTICLE_LEAD_LOOKAHEAD code
    // points are enough for the matcher; a speech shorter than that never trips
    // this and falls through to the post-generation fire.
    let liveLeadBuf = "";
    const onLiveSpeechToken = (chunk: string): void => {
      liveController?.pushToken(chunk);
      if (particleSignalled) return;
      liveLeadBuf += chunk;
      if ([...liveLeadBuf].length >= PARTICLE_LEAD_LOOKAHEAD) {
        particleSignalled = true;
        deps.onPrimarySpeechStart?.(liveLeadBuf.trim());
      }
    };

    let streamResult: { surface: Surface; text: string };
    try {
      streamResult = needsDetect
        ? await (async (): Promise<{ surface: Surface; text: string }> => {
            const singlePhasePrompt = buildSinglePhasePrompt({
              deps,
              record,
              priorTurnLength,
              forceSpeech: false,
              recap,
              recapBoundaryIndex,
            });
            deps.onPrompt?.("primary", singlePhasePrompt);
            const result = await consumeBranchStream({
              provider: deps.provider,
              model: deps.model,
              prompt: singlePhasePrompt,
              signal,
              sink: deps.sink,
              forceSpeech: false,
            });
            deps.onPrompt?.(
              "primary-out",
              `${singlePhasePrompt}${result.text}`,
            );
            return result;
          })()
        : await runPhaseTwo({
            deps,
            record,
            priorTurnLength,
            surface,
            signal,
            ...(useLiveFeed
              ? { onLiveToken: onLiveSpeechToken }
              : { deferStreaming: supervisorEnabled }),
            recap,
            recapBoundaryIndex,
          });
    } catch (err) {
      // Generation threw (interrupt, provider error) with the live first-pass
      // controller possibly holding pushed tokens and an armed timer: give it
      // its exactly-one terminal call so the sink's stream isn't left parked
      // (begin without end / a hold nothing can release), then re-throw.
      await abandonController(liveController);
      // Interrupt mid-generation → record-carrying abort (audit 2026-07-13
      // T2.5, mirrors the iteration-boundary check at the loop head): after
      // a committed @板砖 dispatch the accumulated blocks are already on
      // screen and disk; a raw throw reverts the driver to its pre-turn
      // record and the next prompt loses the backend run (D7).
      if (signal.aborted) throw new ActorTurnAbortedError(record);
      throw err;
    }

    // Live-feed: generation is complete; total is now known to the controller.
    if (useLiveFeed) liveController?.finishInput();

    // Whether the eventual committed speech text has yet to be
    // rendered to the sink. True when the sink was either:
    //   - deferred during the phase-2 speech call (supervisor enabled), or
    //   - given a thought-indicator only because the call was thought-
    //     surface but produced merged thought+speech content (set below
    //     by the merge-detection branch).
    // Reset to false the moment the sink takes the speech text, either
    // via a downstream LLM call that streamed live (empty-speech retry,
    // veto retry) or via the unified replay step right before commit.
    let speechSinkPending = !needsDetect && supervisorEnabled && !useLiveFeed;

    // Captured supervisor veto reason for the self-correction note
    // appended to the record before the retry's speech block
    // (N8, 2026-05-23). When supervisor vetoes and the retry runs,
    // the discarded rejected speech + veto reason would otherwise
    // be lost — the model has no memory of the correction on the
    // next turn, and the same mistake (e.g. calling 瓦尔特 by 杨叔)
    // tends to repeat. The self-correction block surfaces the
    // lesson into the persistent record so future-turn prompts
    // include it as concrete context.
    let supervisorVetoReasonForRecord: string | undefined;

    // Empty-thought retry ladder. When phase-2 thought returns an
    // empty body (the model emits `（/我 想）` at position 0 —
    // typically because it treats the preceding meta-think preamble
    // as the whole thought), fall into `recoverEmptyThought`. The
    // helper runs up to 3 retries with rising temperature and
    // varying hint angles (`PHASE_TWO_THOUGHT_RETRY_HINTS` variants
    // 0/1/2: base / specific-anchor / mechanical-force) to break the
    // model out of the deterministic-empty-output rut.
    //
    // The final result is used as-is; if it's still empty, the
    // empty-thought handling further down increments
    // `consecutiveEmptyThoughtIters` and the next loop iteration is
    // forced into speech (see the `forceSpeech` definition near the
    // top of the loop).
    if (
      !needsDetect &&
      streamResult.surface === "thought" &&
      isUnusableBlock(streamResult.text)
    ) {
      const thoughtCause = retryCause(streamResult.text);
      streamResult = await recoverEmptyThought({
        ...(thoughtCause !== undefined ? { cause: thoughtCause } : {}),
        deps,
        record,
        priorTurnLength,
        signal,
        recap,
        recapBoundaryIndex,
      });
    }

    // `（我 说）` inside a thought-surface stream is NOT a real surface
    // switch to promote. The phase-2 thought prompt's own instructions
    // reference the tag ("写完 （/我 想） 就停笔——不要继续写 （我 说） …"),
    // and Herta routinely echoes that language while planning her reply
    // ("接着在 `（我 说）` 里，我需要把上面几段合并成自然口语 …"). The old
    // merge detector treated any `（我 说）` substring as a real speech
    // block, split there, and shipped the post-tag planning prose to the
    // user as Herta's line (2026-06-14 turn-013 dump). She also sometimes
    // genuinely rolls into speech without closing `（/我 想）`. In BOTH
    // cases we do the same thing per the user's directive: discard
    // everything from `（我 说）` on, keep the prefix as a normally-
    // completed thought, and let the next (forced-speech) iteration
    // generate the real speech fresh — never promote the clipped tail.
    // Surface stays "thought" so the normal thought-commit path below
    // handles it, including the empty-prefix case (a thought that was
    // nothing but a `（我 说）…` roll-in commits no block and just
    // advances into the forced-speech iteration).
    if (
      !needsDetect &&
      streamResult.surface === "thought" &&
      streamResult.text.includes("（我 说）")
    ) {
      streamResult = {
        surface: "thought",
        text: thoughtBeforeSpeechTag(streamResult.text),
      };
    }

    // Strip stray duplicate open tags from the model's output. The
    // model sometimes re-emits the surface open tag mid-output (e.g.
    // `[part 1] （我 想） [part 2] （/我 想）` or
    // `[s1] （我 说） [s2] （/我 说）`), which would otherwise leak the
    // literal tag into the committed block text and into next turn's
    // prompt. Treat the inner open tag as cruft: drop it and let the
    // surrounding whitespace join the parts. Surface-aware:
    // thought-surface text only strips `（我 想）` here (the merge
    // detector above already consumed `（我 说）` if it was the marker);
    // speech-surface text strips both `（我 说）` and a defensive
    // `（我 想）` in case the model wandered across surfaces.
    if (!needsDetect) {
      streamResult = {
        surface: streamResult.surface,
        text: stripStrayOpenTags(streamResult.text, streamResult.surface),
      };
    }

    // Empty-speech retry ladder. When phase-2 speech returns an empty
    // body (typically because a verbose, conclusive thought caused the
    // model to assign very high probability to closing the speech tag
    // immediately at position 0), retry with `PHASE_TWO_SPEECH_RETRY_HINT`
    // and a rising temperature ladder. See `recoverEmptySpeech` for
    // the details — same helper is reused in the supervisor-veto-retry
    // path below when the veto-retry itself comes back empty.
    //
    // Streaming + supervision: retries ALWAYS defer streaming and pass
    // through the supervisor block. As of 2026-05-23 the supervisor
    // checks every non-empty user-visible speech regardless of whether
    // it came from the initial attempt or an empty-speech retry —
    // there's no longer a "trust the corrective hint, skip supervisor"
    // carve-out. The retry text isn't visible to the user until the
    // supervisor either approves (slow-stream fast-forwards) or vetoes
    // (cancelAndBackspace + veto-retry).
    //
    // Only fires in the phase-2 (mood-routed) path; single-phase has
    // its own surface detection that doesn't share this failure mode.
    if (
      !needsDetect &&
      streamResult.surface === "speech" &&
      // Slot-only counts as empty (2026-08-12): a completion that emits
      // `{需要说的话}` produced no content, and every path that skips the
      // supervisor would otherwise commit it verbatim.
      isUnusableBlock(streamResult.text)
    ) {
      const cause = retryCause(streamResult.text);
      // This branch's live-controller handling was built on "empty ⇒ zero
      // tokens pushed ⇒ the controller drained on its own". A SLOT first
      // pass breaks that premise (review 2026-08-12): its characters WERE
      // pushed and are being revealed on screen, and without a terminal call
      // the controller parks in its verdict hold while the replay below
      // renders the recovered speech next to the placeholder. Retract it,
      // veto-style, before recovering. Empty keeps the drain path untouched;
      // abandonController tolerates an undefined (non-live) controller.
      if (cause === "slot") {
        await abandonController(liveController);
      }
      streamResult = await recoverEmptySpeech({
        ...(cause !== undefined ? { cause } : {}),
        deps,
        record,
        priorTurnLength,
        signal,
        recap,
        recapBoundaryIndex,
      });
      // The ladder's output re-enters the normal pipeline AFTER the strip ran
      // on the first pass — re-strip so a recovered speech that re-emits the
      // open tag doesn't leak it (same reasoning as the veto retry below).
      streamResult = {
        surface: streamResult.surface,
        text: stripStrayOpenTags(streamResult.text, streamResult.surface),
      };
      // Buffered text awaits the supervisor's verdict — must be
      // rendered via the unified-replay or slow-stream path, not
      // bypassed.
      speechSinkPending = true;
      // Render the recovered speech via the non-live paced replay below. The
      // live controller is settled either way: an EMPTY first pass pushed
      // nothing and drained on its own; a SLOT first pass was retracted via
      // abandonController above. The hoisted verdict gate is moot for both.
      liveFeedActive = false;
    }

    // Particle voice (SPEC 2026-06-23): fire onPrimarySpeechStart for the turn's
    // FIRST non-empty speech. The live path already fired this from the first
    // revealed chars (onLiveSpeechToken above, synced to the on-screen particle),
    // so this is the fire for the non-live / single-phase paths — and the
    // fallback for a live speech shorter than PARTICLE_LEAD_LOOKAHEAD. The
    // particleSignalled latch keeps it to the first speech block; the downstream
    // veto-retry replay and beats never reach this point, so they never fire.
    if (
      !particleSignalled &&
      streamResult.surface === "speech" &&
      streamResult.text.trim().length > 0
    ) {
      particleSignalled = true;
      deps.onPrimarySpeechStart?.(streamResult.text.trim());
    }

    // Supervisor check (Slice: supervisor). Runs on EVERY non-empty
    // phase-2 speech with the supervisor enabled — including the
    // empty-speech retry's output. Pre-2026-05-23 a same-state retry
    // bypassed the supervisor (the "trust the corrective hint" carve-
    // out from spec §6.4). Empirically that let bad retries ship
    // unchecked, and the state-transition exception only patched the
    // narrow subset of high-risk turns. Always-supervise is the
    // principled version: the supervisor's purpose is to gate user-
    // visible speech, and a retry's output is just as user-visible as
    // an initial attempt's.
    //
    // The empty-speech retry above sets `deferStreaming: true`, so the
    // sink hasn't seen the retry's text. The supervisor block drives
    // rendering: slowStreamSpeech + fastForward on OK, or
    // cancelAndBackspace + supervisor-veto-retry on VETO.
    if (
      !needsDetect &&
      streamResult.surface === "speech" &&
      streamResult.text.trim().length > 0 &&
      deps.supervisorProvider !== undefined &&
      deps.supervisorReference !== undefined &&
      deps.supervisorReference.length > 0
    ) {
      // Capture supervisorProvider into a local const so TypeScript's
      // narrowing survives across `await` boundaries below.
      const supervisorProvider = deps.supervisorProvider;

      // Find the most recent thought block from the CURRENT turn for
      // the supervisor's intent-alignment reference. Walk backwards
      // through the record from the end down to priorTurnLength.
      let currentTurnThought: string | undefined;
      for (let i = record.length - 1; i >= priorTurnLength; i--) {
        const block = record[i];
        if (
          block !== undefined &&
          block.kind === "herta" &&
          block.surface === "thought"
        ) {
          currentTurnThought = block.text;
          break;
        }
      }

      // Build the prompt locally so we can fire onPrompt("supervisor", ...)
      // BEFORE the provider call begins. This way the prompt side of
      // the diagnostic dump is captured even when streamChat throws.
      const { prompt: supervisorPrompt, frame: supervisorFrame } =
        buildSupervisorPrompt({
          // Supervisor needs system blocks (→ 系统 / → 差分协处理器)
          // alongside speech turns so it can verify Herta's
          // candidate speech is grounded in what just happened
          // (file contents, dir listings, backend reports). Uses
          // `lastNTurnsForSupervisor`, NOT the router's
          // `lastNSpeechTurns` which strips system blocks for the
          // mood classifier. See SPEC v0.2 Supervisor design §5.1.
          recentRecord: lastNTurnsForSupervisor(record, 8),
          currentState: deps.intentState ?? "默认",
          ...(currentTurnThought !== undefined ? { currentTurnThought } : {}),
          candidateSpeech: streamResult.text,
          // Same 废案 the actor loaded this session → the supervisor grounds
          // 废案-sourced facts instead of blocking them as 事件/关系编造.
          feianFewShots: deps.staticPrefix.fewShots,
          // Full-session 板砖 completion receipts (2026-07-17): rule 9's
          // receipt check must see markers older than the 8-block window,
          // or a legitimate reference to earlier completed work reads as
          // fabrication and gets falsely vetoed.
          sessionReceipts: sessionMarkerReceipts(record),
          lang: deps.lang ?? "zh",
        });
      deps.onPrompt?.("supervisor", supervisorPrompt);

      // Verdict-pending gate + paced controller. The gate is a promise that
      // resolves once the supervisor stream is done (OK, veto, or fail-soft);
      // the paced controller throttles its per-char cadence in the back half of
      // the speech while the verdict is still pending — keeps the visible
      // stream moving through the supervisor wait instead of finishing early
      // and leaving the user staring at a "rendered but possibly about to
      // retract" state. See `SLOW_STREAM_VERDICT_PENDING_*` constants in
      // `narrative-renderer.ts`.
      //
      // Live-feed reuses the controller opened (and fed) before/during
      // generation, plus its hoisted verdict gate (`resolveVerdictPending`
      // already targets `hoistedVerdictPending`). The non-live path creates the
      // gate here and kicks off the paced replay of the fully-buffered
      // candidate — trim before passing so the live char-by-char animation
      // doesn't emit a leading `\n` (blank line above the speech) or trailing
      // whitespace before endHertaStream's `\n`. When the sink supports neither
      // primitive, `slowStreamController` stays undefined and the verdict
      // branches below fall through to the "defer + unified replay" path.
      let slowStreamController: SlowStreamController | undefined;
      if (liveFeedActive && liveController !== undefined) {
        slowStreamController = liveController;
        // resolveVerdictPending already targets hoistedVerdictPending.
      } else {
        // Reassigns the HOISTED resolveVerdictPending (do NOT add `let` here) —
        // the supervisor's `finally` below resolves this same binding.
        const verdictPending = new Promise<void>((resolve) => {
          resolveVerdictPending = resolve;
        });
        slowStreamController =
          deps.sink?.slowStreamSpeech !== undefined
            ? // Stray-stripped (slice 4): the replay streams the same text
              // the commit stores — a stray tag never types then vanishes.
              deps.sink.slowStreamSpeech(
                stripStrayOpenTags(streamResult.text, "speech"),
                { verdictPending },
              )
            : undefined;
      }
      if (slowStreamController !== undefined) {
        // The slow-stream is taking responsibility for rendering;
        // the unified-replay step below must NOT also render.
        speechSinkPending = false;
      }

      // The supervisor call (deadline, judgment-window bracket, fail-soft and
      // the interrupt teardown all live in runSupervisorVerdict). Always open
      // the slow-stream's verdict-pending gate when it returns — or throws —
      // regardless of OK / veto / fail-soft outcome: the slow-stream uses
      // this signal only to switch cadence; the verdict-driven branching
      // (fastForward vs cancelAndBackspace) happens below.
      let supervisorVerdict: SupervisorVerdict;
      try {
        supervisorVerdict = await runSupervisorVerdict({
          deps,
          supervisorProvider,
          supervisorPrompt,
          supervisorFrame,
          signal,
          record,
          controller: slowStreamController,
        });
      } finally {
        resolveVerdictPending();
      }

      // First-pass trigger gate (2026-07-29). A speech the supervisor
      // PASSED can still be carrying a `@板砖` that was never meant to
      // dispatch — see judgeTriggerAndNeutralize for the live miss and the
      // numbers. Runs before the veto branch below so the two never fight:
      // a blocked speech is being rewritten anyway, and its re-speak gets
      // its own pass at the bottom of that branch.
      let triggerNeutralizedThisPass = false;
      if (
        supervisorVerdict.verdict !== "block" &&
        wouldDispatch(streamResult.text, dispatchCount)
      ) {
        let judged: { text: string; reason?: string };
        try {
          judged = await judgeTriggerAndNeutralize({
            deps,
            supervisorProvider,
            signal,
            record,
            candidate: streamResult.text,
            thought: currentTurnThought,
          });
        } catch (err) {
          // The judge is fail-soft on everything EXCEPT an aborted turn, so
          // an escaping throw is the interrupt. Same contract as the
          // supervisor catch: the parked slow-stream gets its terminal
          // call, then the abort carries the record (audit 2026-07-13 T2.5)
          // — a raw rethrow reverts the driver to its pre-turn record,
          // losing blocks an earlier @板砖 dispatch in this turn already put
          // on screen and disk (D7).
          if (signal.aborted) {
            await abandonController(slowStreamController);
            throw new ActorTurnAbortedError(record);
          }
          throw err;
        }
        if (judged.text !== streamResult.text) {
          triggerNeutralizedThisPass = true;
          streamResult = { ...streamResult, text: judged.text };
          if (judged.reason !== undefined) {
            supervisorVetoReasonForRecord =
              supervisorVetoReasonForRecord !== undefined
                ? `${supervisorVetoReasonForRecord}；${judged.reason}`
                : judged.reason;
          }
        }
      }

      // Missing-dispatch judge (ADR 0036) — see runMissingDispatchJudge.
      // Gated tightly: supervisor passed, the sanitized projection MENTIONS
      // 板砖, and no live trigger (regardless of budget — a written `@` over
      // budget is not a missing one). A candidate whose `@` the trigger
      // judge just STRIPPED is settled rhetoric, not an unbacked promise —
      // re-judging the neutralized text would veto the very outcome the
      // first judge chose. A BLOCK folds into the supervisor veto below.
      if (
        supervisorVerdict.verdict !== "block" &&
        !triggerNeutralizedThisPass
      ) {
        const projectedForJudge = sanitizeActorText(
          stripStrayOpenTags(streamResult.text, "speech"),
          { role: "speech" },
        );
        if (
          !parseHertaBlock(projectedForJudge).hasBanzhuanTrigger &&
          projectedForJudge.includes("板砖")
        ) {
          const mdVerdict = await runMissingDispatchJudge({
            deps,
            supervisorProvider,
            signal,
            record,
            candidate: streamResult.text,
            thought: currentTurnThought,
            controller: slowStreamController,
          });
          if (mdVerdict !== null) supervisorVerdict = mdVerdict;
        }
      }

      if (supervisorVerdict.verdict === "block") {
        // See recoverFromVeto — the whole veto arc, over this iteration's
        // state, returned explicitly.
        const recovered = await recoverFromVeto({
          deps,
          signal,
          record,
          priorTurnLength,
          recap,
          recapBoundaryIndex,
          streamResult,
          supervisorVerdict,
          slowStreamController,
          currentTurnThought,
          supervisorProvider,
          dispatchCount,
          vetoSignalled,
          supervisorVetoReasonForRecord,
        });
        record = recovered.record;
        streamResult = recovered.streamResult;
        speechSinkPending = recovered.speechSinkPending;
        vetoSignalled = recovered.vetoSignalled;
        supervisorVetoReasonForRecord = recovered.supervisorVetoReasonForRecord;
      } else if (slowStreamController !== undefined) {
        // Verdict OK (or fail-soft). Drain whatever's left of the
        // slow-stream at min cadence so the user sees the speech
        // finish naturally. Interruptible (slice 3): a stop click during
        // this drain flushes the tail in one delta instead of locking the
        // turn until the paced drain finishes.
        const disarm = armAbortFlush(signal, slowStreamController);
        try {
          await slowStreamController.fastForward();
        } finally {
          disarm();
        }
      }
      // When there is no slow-stream controller, verdict OK (or fail-soft
      // to OK) falls through to the unified replay step below, which
      // renders the pending speech to the sink iff `speechSinkPending`
      // is still true.
    }

    // Unified sink replay for pending speech. Fires exactly when the
    // committed speech text has not yet reached the sink — either the
    // initial speech call was sink-deferred (supervisor enabled), or
    // the speech was split out of a merged thought call. Re-uses the
    // sink's begin/token/end protocol so the sink cursor advances by
    // one position to claim the speech block. Trim before emitting
    // so the unified replay matches the streaming-time behavior and
    // doesn't reintroduce blank lines.
    if (speechSinkPending && streamResult.surface === "speech") {
      // Stray-stripped (slice 4) — the one-shot replay must match the commit.
      const replayText = stripStrayOpenTags(streamResult.text, "speech");
      if (replayText.length > 0) {
        deps.sink?.beginHertaStream("speech");
        deps.sink?.streamHertaToken(replayText);
        deps.sink?.endHertaStream();
      }
      speechSinkPending = false;
    }

    // When the soft guard forced speech, the output is a transitional
    // block — reset the counter and continue looping rather than
    // terminating (the guard exists to *redirect* flow, not end the turn).
    const wasForcedSpeech = forceSpeech;

    // Stray-strip BEFORE the emptiness checks (fence-fuzz, 2026-07-09): a
    // body that is nothing but stray open tags strips to empty and must
    // take the empty-thought / empty-speech path (redirect / graceful end).
    // The pre-strip check used to let it through, and the commit-site strip
    // then emptied it — committing an empty block the live stream (which
    // drops strays as they arrive) had never shown: streamed != committed.
    // The commit sites below keep their own strip (idempotent) because the
    // retry paths can replace `streamResult` after this line.
    streamResult = {
      surface: streamResult.surface,
      text: stripStrayOpenTags(streamResult.text, streamResult.surface),
    };

    if (streamResult.surface === "thought") {
      // Slot-only lands here as well (2026-08-12): a placeholder that
      // survived the ladder must not be committed as a thought, or next
      // turn's prompt shows a row of brackets where a judgement should be
      // and she reads it back as her own reasoning.
      if (isUnusableBlock(streamResult.text)) {
        // Empty thought after the inline retry too — record this
        // iteration as an empty-thought iteration. The next iteration's
        // `forceSpeech` will be true (see counter check at the top of
        // the loop), so we'll produce speech directly instead of
        // looping the same thought prompt forever.
        consecutiveEmptyThoughtIters += 1;
        continue;
      }
      // Real thought content this turn — reset the empty-thought
      // counter so a future empty-thought spin starts fresh.
      consecutiveEmptyThoughtIters = 0;
      // Belt-and-suspenders trim: stream consumers and the dup-tag
      // strip already trim, but the empty-thought retry path returns
      // text that bypasses the dup-tag strip block (it replaces
      // `streamResult` AFTER that block runs). Trimming here ensures
      // the persisted record never contains leading/trailing ws
      // regardless of which path produced the text.
      //
      // sanitizeActorText: the record is the prompt — a forged → 系统 /
      // cross-role delimiter in a committed thought would re-enter every
      // future prompt as harness ground truth (slice 2 of the output-
      // hardening plan). Neutralized at construction so disk, prompts,
      // and every projection inherit the safe text.
      // stripStrayOpenTags at commit for EVERY path (slice 4): the live
      // stream drops stray tags as they arrive, so the committed text must
      // drop them too — otherwise sanitize ZWSP-breaks the leftover tag and
      // streamed ≠ committed. Idempotent over already-stripped paths.
      const thoughtBlock: TerminalRecordBlock = {
        kind: "herta",
        surface: "thought",
        text: sanitizeActorText(
          stripStrayOpenTags(streamResult.text, "thought"),
          { role: "thought" },
        ),
      };
      record = [...record, thoughtBlock];
      consecutiveThoughts += 1;

      // `@板砖` in a thought block is inert prose — backend dispatch
      // requires the trigger to land in a speech block where the
      // supervisor can gate it and the user sees what's being asked
      // of the backend.
      continue;
    }

    // surface === "speech"
    //
    // THE COMMIT BOUNDARY. Every path converges here — first pass, veto
    // respeak, empty-speech ladder, and every supervisor-skipping path
    // (deadline fail-soft, provider error, `config.supervisor.enabled =
    // false`). This is therefore the one place a deterministic shape guard
    // covers all of them, which an LLM judge by construction cannot.
    if (isUnusableBlock(streamResult.text)) {
      // Empty speech (e.g. provider returned only a stop sequence or finish),
      // or a slot-only completion that survived the retry ladder. Don't commit
      // it; terminate the turn gracefully. Silence is recoverable — the user
      // can just speak again — whereas `{需要说的话}` on screen is not.
      deps.sink?.flushBlocks(record);
      return { record };
    }
    // Belt-and-suspenders trim: covers the empty-speech retry and
    // supervisor-veto retry paths, both of which replace
    // `streamResult` AFTER the dup-tag strip block has already run.
    // The record-stored text matches what the user sees on screen.
    //
    // Self-correction anchor (N8/N8b, 2026-05-23): when this speech
    // was committed via the supervisor-veto retry path, attach the
    // veto reason to the block via `selfCorrection`. The CLI
    // renderer ignores the field (only `text` reaches stdout), but
    // the serializer prepends `——<reason>\n\n` as prose before the
    // speech envelope so future-turn LLM prompts carry the lesson.
    // Without this anchor the model loses memory of "I was self-
    // corrected on X" the moment the turn ends, and the same
    // mistake (e.g. 杨叔→瓦尔特) repeats on every subsequent turn.
    // Budget-suppressed trigger (chained dispatch, 2026-07-10): with the
    // per-turn dispatch budget already SPENT, a further `@板砖` in this
    // speech will NOT dispatch — committing it live would leave a
    // dispatch-looking token in the record and the GUI chip for a run that
    // never happened, eroding the literal-token contract the discipline
    // spec teaches. Neutralize at commit (same quoted-`@板砖` mechanism as
    // the recheck path). Within the budget the
    // token stays live and the dispatch branch below fires — a synthesis
    // speech may legitimately chain a follow-up run.
    // sanitizeActorText BEFORE the trigger checks: the strip half can
    // splice a live @板砖 out of zero-width-obfuscated input, so every
    // trigger decision below reads the sanitized text — display and
    // dispatch always agree (slice 2 of the output-hardening plan).
    // stripStrayOpenTags first (slice 4): the live stream drops stray tags
    // as they arrive, so the commit must too — streamed == committed.
    let committedSpeechText = sanitizeActorText(
      stripStrayOpenTags(streamResult.text, "speech"),
      { role: "speech" },
    );
    if (
      dispatchCount >= MAX_DISPATCHES_PER_TURN &&
      parseHertaBlock(committedSpeechText).hasBanzhuanTrigger
    ) {
      committedSpeechText = neutralizeBanzhuanTrigger(committedSpeechText);
    }
    const speechBlock: TerminalRecordBlock =
      supervisorVetoReasonForRecord !== undefined
        ? {
            kind: "herta",
            surface: "speech",
            text: committedSpeechText,
            // The veto reason is supervisor-model output headed for the
            // `——` prose lane of every future prompt. Role "speech":
            // forged labels/delimiters break, but a reason that NAMES
            // @板砖 (trigger-discipline lessons do) keeps the literal
            // token — the prose lane is never dispatch-parsed, and the
            // lesson only teaches if the model sees the real token.
            selfCorrection: sanitizeActorText(
              formatSelfCorrectionText(supervisorVetoReasonForRecord),
              { role: "speech" },
            ),
          }
        : {
            kind: "herta",
            surface: "speech",
            text: committedSpeechText,
          };
    record = [...record, speechBlock];
    consecutiveThoughts = 0;
    consecutiveEmptyThoughtIters = 0;
    speechIterations += 1;

    // Bug 1 (2026-06-27): finalize Herta's speech on the shared record the
    // instant she finishes speaking — BEFORE any @板砖 dispatch — so the GUI
    // swaps its transient streaming bubble for the finalized HertaBubble (which
    // renders the @板砖 chip) at speaking-done, not coupled to the backend run /
    // permission gate. Idempotent: flushBlocks emits emittedCount..length and
    // advances its cursor, so the bridge's later flush and the defensive flush
    // below never re-emit this block (ActorStreamingSink.flushBlocks contract).
    deps.sink?.flushBlocks(record);

    // Parse the dispatch trigger from the COMMITTED (sanitized) text, not
    // the raw stream: the sanitize strip can change trigger presence for
    // zero-width-obfuscated input, and the committed text is what the
    // user sees and the record keeps — the literal-token contract binds
    // dispatch to that, never to invisible raw bytes.
    const parsed = parseHertaBlock(committedSpeechText);
    let ranSideEffect = false;

    if (parsed.hasBanzhuanTrigger && dispatchCount < MAX_DISPATCHES_PER_TURN) {
      const policy = new BeatPolicy();
      const fireBeat = makeFireBeat(
        deps,
        priorTurnLength,
        recap,
        recapBoundaryIndex,
      );
      record = await invokeBanzhuanBridge(record, [], {
        bus: deps.bus,
        runtimeFactory: deps.runtimeFactory,
        lang: deps.lang,
        signal,
        beatPolicy: policy,
        fireBeat,
        sink: deps.sink,
      });
      dispatchCount += 1;
      ranSideEffect = true;
      // No-op handling (2026-05-23 duplicate-speech fix) now lives in the
      // bridge: invokeBanzhuanBridge emits a 无产出 差分协处理器 block when the
      // backend produced no work, so the next iteration has concrete context.
    }

    // In two-phase mode (mood routing active), forced-speech is a fully
    // committed output block — no need to continue looping for another
    // iteration. In single-phase mode the original "continue after
    // forced speech" behavior is preserved for backward compatibility.
    const hasMoodRoutingLocal = deps.intentState !== undefined;
    if (!ranSideEffect && (!wasForcedSpeech || hasMoodRoutingLocal)) {
      // Final flush (defensive) — the sink should already be up to date.
      deps.sink?.flushBlocks(record);
      return { record };
    }
  }

  // Safety cap hit on speech iterations.
  deps.sink?.flushBlocks(record);
  return { record };
}

/**
 * Stream one main-loop iteration. Detects surface from the first 1–2
 * chars after the open tag (`想）` vs `说）`), then streams remaining
 * tokens via `streamHertaToken` (no-op on thought surface inside the
 * sink).
 *
 * Uses a deferred-begin pattern: `beginHertaStream(surface)` is NOT
 * called until the first token chunk that actually has content is safe
 * to emit. This ensures that if the stream body is empty (whitespace-
 * only or literally nothing), `beginHertaStream` is never called and
 * neither is `endHertaStream`, leaving the renderer's cursor and
 * `streamingSurface` untouched — which keeps it in sync with the record
 * (the actor's empty-body path skips the block commit).
 *
 * For speech: any non-empty chunk (including whitespace) triggers begin,
 * because whitespace IS visible content in a speech block.
 * For thought: only a non-whitespace chunk triggers begin, to prevent
 * the renderer's cursor from advancing for whitespace-only thought
 * streams (thought tokens are no-ops in the sink, so holding the
 * whitespace is invisible and correct).
 */
async function consumeBranchStream(opts: {
  provider: CompletionProviderAdapter;
  model: string;
  prompt: string;
  signal: AbortSignal;
  sink?: ActorStreamingSink;
  forceSpeech: boolean;
}): Promise<{
  surface: Surface;
  text: string;
}> {
  let buffered = "";
  // Two positions track different things in `buffered`:
  //   - `tagSkipPos` is the offset where Herta's body starts (just past
  //     `说）` / `想）` and any leading whitespace). Fixed for the life of
  //     the stream after `tryDecideTagSkip` runs. Used to compute
  //     `cleanText` (the committed block body) at end-of-stream.
  //   - `emittedTail` is the offset past which we've already forwarded
  //     bytes to the sink via `streamHertaToken`. Advances during the
  //     stream as `safeEmitBoundary` clears more content. Always
  //     `>= tagSkipPos` once the tag is decided.
  let tagSkipPos = 0;
  let emittedTail = 0;
  let surface: Surface | null = opts.forceSpeech ? "speech" : null;
  // For forced-speech, the open tag `（我 说）` was in the prompt, so the
  // stream contains pure body — no tag to skip. Mark decided up-front.
  let tagSkipDecided = opts.forceSpeech;
  let beginCalled = false;
  // Tracks whether at least one non-whitespace char has been seen past
  // the open-tag position. Until true, leading whitespace in the body
  // (e.g. the `\n` after `说）` from the corpus format) is held back
  // so the user doesn't see a blank line above Herta's speech. After
  // it goes true, trailing-whitespace runs are held back too — so a
  // run that ends the stream gets dropped, but a run followed by more
  // non-ws gets emitted normally as internal whitespace.
  let bodyStarted = false;

  /**
   * Returns true when the `chunk` justifies opening the stream for the
   * given surface. Both speech and thought require non-whitespace to
   * begin (the leading-ws skip below ensures `streamHertaToken` is
   * never called with a whitespace-only prefix). Pre-2026-05-23,
   * speech allowed any chunk (including whitespace) to trigger begin
   * — that produced the blank-line-above-speech artifact when the
   * model emitted `（我 说）\n<body>`.
   */
  const shouldBegin = (_s: Surface, chunk: string): boolean => {
    return chunk.trim().length > 0;
  };

  const ensureBegin = (s: Surface, chunk: string): void => {
    if (!beginCalled && shouldBegin(s, chunk) && opts.sink !== undefined) {
      opts.sink.beginHertaStream(s);
      beginCalled = true;
    }
  };

  /**
   * Advance `emittedTail` past the leading `说）` / `想）` tag once enough
   * chars are buffered to make a definitive decision. This MUST run before
   * any emit so we never forward partial-tag bytes (the post-merge bug
   * where `说` from delta 1 leaked to stdout before `）` arrived in delta
   * 2). On malformed completions (the tag isn't where it should be), we
   * leave `emittedTail` at 0 and emit verbatim — defensive recovery.
   */
  const tryDecideTagSkip = (): void => {
    if (tagSkipDecided || surface === null) return;
    const tag = surface === "thought" ? "想）" : "说）";
    const wsMatch = buffered.match(/^[\s　]*/);
    const wsLen = wsMatch !== null ? wsMatch[0].length : 0;
    if (buffered.length < wsLen + tag.length) {
      // Not enough chars yet — wait for next delta.
      return;
    }
    if (buffered.slice(wsLen, wsLen + tag.length) === tag) {
      tagSkipPos = wsLen + tag.length;
      emittedTail = tagSkipPos;
    }
    // else: tag malformed; tagSkipPos stays 0, verbatim emission.
    tagSkipDecided = true;
  };

  /**
   * Stream `buffered.slice(emittedTail, safeEnd)` to the sink with
   * speech/thought rules AND with leading/trailing whitespace stripping.
   *
   * Pre-emit: skip leading whitespace until `bodyStarted` flips to true
   * (i.e. the first non-ws char of the body has arrived).
   *
   * Post-emit: hold back any trailing whitespace at the end of the slice
   * — if the next chunk brings more non-ws content the held-back ws is
   * emitted as internal whitespace; if the stream ends, the held-back
   * ws is discarded by the final-flush block below.
   */
  const flushToSink = (safeEnd: number): void => {
    if (
      surface === null ||
      !tagSkipDecided ||
      opts.sink === undefined ||
      safeEnd <= emittedTail
    ) {
      return;
    }
    let start = emittedTail;
    if (!bodyStarted) {
      while (start < safeEnd && /\s/.test(buffered.charAt(start))) {
        start++;
      }
      if (start >= safeEnd) {
        // Still all whitespace — hold and wait.
        emittedTail = safeEnd;
        return;
      }
      bodyStarted = true;
    }
    let end = safeEnd;
    while (end > start && /\s/.test(buffered.charAt(end - 1))) {
      end--;
    }
    if (end > start) {
      // Slice 4 (streamed == committed): drop complete stray open tags the
      // commit path would remove, so the tag never types on screen only to
      // vanish at the block swap. The emit boundary held any partial tag,
      // so this only ever sees complete ones.
      const chunk = stripStrayFromChunk(buffered.slice(start, end), surface);
      if (chunk.length === 0) {
        emittedTail = end; // the slice was one whole stray tag — consume it
        return;
      }
      if (surface === "speech") {
        ensureBegin(surface, chunk);
        if (beginCalled) opts.sink.streamHertaToken(chunk);
      } else {
        ensureBegin(surface, chunk);
      }
      emittedTail = end;
    }
    // Else: slice was all-whitespace-with-no-leading-ws-to-skip; hold
    // it. emittedTail stays put so we re-evaluate on the next call.
  };

  for await (const ev of opts.provider.streamCompletion(
    {
      model: opts.model,
      prompt: opts.prompt,
      stop: [STOP_SPEECH_CLOSE, STOP_THOUGHT_CLOSE, STOP_OPENER_USER],
      // Capped (slice 3); the supervisor call is deadline-only by design —
      // see PRIMARY_COMPLETION_MAX_TOKENS.
      maxTokens: PRIMARY_COMPLETION_MAX_TOKENS,
    },
    opts.signal,
  )) {
    if (ev.type === "text-delta") {
      buffered += ev.text;

      if (surface === null) {
        const detected = detectSurface(buffered);
        if (detected !== null) surface = detected;
      }

      tryDecideTagSkip();

      // Only forward chunks AFTER the tag-skip position is decided.
      // This prevents partial-tag bytes from reaching the sink
      // across split deltas (delta 1 = "说", delta 2 = "）好。").
      // LIVE_EMIT_HOLD_SEQS also holds partial STRAY tags (slice 4).
      // firstStopIndex caps the emit at any COMPLETE stop marker a
      // misbehaving provider streamed past (fence-fuzz, 2026-07-09).
      flushToSink(
        Math.min(
          safeEmitBoundary(buffered, LIVE_EMIT_HOLD_SEQS),
          firstStopIndex(buffered, STOP_SEQS),
        ),
      );
    } else if (ev.type === "finish") {
      break;
    }
  }

  // End-of-stream. If surface was never detected (empty stream, or model
  // emitted only the stop seq), default to speech. Do NOT call
  // beginHertaStream here — begin only fires when there is content.
  if (surface === null) surface = "speech";

  // Stream might have been short enough that we never accumulated full
  // tag length during the loop — decide now with whatever we have.
  tryDecideTagSkip();

  // Clean the raw buffer's tail before committing. Two exclusive cases:
  //   - A COMPLETE stop marker exists: cut exactly at the first one (where a
  //     stop-honoring provider would have ended the stream — matches the
  //     live emit cap above, so streamed == committed even against a
  //     provider that streams past its stops; fence-fuzz 2026-07-09). The
  //     cut point is exact, so prose legitimately ending in `（` right
  //     before the marker is preserved — no dangling-strip afterwards.
  //   - No complete marker: the stream may have ended mid-marker; strip a
  //     DANGLING partial prefix like `（/` (the `.trim()` below only
  //     removes whitespace, not the full-width `（`).
  const stopIdx = firstStopIndex(buffered, STOP_SEQS);
  const withoutClose =
    stopIdx < buffered.length
      ? buffered.slice(0, stopIdx)
      : stripDanglingStopPrefix(buffered, STOP_SEQS);

  // cleanText = buffer past the tag (and past the close-tag strip),
  // with leading and trailing whitespace stripped. Use `tagSkipPos`
  // (NOT `emittedTail`) — the committed block body is the full content
  // after the tag, independent of how much we've already streamed via
  // `streamHertaToken`. Clamp to handle the edge case where
  // `tagSkipPos` exceeds `withoutClose.length` (close tag started
  // right after the open tag). The trim mirrors the streaming-time
  // skip-leading / hold-back-trailing logic so the record stores
  // exactly what the user saw on screen.
  const cleanStart = Math.min(tagSkipPos, withoutClose.length);
  const cleanText = withoutClose.slice(cleanStart).trim();

  // Flush any held tail: content in `withoutClose` past `emittedTail`
  // that wasn't streamed during the loop (held back by safeEmitBoundary
  // pending stop-seq resolution OR by the leading/trailing whitespace
  // skip above). Apply the same leading-skip + trailing-strip rules
  // so the final flush doesn't reintroduce blank lines.
  if (opts.sink !== undefined && emittedTail < withoutClose.length) {
    let start = emittedTail;
    let end = withoutClose.length;
    if (!bodyStarted) {
      while (start < end && /\s/.test(withoutClose.charAt(start))) {
        start++;
      }
      if (start < end) bodyStarted = true;
    }
    while (end > start && /\s/.test(withoutClose.charAt(end - 1))) {
      end--;
    }
    if (end > start) {
      // Slice 4: the emit-boundary hold parks a complete stray tag at the
      // stream's end; strip it here (the commit path removes it too) and
      // re-trim the exposed trailing whitespace so streamed == committed.
      const tailChunk = stripStrayFromChunk(
        withoutClose.slice(start, end),
        surface,
      ).replace(/\s+$/, "");
      if (tailChunk.length > 0) {
        if (surface === "speech") {
          ensureBegin(surface, tailChunk);
          if (beginCalled) opts.sink.streamHertaToken(tailChunk);
        } else {
          ensureBegin(surface, tailChunk);
        }
      }
    }
  }

  // begin/end calls must be balanced — the renderer's cursor advances on
  // endHertaStream, and we only want that advance when a block will
  // commit to TerminalRecord.
  if (beginCalled) opts.sink?.endHertaStream();

  return { surface, text: cleanText };
}

/**
 * Construct the Slice 10 single-phase prompt (used when no mood routing
 * is configured, and as a building block for phase 1 of two-phase mode).
 */
function buildSinglePhasePrompt(opts: {
  deps: ActorTurnDeps;
  record: TerminalRecord;
  priorTurnLength: number;
  forceSpeech: boolean;
  recap?: string;
  recapBoundaryIndex?: number;
}): string {
  const prompt: ActorPrompt = {
    staticPrefix: opts.deps.staticPrefix,
    record: opts.record,
    priorTurnLength: opts.priorTurnLength,
    formatHint: opts.forceSpeech
      ? undefined
      : resolveHints(opts.deps).thoughtHintLine,
    openTag: opts.forceSpeech ? FORCED_SPEECH_OPEN_TAG : BRANCH_OPEN_TAG,
    ...(opts.recap !== undefined ? { recap: opts.recap } : {}),
    recapBoundaryIndex: opts.recapBoundaryIndex ?? 0,
    lang: opts.deps.lang ?? "zh",
  };
  return serializeActorPrompt(prompt);
}

/**
 * Extract the thought portion of a thought-surface phase-2 stream that
 * ran past a `（我 说）` tag.
 *
 * A thought stream sometimes contains `（我 说）` — either because Herta
 * referenced the speech tag in her planning prose (echoing the phase-2
 * thought prompt's own instruction language, e.g. "接着在 `（我 说）`
 * 里 …"), or because she genuinely skipped her `（/我 想）` close and
 * rolled into speech. In BOTH cases the text from `（我 说）` on is
 * discarded — the actor never promotes it to a speech block; the real
 * speech is generated fresh by the next forced-speech iteration. This
 * avoids the 2026-06-14 bug where the post-tag planning prose was
 * shipped to the user as Herta's line.
 *
 * Returns the trimmed thought: everything before the first `（我 说）`,
 * with a trailing `（/我 想）` and any stray `（我 想）` open tags removed.
 * When `（我 说）` is absent the whole (cleaned) text is returned.
 */
function thoughtBeforeSpeechTag(text: string): string {
  const splitIdx = text.indexOf("（我 说）");
  const thoughtPart = splitIdx < 0 ? text : text.slice(0, splitIdx);
  return stripStopSequence(thoughtPart, STOP_THOUGHT_CLOSE)
    .replaceAll("（我 想）", "")
    .trim();
}

/**
 * Empty-speech recovery ladder. Drives up to
 * `EMPTY_SPEECH_RETRY_TEMPERATURES.length` retry attempts of phase-2
 * speech with `isSpeechRetry: true` (PHASE_TWO_SPEECH_RETRY_HINT) and
 * a rising temperature ladder. Exits as soon as the model produces
 * non-empty content, OR returns the final still-empty result after
 * exhausting the ladder.
 *
 * All attempts pass `deferStreaming: true` — the caller (actor's
 * supervisor block or veto-retry path) is responsible for rendering
 * the eventual non-empty text via `slowStreamSpeech` + fastForward
 * (on supervisor OK) or for committing it without rendering on
 * supervisor-veto. The caller also handles the "still empty after
 * the ladder" fallback (typically: terminate the turn gracefully).
 *
 * Used in two places:
 *   1. After the initial phase-2 speech if it came back empty
 *      (post-meta-think failure mode).
 *   2. After the supervisor-veto-retry if THAT came back empty
 *      (the veto-retry's vetoHint failed to elicit content;
 *      bumping temperature is the documented recovery per
 *      DeepSeek's parameter-settings guide).
 *
 * Always returns `{ surface: "speech", text }` — the caller relies
 * on the surface for downstream branching.
 */
async function recoverEmptySpeech(opts: {
  deps: ActorTurnDeps;
  record: TerminalRecord;
  priorTurnLength: number;
  signal: AbortSignal;
  recap?: string;
  recapBoundaryIndex?: number;
  /** What the attempt that sent us here did wrong. Recomputed after every
   *  ladder attempt, so the correction always matches the LAST failure
   *  rather than the first one. */
  cause?: RetryCause;
}): Promise<{ surface: Surface; text: string }> {
  let cause: RetryCause = opts.cause ?? "empty";
  let result: { surface: Surface; text: string } = {
    surface: "speech",
    text: "",
  };
  for (
    let attempt = 0;
    attempt < EMPTY_SPEECH_RETRY_TEMPERATURES.length;
    attempt += 1
  ) {
    const temperature = EMPTY_SPEECH_RETRY_TEMPERATURES[attempt];
    const phaseTwoOpts: Parameters<typeof runPhaseTwo>[0] = {
      deps: opts.deps,
      record: opts.record,
      priorTurnLength: opts.priorTurnLength,
      surface: "speech",
      signal: opts.signal,
      isSpeechRetry: true,
      ...(opts.recap !== undefined ? { recap: opts.recap } : {}),
      recapBoundaryIndex: opts.recapBoundaryIndex ?? 0,
      // Per-attempt hint variant from PHASE_TWO_SPEECH_RETRY_HINTS:
      //   idx 0 → base ("you closed empty, write a sentence")
      //   idx 1 → specific-point anchor
      //   idx 2 → mechanical first-character forcing
      retryAttemptIndex: attempt,
      retryCause: cause,
      // Defer sink streaming — caller drives rendering once the
      // recovery returns (typically via the supervisor block's
      // slowStreamSpeech path).
      deferStreaming: true,
    };
    if (temperature !== undefined) {
      phaseTwoOpts.temperature = temperature;
    }
    result = await runPhaseTwo(phaseTwoOpts);
    // Keep climbing the ladder on a slot-only completion too — accepting the
    // first `{需要说的话}` would spend the retries and still commit garbage.
    const next = retryCause(result.text);
    if (next === undefined) break;
    cause = next;
  }
  return result;
}

/**
 * Empty-thought recovery ladder. Mirrors `recoverEmptySpeech` for the
 * thought surface — up to `EMPTY_SPEECH_RETRY_TEMPERATURES.length`
 * (the same ladder is reused; the temperature trajectory works equally
 * well for both surfaces) attempts of phase-2 thought with
 * `isThoughtRetry: true` and a rising temperature.
 *
 * Each attempt uses a different `PHASE_TWO_THOUGHT_RETRY_HINTS`
 * variant (base / specific-anchor / mechanical-force) — varying the
 * hint angle gives the model a different framing to break out of the
 * deterministic-empty-output rut, complementing the temperature bump.
 *
 * Exits as soon as the model produces non-empty content, OR returns
 * the final empty result after exhausting the ladder. The caller
 * (actor's main loop's empty-thought branch) handles the still-empty
 * case by incrementing `consecutiveEmptyThoughtIters` and forcing
 * speech on the next iteration.
 *
 * Always returns `{ surface: "thought", text }`.
 */
async function recoverEmptyThought(opts: {
  deps: ActorTurnDeps;
  record: TerminalRecord;
  priorTurnLength: number;
  signal: AbortSignal;
  recap?: string;
  recapBoundaryIndex?: number;
  /** What the attempt that sent us here did wrong; recomputed after every
   *  attempt, exactly as on the speech ladder. */
  cause?: RetryCause;
}): Promise<{ surface: Surface; text: string }> {
  let cause: RetryCause = opts.cause ?? "empty";
  let result: { surface: Surface; text: string } = {
    surface: "thought",
    text: "",
  };
  for (
    let attempt = 0;
    attempt < EMPTY_SPEECH_RETRY_TEMPERATURES.length;
    attempt += 1
  ) {
    const temperature = EMPTY_SPEECH_RETRY_TEMPERATURES[attempt];
    const phaseTwoOpts: Parameters<typeof runPhaseTwo>[0] = {
      deps: opts.deps,
      record: opts.record,
      priorTurnLength: opts.priorTurnLength,
      surface: "thought",
      signal: opts.signal,
      isThoughtRetry: true,
      retryAttemptIndex: attempt,
      retryCause: cause,
      ...(opts.recap !== undefined ? { recap: opts.recap } : {}),
      recapBoundaryIndex: opts.recapBoundaryIndex ?? 0,
      // Thought streams write the "(思考中…)" indicator via the sink
      // begin/end protocol; no deferral. Subsequent ladder attempts
      // re-emit the indicator on each call — harmless since the
      // sink's endHertaStream clears it before the next begin.
    };
    if (temperature !== undefined) {
      phaseTwoOpts.temperature = temperature;
    }
    result = await runPhaseTwo(phaseTwoOpts);
    // Slot-only counts as unusable here too: a placeholder thought never
    // reaches the user, but it lands in the record and therefore in next
    // turn's prompt, where it reads as something she actually thought.
    const next = retryCause(result.text);
    if (next === undefined) break;
    cause = next;
  }
  return result;
}

/**
 * Phase 2 — Slice 13 two-phase generation. Builds a fresh prompt with
 * the attached meta-think section spliced in at the right position
 * (see `serializeActorPrompt` in `actor-prompt.ts`), forces the open
 * tag for the resolved surface, omits the `〔接下来〕` hint, and streams
 * content.
 * Used for both regular iterations and forced-speech (soft-guard)
 * cases.
 *
 * SPEC v0.2 Slice 13 §7.2, §7.3.
 */
async function runPhaseTwo(opts: {
  deps: ActorTurnDeps;
  record: TerminalRecord;
  priorTurnLength: number;
  surface: Surface;
  signal: AbortSignal;
  /**
   * Long-session recap + boundary, computed once per turn by the main
   * loop and threaded through unchanged. The recap is about OLD dialogue
   * (history before this turn) and is therefore orthogonal to the surface
   * being generated; every retry / recovery / veto path reuses the same
   * value. Defaults to no compaction (`recapBoundaryIndex: 0`).
   */
  recap?: string;
  recapBoundaryIndex?: number;
  /**
   * When true, this is a retry call after the first attempt returned
   * an empty body. Uses `PHASE_TWO_SPEECH_RETRY_HINT` instead of the
   * standard hint, and is only valid for `surface: "speech"`. The
   * caller is expected to retry at most once.
   */
  isSpeechRetry?: boolean;
  /**
   * When true, this is a retry call after the first phase-2 thought
   * attempt returned an empty body (model emitted `（/我 想）` at
   * position 0). Uses `PHASE_TWO_THOUGHT_RETRY_HINT` instead of the
   * standard thought hint, and is only valid for `surface: "thought"`.
   * The caller is expected to retry at most once; if the retry also
   * returns empty, the actor bails to speech for the iteration.
   */
  isThoughtRetry?: boolean;
  /**
   * When set, this call is a supervisor-veto retry. Uses
   * `buildSupervisorVetoHint(supervisorVetoReason)` as the format
   * hint with the reason interpolated. Mutually exclusive with
   * `isSpeechRetry`; if both happen to be set, supervisorVetoReason
   * wins (defensive choice).
   */
  supervisorVetoReason?: string;
  /**
   * When set (and `surface === "thought"`), this call is the rethink
   * stage of the two-stage veto recovery (2026-07-18 rethink-respeak):
   * a FRESH （我 想） that digests the veto reason before the respeak.
   * Uses `buildSupervisorVetoHint(hints.supervisorRethinkTemplate,
   * reason)` — a DOMAIN-NEUTRAL hint that fits receipts vetoes and
   * register vetoes alike (the single-stage veto hint is receipts-
   * flavored and measurably derails non-coding redos; see
   * scripts/respeak-lab.mjs).
   */
  supervisorRethinkReason?: string;
  /**
   * When true (and `surface === "speech"`), this is the respeak stage
   * AFTER a committed rethink thought. Uses the slim static
   * `hints.supervisorRespeak` hint — the veto reason itself lives in
   * the fresh thought already spliced into the record. Mutually
   * exclusive with `supervisorVetoReason` (the reason-bearing hint
   * wins if both are set, defensively).
   */
  isPostRethinkRespeak?: boolean;
  /**
   * When set, the rejected speech body from the prior (vetoed) phase-2
   * speech attempt. The serializer wraps it in `（我 说）...（/我 说）`
   * and splices it after the meta-think section and before the
   * veto-format-hint, so the retry can see what it just said. NEVER
   * persisted — recomputed per retry call.
   *
   * SPEC v0.2 Supervisor design §6.5.
   */
  vetoedSpeech?: string;
  /**
   * When true (and `surface === "speech"`), do not stream the output
   * to `deps.sink` during this call. Used by the actor's main loop to
   * defer rendering until the supervisor verdict is known: on OK, the
   * caller replays the buffered text to the sink; on veto, it is
   * discarded silently and the retry streams normally. NEVER applied
   * when `surface === "thought"` — the thought indicator must still
   * appear during the supervisor wait. Defaults to false.
   *
   * SPEC v0.2 Supervisor design §6.6.
   */
  deferStreaming?: boolean;
  /**
   * Sampling temperature forwarded verbatim to the provider's
   * `streamCompletion` request. `undefined` (the default) uses the
   * provider/model's baked-in default. Currently set by the actor's
   * empty-speech retry ladder which bumps temperature on successive
   * retries (see `EMPTY_SPEECH_RETRY_TEMPERATURES`) to break the model
   * out of a deterministic empty-output trap.
   */
  temperature?: number;
  /**
   * Zero-based attempt index for retry-hint variant selection. Only
   * consulted when `isSpeechRetry === true` OR `isThoughtRetry ===
   * true`. Picks from `PHASE_TWO_SPEECH_RETRY_HINTS[idx]` / the
   * matching thought array — variant 0 is the base "you closed
   * empty" hint, variant 1 anchors on a specific point in the user's
   * message, variant 2 escalates to mechanical first-character
   * forcing. Out-of-range indexes (including `undefined`) fall back
   * to variant 0.
   *
   * Aligned with `EMPTY_SPEECH_RETRY_TEMPERATURES` so the hint
   * variation and temperature bump step together per attempt.
   */
  retryAttemptIndex?: number;
  /**
   * Which speech-retry ladder to draw the hint from — i.e. what the
   * attempt that triggered this retry actually did wrong. Only consulted
   * when `isSpeechRetry === true`; defaults to the empty ladder, which is
   * the historical behaviour and the far more common failure.
   */
  retryCause?: RetryCause;
  /**
   * Live-feed sink for the supervised first-pass speech (SPEC §4). When set,
   * safe-boundary chunks stream to it as they generate (instead of
   * `deferStreaming` buffering silently). Mutually exclusive with
   * `deferStreaming`; only valid for `surface: "speech"`.
   */
  onLiveToken?: (chunk: string) => void;
}): Promise<{ surface: Surface; text: string }> {
  const retryIdx = opts.retryAttemptIndex ?? 0;
  const isRetry = opts.isThoughtRetry === true || opts.isSpeechRetry === true;
  // Final-retry body seed: only applies on the LAST attempt of the
  // retry ladder (highest retry index = ladder length - 1). Earlier
  // retries get a fresh chance without the seed so the model can
  // produce naturally-flowing content first. See
  // `FINAL_RETRY_BODY_SEED` JSDoc for the rationale.
  const isFinalRetryAttempt =
    isRetry && retryIdx === EMPTY_SPEECH_RETRY_TEMPERATURES.length - 1;
  const bodySeed = isFinalRetryAttempt ? FINAL_RETRY_BODY_SEED : undefined;

  const hints = resolveHints(opts.deps);
  let formatHint: string;
  if (opts.surface === "thought") {
    if (opts.supervisorRethinkReason !== undefined) {
      formatHint = buildSupervisorVetoHint(
        hints.supervisorRethinkTemplate,
        opts.supervisorRethinkReason,
      );
    } else if (opts.isThoughtRetry === true) {
      // Two ladders here as well — see the speech branch below. A thought
      // that came back as a placeholder did not "close with nothing in it",
      // so the empty ladder's accusation would be wrong in the same way.
      const ladder =
        opts.retryCause === "slot"
          ? hints.thoughtSlotRetry
          : hints.thoughtRetry;
      formatHint = ladder[retryIdx] ?? ladder[0];
    } else {
      formatHint = hints.phase2Thought;
    }
  } else if (opts.supervisorVetoReason !== undefined) {
    formatHint = buildSupervisorVetoHint(
      hints.supervisorVetoTemplate,
      opts.supervisorVetoReason,
    );
  } else if (opts.isPostRethinkRespeak === true) {
    formatHint = hints.supervisorRespeak;
  } else if (opts.isSpeechRetry === true) {
    // Two ladders, picked by WHAT WENT WRONG on the attempt that triggered
    // this retry (2026-08-12). The empty ladder accuses the model of closing
    // early and demands "not blank"; that is the wrong correction for a
    // placeholder, which is not blank at all. `recoverEmptySpeech`
    // recomputes the cause after every attempt, so a run that starts empty
    // and turns into a slot switches ladders mid-flight.
    const ladder =
      opts.retryCause === "slot" ? hints.speechSlotRetry : hints.speechRetry;
    formatHint = ladder[retryIdx] ?? ladder[0];
  } else {
    formatHint = hints.phase2Speech;
  }
  const docPrompt: ActorPrompt = {
    staticPrefix: opts.deps.staticPrefix,
    record: opts.record,
    priorTurnLength: opts.priorTurnLength,
    attachedMetaThink: opts.deps.attachedMetaThink,
    metaThinkSurface: opts.surface,
    formatHint,
    openTag: opts.surface === "thought" ? "（我 想）" : "（我 说）",
    ...(bodySeed !== undefined ? { openTagSuffix: bodySeed } : {}),
    ...(opts.vetoedSpeech !== undefined
      ? { replayBlock: `（我 说）\n${opts.vetoedSpeech}\n（/我 说）` }
      : {}),
    ...(opts.recap !== undefined ? { recap: opts.recap } : {}),
    recapBoundaryIndex: opts.recapBoundaryIndex ?? 0,
    lang: opts.deps.lang ?? "zh",
  };
  const prompt = serializeActorPrompt(docPrompt);
  opts.deps.onPrompt?.("phase2", prompt);

  // Defer the sink for supervised speech that buffers (no live feed); a live
  // feed routes chunks to onLiveToken instead and the controller owns rendering.
  const liveFeeding =
    opts.onLiveToken !== undefined && opts.surface === "speech";
  const effectiveSink =
    liveFeeding || (opts.deferStreaming === true && opts.surface === "speech")
      ? undefined
      : opts.deps.sink;

  let result = await consumePhaseTwoStream({
    provider: opts.deps.provider,
    model: opts.deps.model,
    prompt,
    surface: opts.surface,
    signal: opts.signal,
    ...(effectiveSink !== undefined ? { sink: effectiveSink } : {}),
    ...(liveFeeding ? { onLiveToken: opts.onLiveToken } : {}),
    ...(opts.temperature !== undefined
      ? { temperature: opts.temperature }
      : {}),
  });
  // Dump shows the prompt (with the seed already in the open tag if
  // any) + the model's RAW response. The seed is NOT in result.text
  // yet at this point — the consumer only sees the model's text-
  // delta bytes, not the prompt's open-tag-suffix.
  // Raw output goes to the trace BEFORE any repair, so a hint echo stays
  // visible in the dump rather than being silently cleaned up.
  opts.deps.onPrompt?.("phase2-out", `${prompt}${result.text}`);
  // Hint-echo repair (live lab 2026-08-12). runPhaseTwo is the single funnel
  // for every actor generation — first pass, both ladders, rethink, respeak —
  // so repairing here means the usability checks, the ladders and the commit
  // guards downstream all see de-scaffolded text. Ordering is load-bearing in
  // both directions: BEFORE the body seed below (which would otherwise prefix
  // `……` onto a bracket and stop it matching), and before the callers'
  // isUnusableBlock checks (so `〔{需要说的话}〕` unwraps and is then caught
  // as a slot instead of committing).
  const repaired = stripHintScaffolding(result.text);
  if (repaired !== result.text) {
    result = { surface: result.surface, text: repaired };
  }
  // Final-retry body seed: prepend the seed to the committed body
  // so:
  //   - If the model continued after `……`: body is `……{continuation}`.
  //   - If the model closed immediately (model didn't take the cue
  //     in the prompt either): body is just `……` — a non-empty
  //     Herta-voice fallback (dismissive trailing-off / silent
  //     contemplation) instead of the previous silent-failure mode.
  // The seed becomes part of the streamed render too — downstream
  // slow-stream / unified-replay consume `result.text` which now
  // includes the seed at the start.
  if (bodySeed !== undefined) {
    // A slot-only body is DISCARDED rather than prefixed (2026-08-12).
    // `……{需要说的话}` is no longer whole-string slot-shaped, so it would
    // sail past the commit-boundary guard and put the placeholder on screen
    // with an ellipsis in front of it. Dropping it lets the seed stand alone
    // — which is exactly the graceful non-empty fallback this seed exists to
    // provide, and a better end-of-ladder outcome than a dropped turn.
    const body = isPlaceholderOnly(result.text) ? "" : result.text;
    return { surface: result.surface, text: `${bodySeed}${body}` };
  }
  return result;
}

/**
 * Stream phase 2's content. Stop sequences: close tags only (no
 * need for surface-open tags — the surface is forced in the prompt).
 * Uses deferred-begin pattern from Slice 10 hotfix.
 */
async function consumePhaseTwoStream(opts: {
  provider: CompletionProviderAdapter;
  model: string;
  prompt: string;
  surface: Surface;
  signal: AbortSignal;
  sink?: ActorStreamingSink;
  /**
   * Sampling temperature passed verbatim to the provider's
   * `streamCompletion` request. `undefined` (the default) means the
   * provider/model uses its baked-in default (DeepSeek's chat default
   * is 1.3 per their public parameter-settings guide). Used by the
   * empty-speech retry ladder in the actor's main loop, which bumps
   * the temperature on each successive retry to break the model out
   * of a deterministic empty-output trap.
   */
  temperature?: number;
  /**
   * Live-feed sink (SPEC live-feed-supervised-reveal §4). When set, safe-boundary
   * chunks are pushed here (paced by a LiveSlowStreamController) INSTEAD of the
   * immediate `sink.streamHertaToken`. Mutually exclusive with `sink` — the live
   * controller owns begin/render. Leading/trailing-whitespace handling still
   * applies, so the controller never receives the blank line above the speech.
   */
  onLiveToken?: (chunk: string) => void;
}): Promise<{
  surface: Surface;
  text: string;
}> {
  let buffered = "";
  let emittedTail = 0;
  let beginCalled = false;
  // Tracks whether at least one non-whitespace char has reached the
  // sink. Until true, leading whitespace in the body (the `\n` after
  // the open tag, per the corpus format) is held back so the user
  // doesn't see a blank line above Herta's speech. After it goes
  // true, trailing-whitespace runs are held back too — a run that
  // ends the stream gets dropped; a run followed by more non-ws gets
  // emitted as internal whitespace on the next chunk.
  let bodyStarted = false;

  /**
   * Both speech and thought require non-whitespace to begin. The
   * leading-ws skip in `flushToSink` ensures `streamHertaToken` is
   * never called with a whitespace-only prefix; this guard mirrors
   * the same rule for `beginHertaStream`. Pre-2026-05-23, speech
   * allowed any chunk (including whitespace) to begin, which
   * produced the blank-line-above-speech artifact.
   */
  const shouldBegin = (_s: Surface, chunk: string): boolean => {
    return chunk.trim().length > 0;
  };

  const ensureBegin = (s: Surface, chunk: string): void => {
    if (!beginCalled && shouldBegin(s, chunk) && opts.sink !== undefined) {
      opts.sink.beginHertaStream(s);
      beginCalled = true;
    }
  };

  /**
   * Stream `buffered.slice(emittedTail, safeEnd)` to the sink with
   * leading-ws skip + trailing-ws hold-back.
   */
  const flushToSink = (safeEnd: number): void => {
    if (opts.sink === undefined && opts.onLiveToken === undefined) {
      return; // pure defer/buffer: nothing to emit
    }
    if (safeEnd <= emittedTail) return;
    let start = emittedTail;
    if (!bodyStarted) {
      while (start < safeEnd && /\s/.test(buffered.charAt(start))) {
        start++;
      }
      if (start >= safeEnd) {
        emittedTail = safeEnd;
        return;
      }
      bodyStarted = true;
    }
    let end = safeEnd;
    while (end > start && /\s/.test(buffered.charAt(end - 1))) {
      end--;
    }
    if (end > start) {
      // Slice 4 (streamed == committed): drop complete stray open tags —
      // see consumeBranchStream. Also keeps the live-feed `retryAccum`
      // (fed from onLiveToken) consistent with the stripped commit text,
      // so the retract floor indexes exactly what is on screen.
      const chunk = stripStrayFromChunk(
        buffered.slice(start, end),
        opts.surface,
      );
      if (chunk.length === 0) {
        emittedTail = end; // the slice was one whole stray tag — consume it
        return;
      }
      if (opts.onLiveToken !== undefined) {
        // Live path: the LiveSlowStreamController owns begin/render.
        opts.onLiveToken(chunk);
      } else if (opts.surface === "speech") {
        ensureBegin(opts.surface, chunk);
        if (beginCalled && opts.sink !== undefined) {
          opts.sink.streamHertaToken(chunk);
        }
      } else {
        ensureBegin(opts.surface, chunk);
      }
      emittedTail = end;
    }
  };

  for await (const ev of opts.provider.streamCompletion(
    {
      model: opts.model,
      prompt: opts.prompt,
      stop: [STOP_SPEECH_CLOSE, STOP_THOUGHT_CLOSE, STOP_OPENER_USER],
      // Capped (slice 3); the supervisor call is deadline-only by design —
      // see PRIMARY_COMPLETION_MAX_TOKENS.
      maxTokens: PRIMARY_COMPLETION_MAX_TOKENS,
      ...(opts.temperature !== undefined
        ? { temperature: opts.temperature }
        : {}),
    },
    opts.signal,
  )) {
    if (ev.type === "text-delta") {
      buffered += ev.text;
      // LIVE_EMIT_HOLD_SEQS also holds partial STRAY tags (slice 4).
      // firstStopIndex caps the emit at any COMPLETE stop marker a
      // misbehaving provider streamed past (fence-fuzz, 2026-07-09).
      flushToSink(
        Math.min(
          safeEmitBoundary(buffered, LIVE_EMIT_HOLD_SEQS),
          firstStopIndex(buffered, STOP_SEQS),
        ),
      );
    } else if (ev.type === "finish") {
      break;
    }
  }

  // See consumeBranchStream: cut exactly at the FIRST complete stop marker
  // when one exists (matching the live emit cap, so streamed == committed;
  // prose ending in `（` right before the marker survives), else strip a
  // dangling partial marker prefix left by a stream that ended mid-marker.
  const phase2StopIdx = firstStopIndex(buffered, STOP_SEQS);
  const withoutClose =
    phase2StopIdx < buffered.length
      ? buffered.slice(0, phase2StopIdx)
      : stripDanglingStopPrefix(buffered, STOP_SEQS);
  // Trim the committed body so the record matches what reached the
  // sink (the streaming-time skip + hold-back) char-for-char.
  const cleanText = withoutClose.trim();

  if (
    (opts.sink !== undefined || opts.onLiveToken !== undefined) &&
    emittedTail < withoutClose.length
  ) {
    let start = emittedTail;
    let end = withoutClose.length;
    if (!bodyStarted) {
      while (start < end && /\s/.test(withoutClose.charAt(start))) {
        start++;
      }
      if (start < end) bodyStarted = true;
    }
    while (end > start && /\s/.test(withoutClose.charAt(end - 1))) {
      end--;
    }
    if (end > start) {
      // Slice 4: strip a boundary-held complete stray tag + re-trim the
      // exposed trailing whitespace — see consumeBranchStream's tail flush.
      const tailChunk = stripStrayFromChunk(
        withoutClose.slice(start, end),
        opts.surface,
      ).replace(/\s+$/, "");
      if (tailChunk.length > 0) {
        if (opts.onLiveToken !== undefined) {
          // Live path: the LiveSlowStreamController owns begin/render.
          opts.onLiveToken(tailChunk);
        } else if (opts.surface === "speech") {
          ensureBegin(opts.surface, tailChunk);
          if (beginCalled && opts.sink !== undefined) {
            opts.sink.streamHertaToken(tailChunk);
          }
        } else {
          ensureBegin(opts.surface, tailChunk);
        }
      }
    }
  }

  if (beginCalled) opts.sink?.endHertaStream();

  return { surface: opts.surface, text: cleanText };
}

/**
 * Detect surface from buffered chars. Returns "thought" / "speech" as soon
 * as the surface tag's distinguishing character is visible; returns null
 * if not enough chars yet.
 */
function detectSurface(buffered: string): Surface | null {
  // The model completes with `想）...` or `说）...` (the open tag `（我 `
  // is in the prompt). Whitespace tolerance: skip leading whitespace.
  const trimmedStart = buffered.replace(/^[\s　]+/, "");
  if (trimmedStart.length === 0) return null;
  const first = trimmedStart.charAt(0);
  if (first === "想") return "thought";
  if (first === "说") return "speech";
  // Any other first char — defensively call it speech (malformed completion).
  return "speech";
}

/**
 * Factory for the in-turn beat firer. Extracted so user-`@板砖` pre-empt
 * and Herta-`@板砖` main-loop dispatch share the same beat logic.
 *
 * Uses a deferred-begin pattern: `beginHertaStream("speech")` is NOT called
 * at the top of the function. Instead it is deferred until the first actual
 * token is safe to emit. This makes begin/end calls perfectly symmetric:
 * if the beat body is empty (provider returned only the stop sequence),
 * `beginHertaStream` is never called and neither is `endHertaStream`, so the
 * renderer's `streamingSurface` and cursor remain untouched across the
 * null-return path.
 */
function makeFireBeat(
  deps: ActorTurnDeps,
  priorTurnLength: number,
  recap: string | undefined,
  recapBoundaryIndex: number,
): BeatFirer {
  return async (currentRecord, trigger, abortSignal) => {
    // Beats are always speech surface; the doc's `metaThinkSurface`
    // picks `preSpeakText` and `beforeSpeakIndex` accordingly.
    //
    // Per-trigger hint (N5, 2026-05-23): pick a hint tailored to the
    // event that triggered this beat. `patch.preview:first` steers
    // toward "one-line take on the diff"; `verification.finished`
    // toward "passed/failed verdict"; `tool.fail:*` toward "cold
    // restatement of the failure". Unknown triggers fall back to the
    // generic speech hint — degrades gracefully to pre-N5 behavior.
    //
    // Fresh-window verbatim (M-projection-1, 2026-07-04; supersedes the
    // blanket N6b `compressDiffs: false` + compaction opt-out): the beat
    // is firing because a substantive backend event just landed
    // (typically a `patch.preview` with a fresh diff), and Herta needs
    // the FULL output of THIS invocation to comment substantively —
    // "看 diff 的形状是不是干净" can't work on a 19-line preview.
    // `verbatimSinceLastDispatch` keeps everything after the prior
    // dispatch's done-marker verbatim while EARLIER dispatches stay
    // compressed + compacted, exactly like the main turns see them —
    // the old global opt-outs re-expanded every prior dispatch's diffs
    // and board output into every beat prompt, tokens that grew with
    // each dispatch and slowed the beat's TTFT. The full record stays
    // in the in-memory `TerminalRecord` and the JSONL either way.
    const beatDoc: ActorPrompt = {
      staticPrefix: deps.staticPrefix,
      record: currentRecord,
      priorTurnLength,
      attachedMetaThink: deps.attachedMetaThink,
      metaThinkSurface: "speech",
      formatHint: selectBeatHint(resolveHints(deps), trigger.signature),
      openTag: FORCED_SPEECH_OPEN_TAG,
      verbatimSinceLastDispatch: true,
      // Long-session recap (computed once per turn). Orthogonal to the
      // fresh-board compaction toggled off above: the recap summarizes
      // OLD dialogue (history before this turn), while the beat reacts
      // to a brand-new event in the verbatim window. The boundary only
      // drops blocks below `recapBoundaryIndex`, all of which predate
      // the event the beat is commenting on.
      ...(recap !== undefined ? { recap } : {}),
      recapBoundaryIndex,
      lang: deps.lang ?? "zh",
    };
    const beatPrompt = serializeActorPrompt(beatDoc);
    deps.onPrompt?.("beat", beatPrompt);

    let beatBuffered = "";
    let beatEmittedTail = 0;
    let beginCalled = false; // deferred until first emit
    const beatStops = [STOP_SPEECH_CLOSE, STOP_OPENER_USER] as const;

    try {
      for await (const ev of deps.provider.streamCompletion(
        {
          model: deps.model,
          prompt: beatPrompt,
          // Beats are short reactive utterances; they don't carry
          // inline tool calls in practice. If a beat ever DID emit one
          // we'd lack the parallel-supervisor coordination that the
          // main loop has — keep beats simple, no mid-stream watcher.
          // Include `STOP_OPENER_USER` so a runaway beat that
          // hallucinates the user's next message (`（开拓者 说）...`)
          // halts immediately, same as the main-loop streams.
          stop: [STOP_SPEECH_CLOSE, STOP_OPENER_USER],
          // Backstop, not the primary terminator: the `（/我 说）` close marker
          // (a stop sequence) ends a well-behaved beat well under this cap — a
          // one/two-line Chinese reaction + marker is ~15-40 tokens. The cap
          // only bites a runaway beat that never closes. Raised 100 → 220
          // (2026-06-28) so a slightly longer beat (e.g. a fuller take on a
          // diff) finishes its sentence AND the close marker instead of being
          // cut at finish_reason=length and leaking a dangling `（/`
          // (stripDanglingStopPrefix below still cleans that residual case).
          // History: 60 was too tight (truncated the marker), then 100. Kept as
          // a guard so a misbehaving beat can't run to DeepSeek's ~4096 default
          // mid-backend-work — beats stay short by design, not just by hint.
          maxTokens: 220,
        },
        abortSignal,
      )) {
        if (ev.type === "text-delta") {
          beatBuffered += ev.text;
          if (deps.sink !== undefined) {
            // firstStopIndex caps the emit at any COMPLETE stop marker a
            // misbehaving provider streamed past (fence-fuzz, 2026-07-09).
            const safeEnd = Math.min(
              safeEmitBoundary(beatBuffered, beatStops),
              firstStopIndex(beatBuffered, beatStops),
            );
            if (safeEnd > beatEmittedTail) {
              // Defer beginHertaStream until just before the first emit so
              // that if no tokens are ever safe to emit we never open the
              // stream and have nothing to balance with endHertaStream.
              if (!beginCalled) {
                deps.sink.beginHertaStream("speech");
                beginCalled = true;
              }
              deps.sink.streamHertaToken(
                beatBuffered.slice(beatEmittedTail, safeEnd),
              );
              beatEmittedTail = safeEnd;
            }
          }
        } else if (ev.type === "finish") {
          break;
        }
      }
    } catch (err) {
      // Beat stream died mid-flight (interrupt, provider error). If nothing
      // reached the sink the beat can be dropped cleanly — rethrow and let
      // the bridge's fire-loop catch handle it (drop / abort-clear). But if
      // tokens WERE emitted the stream MUST settle here: begin-without-end
      // leaks streamingSurface across turns (wrong flush offsets), while
      // end-without-a-committed-block desyncs the sink cursor from the
      // record (endHertaStream claims a record position, per the sink
      // contract). So salvage: end the stream and commit exactly the text
      // already on screen as the beat block — screen == record, the same
      // convergence rule the interrupt path applies to backend blocks
      // (hang audit 2026-07-09, M1).
      if (!beginCalled) throw err;
      deps.sink?.endHertaStream();
      const salvaged = beatBuffered.slice(0, beatEmittedTail);
      deps.onPrompt?.(
        "beat-out",
        `${beatPrompt}${salvaged}[salvaged: ${String(err)}]`,
      );
      const trimmedSalvage = salvaged.trim();
      return {
        kind: "herta",
        surface: "speech",
        text: neutralizeBanzhuanTrigger(
          sanitizeActorText(
            trimmedSalvage.length > 0 ? trimmedSalvage : salvaged,
            { role: "speech" },
          ),
        ),
      };
    }

    // Cut exactly at the FIRST complete stop marker when one exists
    // (matching the live emit cap — see consumeBranchStream; prose ending
    // in `（` right before the marker survives), else strip a DANGLING
    // partial prefix (a trailing `（/` from a beat truncated mid-marker —
    // still possible even at `maxTokens: 220`; the `.trim()` at commit
    // removes only whitespace, not the leaked prefix).
    const beatStopIdx = firstStopIndex(beatBuffered, beatStops);
    let beatText =
      beatStopIdx < beatBuffered.length
        ? beatBuffered.slice(0, beatStopIdx)
        : stripDanglingStopPrefix(beatBuffered, beatStops);
    deps.onPrompt?.("beat-out", `${beatPrompt}${beatText}`);

    // Beats carry bracketed hints too (beat_verification / beat_patch_preview
    // / beat_tool_fail), so the same echo is possible here. Repair before the
    // slot check below, for the same ordering reason as runPhaseTwo — but
    // ONLY while nothing has streamed (review 2026-08-12): `beatEmittedTail`
    // indexes into the RAW text, so shortening beatText after live emission
    // would make the tail-flush below slice the wrong substring (or skip a
    // tail it still owes) and desync screen from record — the exact
    // invariant the `!beginCalled` guard on the slot check protects. An
    // echoing beat that already streamed keeps today's behaviour: committed
    // exactly as shown, brackets and all — screen == record wins.
    // (beginCalled === false implies beatEmittedTail === 0: the streaming
    // loop sets beginCalled before its first emit.)
    if (!beginCalled) beatText = stripHintScaffolding(beatText);

    // Slot-only beat (2026-08-12). This lane bypasses the supervisor BY
    // DESIGN (see the commit comment below), so the deterministic guards are
    // the only thing standing between a degenerate completion and the record
    // — exactly the argument that already justifies sanitize and trigger
    // neutralization here.
    //
    // Guarded on `!beginCalled`: beats stream LIVE, so once tokens have
    // reached the sink the cursor has advanced and a block MUST be committed
    // at that position — dropping it then would desync screen from record,
    // which is the worse bug the salvage path above exists to prevent. When
    // nothing has been emitted yet (the safe-emit gate held the whole short
    // beat, the common case) the beat can be dropped cleanly, same as the
    // empty case below.
    if (!beginCalled && isPlaceholderOnly(beatText)) {
      return null;
    }

    if (deps.sink !== undefined && beatEmittedTail < beatText.length) {
      // Flush any tail that wasn't emitted during the streaming loop.
      if (!beginCalled) {
        deps.sink.beginHertaStream("speech");
        beginCalled = true;
      }
      deps.sink.streamHertaToken(beatText.slice(beatEmittedTail));
    }

    if (beatText.length === 0) {
      // The provider emitted only the stop sequence (or nothing at all).
      // beginHertaStream was never called → nothing to balance.
      // streamingSurface stays clean; cursor is not advanced. Safe null return.
      return null;
    }

    // Something WAS streamed. We MUST call endHertaStream to reconcile
    // the renderer's cursor + clear its streaming flag — otherwise
    // subsequent flushBlocks calls render at the wrong offset and
    // streamingSurface leaks across turns.
    if (beginCalled) deps.sink?.endHertaStream();

    // For the committed block, prefer the trimmed text (cleaner JSONL
    // entries + cleaner rendered output). Fall back to raw beatText
    // if trim() emptied it — the cursor was already advanced, so a
    // block MUST be committed at that position.
    //
    // Slice 6: beats bypass the supervisor BY DESIGN (a full pass mid-run
    // costs a round-trip exactly where latency shows), so the deterministic
    // guards do the work instead:
    //   - sanitizeActorText neutralizes forged evidence labels / cross-role
    //     delimiters and strips control/bidi chars (the beat lane previously
    //     applied ZERO sanitization — the last unguarded path into the
    //     durable record);
    //   - neutralizeBanzhuanTrigger: a beat must NEVER carry a live dispatch
    //     token — the bridge only fires from main-loop speech, but a live
    //     @板砖 in a committed beat renders a dispatch chip for a run that
    //     never happened and teaches tomorrow's prompts the wrong pattern.
    // The live beat display may briefly show the pre-neutralized token; the
    // commit settles it — same accepted one-char settle as the main loop's
    // cap-suppressed trigger.
    const trimmed = beatText.trim();
    return {
      kind: "herta",
      surface: "speech",
      text: neutralizeBanzhuanTrigger(
        sanitizeActorText(trimmed.length > 0 ? trimmed : beatText, {
          role: "speech",
        }),
      ),
    };
  };
}
