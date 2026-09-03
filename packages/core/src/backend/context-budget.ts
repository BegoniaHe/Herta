import { estimatePromptTokens } from "../text/estimate-prompt-tokens.js";
import type { BackendPromptFrame } from "../types/prompt.js";
import type { Message, ToolMessage } from "../types/transcript.js";
import { toolMessageContent } from "./tool-message-content.js";

/**
 * Backend prompt budget (ADR 0025 slice 2). DeepSeek V4's window is 1M
 * tokens, so this is NOT overflow defense — it is a WORKING-SET ceiling,
 * the same philosophy as the actor's recap retune (2026-07-17): a prompt
 * that large is a cost/latency/attention problem long before it is an
 * overflow problem, and a coding backend drowning in stale tool output
 * makes worse tool calls. Trimming is deterministic and happens on the
 * per-iteration frame COPY only — the durable in-memory transcript stays
 * complete, so nothing is irreversibly lost and every iteration re-derives
 * the projection from the full record.
 */
export interface BackendPromptBudget {
  /** Working-set ceiling for one provider call's whole estimated frame. */
  readonly budgetTokens: number;
  /** Newest N tool payloads kept verbatim when phase-1 clearing engages. */
  readonly keepRecentToolPayloads: number;
}

export const DEFAULT_BACKEND_PROMPT_BUDGET: BackendPromptBudget = {
  budgetTokens: 200_000,
  keepRecentToolPayloads: 8,
};

/** The wire text itself (2026-09-03): the estimate sizes exactly what the
 *  translate layer sends, not a hand-kept mirror of it. */
function toolResultText(m: ToolMessage): string {
  return toolMessageContent(m.result);
}

function messageText(m: Message): string {
  if (m.role === "user") return m.text;
  if (m.role === "assistant") {
    const calls = m.toolCalls.length > 0 ? JSON.stringify(m.toolCalls) : "";
    return `${m.text}\n${m.reasoningContent ?? ""}\n${calls}`;
  }
  return toolResultText(m);
}

/**
 * Per-message estimates, memoized on message IDENTITY (2026-09-03).
 *
 * The budget re-derives the projection from the whole transcript on every
 * tool call (the statelessness `fitMessagesToBudget` documents), which
 * meant re-stringifying every tool payload and re-walking every character
 * of an up-to-800K-char transcript per iteration — and, once over budget,
 * once more per dropped group. Transcript messages are never mutated after
 * `TranscriptStore` appends them (the phase-1 clear builds a NEW object),
 * so a message's estimate is a fact about that object: a WeakMap keeps it
 * for the object's lifetime and costs nothing when the transcript is
 * discarded. The contract this leans on is pinned by a test.
 */
const messageTokenCache = new WeakMap<Message, number>();

function messageTokens(m: Message): number {
  const cached = messageTokenCache.get(m);
  if (cached !== undefined) return cached;
  const t = estimatePromptTokens(messageText(m)) + 4;
  messageTokenCache.set(m, t);
  return t;
}

export function estimateMessagesTokens(messages: readonly Message[]): number {
  let t = 0;
  for (const m of messages) t += messageTokens(m);
  return t;
}

type FrameBase = Pick<
  BackendPromptFrame,
  "backendSystem" | "scopedRepoInstructions" | "scopedMemory" | "toolSchemas"
>;

/** The frame's INVARIANT part, memoized on the frame object: the turn
 *  loop builds `baseFrame` once per turn and hands the same object to
 *  every iteration (its L2 fix), so the contract text and the tool
 *  schemas are walked once per turn rather than once per tool call. */
const frameBaseTokenCache = new WeakMap<FrameBase, number>();

function frameStaticTokens(frame: FrameBase): number {
  const cached = frameBaseTokenCache.get(frame);
  if (cached !== undefined) return cached;
  const t =
    estimatePromptTokens(frame.backendSystem) +
    estimatePromptTokens(frame.scopedRepoInstructions) +
    estimatePromptTokens(frame.scopedMemory) +
    estimatePromptTokens(JSON.stringify(frame.toolSchemas));
  frameBaseTokenCache.set(frame, t);
  return t;
}

/** Estimated tokens of everything in the frame EXCEPT `messages`. Only the
 *  todo state — which changes between iterations — is walked per call. */
export function estimateFrameBaseTokens(
  frame: FrameBase,
  todoState: string,
): number {
  return frameStaticTokens(frame) + estimatePromptTokens(todoState);
}

const CLEARED_NOTE =
  "old tool output cleared to fit the context budget — re-run the tool if you need it again";

function clearPayload(m: ToolMessage): ToolMessage {
  return {
    ...m,
    result: {
      ok: m.result.ok,
      summary: m.result.summary,
      data: { cleared: true, note: CLEARED_NOTE },
      ...(m.result.error !== undefined ? { error: m.result.error } : {}),
    },
  };
}

