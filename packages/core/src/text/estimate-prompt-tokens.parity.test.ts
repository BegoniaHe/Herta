import { describe, expect, it } from "vitest";
import { estimatePromptTokens } from "./estimate-prompt-tokens.js";

/** The pre-2026-09-03 form (string iterator, one allocation per code
 *  point) — the arithmetic the index loop must reproduce exactly. */
function reference(text: string): number {
  let tokens = 0;
  let asciiRun = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp > 0x7f) {
      tokens += Math.ceil(asciiRun / 4);
      asciiRun = 0;
      tokens += 1;
    } else {
      asciiRun += 1;
    }
  }
  return tokens + Math.ceil(asciiRun / 4);
}

describe("estimatePromptTokens — index-loop parity with the iterator form", () => {
  const samples = [
    "",
    "a",
    "abcd",
    "abcde",
    "汉",
    "汉字测试",
    "mixed 汉字 and ascii 1234567 tails",
    "😀",
    "😀😀😀",
    "emoji 😀 inside 中 text",
    "𠀀 CJK Ext-B and 한글 and Кириллица and العربية",
    "a😀b", // a surrogate pair between ASCII
    "\uD83D", // a lone high surrogate at the end
    "\uDE00", // a lone low surrogate
    "\uD83Dx", // a high surrogate not followed by a low one
    "x".repeat(1000),
    "汉".repeat(1000),
    `${"abc汉".repeat(300)}😀`,
  ];

  it("matches the reference on every sample", () => {
    for (const s of samples) {
      expect(estimatePromptTokens(s), JSON.stringify(s)).toBe(reference(s));
    }
  });

  it("counts a surrogate pair once and an ASCII run ÷4 at the boundaries", () => {
    expect(estimatePromptTokens("😀")).toBe(1);
    expect(estimatePromptTokens("汉")).toBe(1);
    expect(estimatePromptTokens("abcd")).toBe(1);
    expect(estimatePromptTokens("abcde")).toBe(2);
    expect(estimatePromptTokens("ab汉cd")).toBe(3);
  });
});
