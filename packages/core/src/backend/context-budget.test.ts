import { describe, expect, it } from "vitest";
import type { Message } from "../types/transcript.js";
import {
  DEFAULT_BACKEND_PROMPT_BUDGET,
  estimateFrameBaseTokens,
  estimateMessagesTokens,
  fitMessagesToBudget,
} from "./context-budget.js";

describe("estimate memoization (2026-09-03)", () => {
  it("a message's estimate is a fact about the OBJECT — the transcript never mutates one after append", () => {
    // The memo keys on identity. The test pins the contract it leans on:
    // a mutated message keeps its first estimate, so nothing may mutate
    // one (TranscriptStore appends; the phase-1 clear builds a new object).
    const m: Message = {
      role: "assistant",
      text: "汉".repeat(100),
      toolCalls: [],
      ts,
    };
    // 100 CJK + the two "\n" joiners (÷4 → 1) + the 4-token overhead.
    const first = estimateMessagesTokens([m]);
    expect(first).toBe(105);
    (m as { text: string }).text = "汉".repeat(1000);
    expect(estimateMessagesTokens([m])).toBe(first);
    // A new object with the same content is estimated afresh.
    expect(estimateMessagesTokens([{ ...m, text: "汉".repeat(1000) }])).toBe(
      1005,
    );
  });

  it("the frame's invariant part is memoized per frame object; only the todo state is walked per call", () => {
    const frame = {
      backendSystem: "x".repeat(400),
      scopedRepoInstructions: "",
      scopedMemory: "",
      toolSchemas: [],
    };
    const base = estimateFrameBaseTokens(frame, "");
    expect(base).toBe(
      100 + estimateFrameBaseTokens({ ...frame, backendSystem: "" }, ""),
    );
    expect(estimateFrameBaseTokens(frame, "汉".repeat(10))).toBe(base + 10);
    // Same object, same answer — the contract text is not re-walked.
    expect(estimateFrameBaseTokens(frame, "")).toBe(base);
  });
});

const ts = "2026-07-22T00:00:00.000Z";

function assistant(text: string, calls: string[] = []): Message {
  return {
    role: "assistant",
    text,
    toolCalls: calls.map((id) => ({ id, tool: "read_file", input: {} })),
    ts,
  };
}

function tool(id: string, payload: string): Message {
  return {
    role: "tool",
    toolCallId: id,
    result: { ok: true, summary: `did ${id}`, data: { content: payload } },
    ts,
  };
}

/** N groups of (assistant + one fat tool reply). */
function groups(n: number, payloadChars: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(assistant(`step ${i}`, [`c${i}`]));
    out.push(tool(`c${i}`, "x".repeat(payloadChars)));
  }
  return out;
}

describe("fitMessagesToBudget", () => {
  it("passes an under-budget frame through untouched", () => {
    const messages = groups(3, 100);
    const fit = fitMessagesToBudget({
      messages,
      baseTokens: 1_000,
      budget: DEFAULT_BACKEND_PROMPT_BUDGET,
      lang: "zh",
    });
    expect(fit.overBudget).toBe(false);
    expect(fit.clearedPayloads).toBe(0);
    expect(fit.droppedGroups).toBe(0);
    expect(fit.messages).toEqual(messages);
  });

  it("phase 1: clears old tool payloads but keeps the newest K verbatim", () => {
    const messages = groups(6, 4_000); // ~1K tokens per payload
    const fit = fitMessagesToBudget({
      messages,
      baseTokens: 0,
      budget: { budgetTokens: 3_500, keepRecentToolPayloads: 2 },
      lang: "zh",
    });
    expect(fit.overBudget).toBe(false);
    expect(fit.clearedPayloads).toBe(4);
    expect(fit.droppedGroups).toBe(0);
    // Oldest tool message cleared to a summary+marker…
    const first = fit.messages[1];
    expect(first?.role).toBe("tool");
    if (first?.role === "tool") {
      expect(first.result.summary).toBe("did c0");
      expect((first.result.data as { cleared?: boolean }).cleared).toBe(true);
    }
    // …newest kept whole.
    const last = fit.messages[fit.messages.length - 1];
    if (last?.role === "tool") {
      expect((last.result.data as { content?: string }).content?.length).toBe(
        4_000,
      );
    }
  });

  it("phase 2: drops oldest groups, keeps pairing and the final group, prepends a marker", () => {
    // Fat ASSISTANT texts so phase-1 payload clearing cannot save it.
    const messages: Message[] = [];
    for (let i = 0; i < 5; i += 1) {
      messages.push(assistant("a".repeat(8_000), [`c${i}`]));
      messages.push(tool(`c${i}`, "small"));
    }
    const fit = fitMessagesToBudget({
      messages,
      baseTokens: 0,
      budget: { budgetTokens: 5_000, keepRecentToolPayloads: 2 },
      lang: "en",
    });
    expect(fit.overBudget).toBe(false);
    expect(fit.droppedGroups).toBeGreaterThan(0);
    // Marker first, then intact groups.
    const marker = fit.messages[0];
    expect(marker?.role).toBe("assistant");
    if (marker?.role === "assistant") {
      expect(marker.text).toContain("context trimmed");
      expect(marker.toolCalls).toHaveLength(0);
    }
    // Pairing invariant: every assistant-with-calls is immediately followed
    // by its tool replies.
    for (let i = 0; i < fit.messages.length; i += 1) {
      const m = fit.messages[i];
      if (m?.role === "assistant" && m.toolCalls.length > 0) {
        const next = fit.messages[i + 1];
        expect(next?.role).toBe("tool");
        if (next?.role === "tool") {
          expect(next.toolCallId).toBe(m.toolCalls[0]?.id);
        }
      }
    }
    // The final group survived whole.
    const lastTool = fit.messages[fit.messages.length - 1];
    expect(lastTool?.role).toBe("tool");
    if (lastTool?.role === "tool") expect(lastTool.toolCallId).toBe("c4");
  });

  it("reports overBudget when even the minimal tail exceeds the budget", () => {
    const messages = groups(2, 50);
    const fit = fitMessagesToBudget({
      messages,
      baseTokens: 1_000_000, // base frame alone blows the budget
      budget: { budgetTokens: 10_000, keepRecentToolPayloads: 2 },
      lang: "zh",
    });
    expect(fit.overBudget).toBe(true);
  });

  it("is deterministic and does not mutate its input", () => {
    const messages = groups(6, 4_000);
    const snapshot = JSON.parse(JSON.stringify(messages));
    const budget = { budgetTokens: 3_500, keepRecentToolPayloads: 2 };
    const a = fitMessagesToBudget({
      messages,
      baseTokens: 0,
      budget,
      lang: "zh",
    });
    const b = fitMessagesToBudget({
      messages,
      baseTokens: 0,
      budget,
      lang: "zh",
    });
    expect(a).toEqual(b);
    expect(messages).toEqual(snapshot);
  });

  it("estimateMessagesTokens charges CJK ~1 token/char (non-ASCII floor)", () => {
    const ascii = estimateMessagesTokens([assistant("a".repeat(400))]);
    const cjk = estimateMessagesTokens([assistant("汉".repeat(400))]);
    expect(cjk).toBeGreaterThan(ascii * 3);
  });
});
