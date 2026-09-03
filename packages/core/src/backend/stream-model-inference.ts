import type { EventBus } from "../event-bus.js";
import type { AgentError } from "../types/errors.js";
import type { AgentEvent } from "../types/events.js";
import type {
  ProviderAdapter,
  ProviderPromptFrame,
} from "../types/provider.js";
import type { ToolCallRequest } from "../types/tool.js";

export interface ModelInferenceResult {
  /** Accumulated text deltas in stream order. */
  text: string;
  /** Accumulated reasoning deltas (for providers that emit them). */
  reasoning: string;
  /** Tool calls the model emitted this inference. Empty if finishReason="stop". */
  toolCalls: ToolCallRequest[];
  /** Why the inference ended. */
  finishReason: "stop" | "tool_calls" | "length" | "error";
  /** All assistant.delta events emitted during this inference, in order.
   * Generator-style callers can re-yield these to expose them through
   * their AsyncGenerator surface. The bus has already received them. */
  deltas: AgentEvent[];
}

export interface ModelInferenceOpts {
  provider: ProviderAdapter;
  frame: ProviderPromptFrame;
  signal: AbortSignal;
  bus: EventBus<AgentEvent>;
  /**
   * Identifies which layer's loop is running. Backend's nested run-coding-task
   * delegation uses "backend"; the top-level Herta actor uses "actor".
   * Populates the `layer` field on emitted `assistant.delta` events.
   */
  layer: "actor" | "backend";
}

/**
 * Streams a single provider inference round. Accumulates text + reasoning +
 * tool-call requests, emitting `assistant.delta` events as text arrives.
 * Returns when the provider emits a `finish` event.
 *
 * Throws `AbortError` if the signal aborts. Other provider failures resolve
 * normally with `finishReason: "error"`; the caller decides how to react
 * (the existing backend turn loop emits a `turn.failed` event in that case).
 */
export async function streamModelInference(
  opts: ModelInferenceOpts,
): Promise<ModelInferenceResult> {
  let text = "";
  let reasoning = "";
  const toolCalls: ToolCallRequest[] = [];
  const deltas: AgentEvent[] = [];
  let finishReason: ModelInferenceResult["finishReason"] = "error";

  for await (const pevent of opts.provider.streamChat(
    opts.frame,
    opts.signal,
  )) {
    if (pevent.type === "text-delta") {
      const event: AgentEvent = {
        type: "assistant.delta",
        layer: opts.layer,
        text: pevent.text,
      };
      opts.bus.publish(event);
      deltas.push(event);
      text += pevent.text;
    } else if (pevent.type === "reasoning-delta") {
      reasoning += pevent.text;
    } else if (pevent.type === "tool-call-request") {
      toolCalls.push(pevent.call);
    } else if (pevent.type === "finish") {
      finishReason = pevent.reason;
      break;
    }
  }

  return { text, reasoning, toolCalls, finishReason, deltas };
}

/**
 * The ONE abort predicate (2026-09-03). Five sites had their own — this
 * name-only check, the providers' wider one, two inline `name ===
 * "AbortError"` tests in the tools — with two definitions between them.
 * This is the wide one: `name === "AbortError"` (a DOMException, a fetch
 * abort, the harness's own constructed errors) OR `code === "ABORT_ERR"`
 * (undici surfaces some interrupts with that code and a different name).
 * Every seam that asks "was this the user's interrupt?" must answer the
 * same way, or one layer re-badges an interrupt as a failure.
 */
export function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === "AbortError" || e.code === "ABORT_ERR";
}

export function toProviderError(err: unknown): AgentError {
  return {
    kind: "provider_failed",
    message: err instanceof Error ? err.message : String(err),
    cause: err,
  };
}
