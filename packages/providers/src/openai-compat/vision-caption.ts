import { ProviderError } from "../errors.js";
import type { HttpOpts } from "./http.js";
import { postChatCompletions } from "./http.js";

/**
 * One-shot image captioning over the chat endpoint (ADR 0048 §3).
 *
 * Deliberately NOT part of `ProviderAdapter`. The adapter's `PromptFrame`
 * carries string-content messages, and images ride OpenAI-style content parts
 * — widening the whole transcript union for one sidecar would touch every
 * translate/stream path for a caller that streams nothing, holds no history
 * and asks one question. This is a narrow function over the same retrying
 * POST: body in, one line of text out.
 *
 * Non-streaming on purpose: nothing consumes a caption incrementally, and a
 * single JSON response has no SSE watchdog to reason about.
 */

export interface VisionCaptionRequest {
  /** Harness-owned system prompt — the caller owns the wording, the way the
   *  digest tool's caller owns its prompts (`digestModelFrom`). */
  readonly system: string;
  readonly user: string;
  /** `data:image/png;base64,…`. The API also accepts remote URLs; the harness
   *  never sends one — an attachment is bytes we already hold, and fetching a
   *  URL on the model's behalf is a different (SSRF-shaped) decision. */
  readonly imageDataUri: string;
}

export type VisionCaptioner = (
  req: VisionCaptionRequest,
  signal: AbortSignal,
) => Promise<string>;

export interface VisionCaptionerOpts extends HttpOpts {
  /**
   * Completion budget. Default 1024, and the default is load-bearing: the
   * vision model REASONS before answering (probe 2026-08-27), so a small
   * budget is consumed entirely by the reasoning chain and returns
   * `content: ""` with `finish_reason: "length"` — a silent empty caption
   * rather than an error. Three probe tests were starved this way at 60-300.
   */
  maxTokens?: number;
  temperature?: number;
}

interface CaptionResponse {
  readonly choices?: readonly {
    readonly message?: { readonly content?: unknown };
    readonly finish_reason?: unknown;
  }[];
}

export function visionCaptioner(opts: VisionCaptionerOpts): VisionCaptioner {
  return async (req, signal) => {
    const res = await postChatCompletions(
      opts,
      {
        model: opts.model,
        messages: [
          { role: "system", content: req.system },
          {
            role: "user",
            content: [
              { type: "text", text: req.user },
              { type: "image_url", image_url: { url: req.imageDataUri } },
            ],
          },
        ],
        max_tokens: opts.maxTokens ?? 1024,
        ...(opts.temperature !== undefined
          ? { temperature: opts.temperature }
          : {}),
      },
      signal,
    );

    let json: CaptionResponse;
    try {
      json = (await res.json()) as CaptionResponse;
    } catch (cause) {
      throw new ProviderError({
        code: "sse",
        retryable: false,
        message: "caption response was not JSON",
        cause,
      });
    }

    const choice = json.choices?.[0];
    const content = choice?.message?.content;
    // An empty caption is a FAILURE, never a caption. The caller degrades to
    // "stored, not read" — which is honest — whereas an empty string would
    // reach the record as a block claiming to describe an image while saying
    // nothing about it.
    if (typeof content !== "string" || content.trim() === "") {
      throw new ProviderError({
        code: "sse",
        retryable: false,
        message:
          choice?.finish_reason === "length"
            ? "caption was empty (budget consumed by reasoning)"
            : "caption was empty",
      });
    }
    return content.trim();
  };
}
