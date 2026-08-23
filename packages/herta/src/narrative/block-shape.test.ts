import { describe, expect, it } from "vitest";
import {
  isPlaceholderOnly,
  isUnusableBlock,
  retryCause,
  stripHintScaffolding,
} from "./block-shape.js";

describe("isPlaceholderOnly — the reported shape", () => {
  it("catches the line that reached a user verbatim (2026-08-12)", () => {
    expect(isPlaceholderOnly("{需要说的话}")).toBe(true);
  });

  it("catches the slot shapes a completion model reaches for", () => {
    for (const s of [
      "{需要说的话}",
      "{{需要说的话}}",
      `$${"{需要说的话}"}`, // ${…} written so it isn't a template placeholder
      "｛需要说的话｝",
      "<需要说的话>",
      "<<your line here>>",
      "[需要说的话]",
      "[[speech]]",
      "［需要说的话］",
      "%SPEECH%",
      "{}", // empty slot is equally not dialogue
      "<>",
    ]) {
      expect(isPlaceholderOnly(s), s).toBe(true);
    }
  });

  it("ignores whitespace, zero-width padding and trailing punctuation", () => {
    expect(isPlaceholderOnly("  {需要说的话}  ")).toBe(true);
    expect(isPlaceholderOnly("{需要说的话}。")).toBe(true);
    expect(isPlaceholderOnly("​{需要说的话}​")).toBe(true);
  });
});

describe("isPlaceholderOnly — what it must NOT catch", () => {
  it("leaves real speech about code alone — braces INSIDE a sentence", () => {
    for (const s of [
      "把 `{}` 改成 `[]`，然后再跑一遍。",
      "你这个 {a: 1} 的写法在 TS 里过不了。",
      "第 3 行的 <div> 没闭合。",
      "config 里那个 {{no_banzhuan}} 没被替换掉——这是模板的问题，不是我的。",
    ]) {
      expect(isPlaceholderOnly(s), s).toBe(false);
    }
  });

  it("leaves the 被烦版 silence reply alone (mood lab 2026-07-17: by design)", () => {
    expect(isPlaceholderOnly("……")).toBe(false);
    expect(isPlaceholderOnly("。")).toBe(false);
  });

  it("leaves a parenthetical-only line alone — that is the supervisor's rule", () => {
    expect(isPlaceholderOnly("（他没听懂。）")).toBe(false);
  });

  it("does not sweep up a long line that merely begins and ends with a brace", () => {
    expect(isPlaceholderOnly("{ 这是一句话 } 后面还有别的 { 内容 }")).toBe(
      false,
    );
  });

  it("leaves ordinary Herta speech alone", () => {
    for (const s of [
      "站两天算你交了敲门税，比你前辈沉得住气。",
      "@板砖 把那次运行的日志重新翻出来。",
      "记不得了，你说。",
    ]) {
      expect(isPlaceholderOnly(s), s).toBe(false);
    }
  });
});

describe("stripHintScaffolding — echoed 〔hint〕 wrappers (live lab 2026-08-12)", () => {
  it("drops a leading echoed hint line and keeps the real answer", () => {
    // Verbatim from the lab: zh/speech/empty ladder, variant 3.
    const raw =
      '〔从头开始写，选一个词——他叫的是"黑塔女士"，用这个。〕\n黑塔女士？什么时候学会这么客气的叫法了。';
    expect(stripHintScaffolding(raw)).toBe(
      "黑塔女士？什么时候学会这么客气的叫法了。",
    );
  });

  it("unwraps a wholly-bracketed block rather than discarding good content", () => {
    // Verbatim from the lab: zh/thought/empty ladder, variant 2. The thinking
    // inside is genuinely fine — only the wrapper is wrong.
    const raw =
      "〔问死了也没真死。答辩评委提第三问通常是在压好奇心——他手里握着一个他觉得很重要的破绽。〕";
    expect(stripHintScaffolding(raw)).toBe(
      "问死了也没真死。答辩评委提第三问通常是在压好奇心——他手里握着一个他觉得很重要的破绽。",
    );
  });

  it("does NOT rescue junk: a wrapped placeholder still reads as unusable", () => {
    // The composition that matters — stripping runs BEFORE the usability
    // check, so the wrapper cannot hide a slot from the guard.
    expect(stripHintScaffolding("〔{需要说的话}〕")).toBe("{需要说的话}");
    expect(isUnusableBlock(stripHintScaffolding("〔{需要说的话}〕"))).toBe(
      true,
    );
    expect(retryCause(stripHintScaffolding("〔{需要说的话}〕"))).toBe("slot");
    // Hint line first, placeholder as the "answer".
    expect(
      isUnusableBlock(stripHintScaffolding("〔说点什么〕\n{需要说的话}")),
    ).toBe(true);
    // Wrapped emptiness stays empty, not slot.
    expect(retryCause(stripHintScaffolding("〔〕"))).toBe("empty");
  });

  it("drops a TRAILING self-directive and keeps the answer before it (large-document lab 2026-08-23)", () => {
    // Verbatim from the lab: two speeches in one session, each ending in a
    // bracketed instruction the model wrote for its own next step.
    expect(
      stripHintScaffolding(
        "先别催，等我重新让它把输出写到当前目录。 〔到这里，只准停，只准说这一件事。不得启动新任务，不得写任何命令。〕",
      ),
    ).toBe("先别催，等我重新让它把输出写到当前目录。");
    expect(
      stripHintScaffolding(
        "这事不是记得记不得的问题，是没文本可对就别谈精确。 〔这句之后，只准停。`@板砖` 不写：无命令。〕",
      ),
    ).toBe("这事不是记得记不得的问题，是没文本可对就别谈精确。");
    // Leading and trailing together; a trailing pair on junk rescues nothing.
    expect(stripHintScaffolding("〔先说〕台词。〔停〕")).toBe("台词。");
    expect(isUnusableBlock(stripHintScaffolding("{需要说的话}〔停〕"))).toBe(
      true,
    );
  });

  it("leaves ordinary speech untouched, byte for byte", () => {
    for (const s of [
      "记不得了，你说。",
      "@板砖 把那次运行的日志重新翻出来。",
      "他说〔这样〕不行——中间的括号不是脚手架。",
      "……",
    ]) {
      expect(stripHintScaffolding(s), s).toBe(s);
    }
  });

  it("handles more than one stacked hint line", () => {
    expect(stripHintScaffolding("〔一〕\n〔二〕\n真话。")).toBe("真话。");
  });
});

describe("isUnusableBlock — the commit-boundary predicate", () => {
  it("folds emptiness and slot-only into one test", () => {
    expect(isUnusableBlock("")).toBe(true);
    expect(isUnusableBlock("   ")).toBe(true);
    expect(isUnusableBlock("{需要说的话}")).toBe(true);
    expect(isUnusableBlock("记不得了，你说。")).toBe(false);
  });
});
