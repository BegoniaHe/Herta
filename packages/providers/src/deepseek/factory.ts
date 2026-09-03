import type { ProviderAdapter } from "@herta/core";
import type { ApiKey } from "../openai-compat/api-key.js";
import { OpenAICompatibleProvider } from "../openai-compat/provider.js";

export interface DeepseekProviderOpts {
  apiKey: ApiKey;
  model?: string;
  baseUrl?: string;
  /** Reasoning effort, sent as `reasoning_effort` with
   *  `thinking: {type:"enabled"}`. Per the official DeepSeek doc (verified
   *  2026-08-03, updated 2026-07-31): deepseek-v4-flash accepts
   *  "low" | "high" | "max"; deepseek-v4-pro currently accepts only
   *  "high" | "max" and maps a sent "low" to "high" SERVER-SIDE — full
   *  three-tier pro support is announced for early August 2026, at which
   *  point a stored "low" starts meaning low with no change here. (For
   *  compatibility the API also maps "medium"/"xhigh" to "high"; we don't
   *  send those.) `false` omits the thinking block entirely. */
  thinking?: false | "low" | "high" | "max";
  temperature?: number;
  maxTokens?: number;
  /** Transport retries per call on 429/5xx (default: the retry loop's own,
   *  currently 2). The BACKEND passes 0 — its turn loop paces retries with
   *  its own policy, and two layers stacked (2026-09-03). */
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export function deepseekProvider(opts: DeepseekProviderOpts): ProviderAdapter {
  const extraBody =
    opts.thinking !== undefined && opts.thinking !== false
      ? {
          thinking: { type: "enabled" },
          reasoning_effort: opts.thinking,
        }
      : undefined;

  return new OpenAICompatibleProvider({
    baseUrl: opts.baseUrl ?? "https://api.deepseek.com",
    apiKey: opts.apiKey,
    model: opts.model ?? "deepseek-v4-pro",
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    extraBody,
    fetchImpl: opts.fetchImpl,
  });
}