function trimMarker(lang: "zh" | "en", droppedGroups: number): Message {
  return {
    role: "assistant",
    text:
      lang === "en"
        ? `(context trimmed: ${droppedGroups} earlier tool iteration(s) removed to fit the budget — the task statement and the todo list above remain authoritative)`
        : `（上下文已裁剪：更早的 ${droppedGroups} 轮工具调用记录已移除；上方的任务说明与任务清单仍然有效。）`,
    toolCalls: [],
    ts: "",
  };
}

export interface FitResult {
  readonly messages: Message[];
  readonly estimatedTokens: number;
  /** Phase 1 engaged: how many old tool payloads were cleared. */
  readonly clearedPayloads: number;
  /** Phase 2 engaged: how many leading groups were dropped. */
  readonly droppedGroups: number;
  /** Even the minimal tail exceeds the budget — caller should fail honestly. */
  readonly overBudget: boolean;
}

/**
 * Split the backend transcript into droppable GROUPS that keep the
 * OpenAI pairing invariant (an assistant message with tool_calls must be
 * followed by its tool replies): each group is one assistant message plus
 * every consecutive tool message after it. Leading orphan messages (never
 * produced today, defensive) form their own group.
 */
function groupMessages(messages: readonly Message[]): Message[][] {
  const groups: Message[][] = [];
  let current: Message[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      if (current.length > 0) groups.push(current);
      current = [m];
    } else if (current.length > 0) {
      current.push(m);
    } else {
      groups.push([m]);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Deterministic two-phase trim to the working-set budget:
 *
 *   Phase 1 — clear OLD tool payloads (keep the newest
 *   `keepRecentToolPayloads` tool messages verbatim; older ones keep
 *   their one-line summary but lose the JSON payload). The summaries
 *   plus the todo list preserve "what have I done" at a fraction of the
 *   cost — the CC microcompact pattern, re-derived.
 *
 *   Phase 2 — drop whole leading groups (assistant + its tool replies),
 *   oldest first, always keeping the final group, and prepend a marker
 *   message saying what was dropped.
 *
 * Pure function over the copied array; the TranscriptStore is never
 * mutated. Re-runs from scratch every iteration, so the projection is
 * stateless and a group cleared this iteration is naturally "uncleared"
 * if a later, smaller frame fits without trimming (it won't grow back
 * in practice — transcripts only grow — but statelessness keeps the
 * logic trivially predictable). Re-running is cheap because the
 * per-message estimates are memoized on identity (above): each `fits()`
 * is a sum over cached numbers, not a walk over the transcript's text.
 */
export function fitMessagesToBudget(opts: {
  messages: readonly Message[];
  baseTokens: number;
  budget: BackendPromptBudget;
  lang: "zh" | "en";
}): FitResult {
  const { baseTokens, budget, lang } = opts;
  let messages = [...opts.messages];

  const fits = (): { est: number; ok: boolean } => {
    const est = baseTokens + estimateMessagesTokens(messages);
    return { est, ok: est <= budget.budgetTokens };
  };

  let { est, ok } = fits();
  if (ok) {
    return {
      messages,
      estimatedTokens: est,
      clearedPayloads: 0,
      droppedGroups: 0,
      overBudget: false,
    };
  }

  // Phase 1: clear old tool payloads, newest keepRecentToolPayloads intact.
  let clearedPayloads = 0;
  const toolIdxs = messages
    .map((m, i) => (m.role === "tool" ? i : -1))
    .filter((i) => i >= 0);
  const clearable = toolIdxs.slice(
    0,
    Math.max(0, toolIdxs.length - budget.keepRecentToolPayloads),
  );
  for (const i of clearable) {
    const m = messages[i];
    if (m === undefined || m.role !== "tool") continue;
    const already = m.result.data as { cleared?: unknown } | undefined;
    if (already !== null && typeof already === "object" && already.cleared)
      continue;
    messages[i] = clearPayload(m);
    clearedPayloads += 1;
  }
  ({ est, ok } = fits());
  if (ok) {
    return {
      messages,
      estimatedTokens: est,
      clearedPayloads,
      droppedGroups: 0,
      overBudget: false,
    };
  }

  // Phase 2: drop leading groups, always keep the last one.
  const groups = groupMessages(messages);
  let droppedGroups = 0;
  while (groups.length > 1) {
    groups.shift();
    droppedGroups += 1;
    messages = [trimMarker(lang, droppedGroups), ...groups.flat()];
    ({ est, ok } = fits());
    if (ok) {
      return {
        messages,
        estimatedTokens: est,
        clearedPayloads,
        droppedGroups,
        overBudget: false,
      };
    }
  }

  return {
    messages,
    estimatedTokens: est,
    clearedPayloads,
    droppedGroups,
    overBudget: true,
  };
}
