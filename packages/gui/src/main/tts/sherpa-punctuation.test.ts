import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { PLACEHOLDERS, toSherpaText, lexiconHasPlaceholders } =
  require("./sherpa-punctuation.cjs") as {
    PLACEHOLDERS: Record<string, string>;
    toSherpaText: (text: string) => string;
    lexiconHasPlaceholders: (lexicon: string) => boolean;
  };

describe("sherpa punctuation placeholders", () => {
  it("uses ideographs inside sherpa's CJK run range, each carrying token symbols", () => {
    for (const [ch, syms] of Object.entries(PLACEHOLDERS)) {
      expect(/^[一-鿿]$/.test(ch), ch).toBe(true);
      expect(syms.split(" ").every((s) => s.length > 0)).toBe(true);
    }
    expect(Object.keys(PLACEHOLDERS)).toHaveLength(10);
  });

  it("substitutes full-width marks, keeps the words, and ends a unit on the bare mark", () => {
    expect(toSherpaText("嗯，这份记录的顺序有问题，把原始版本拿来。")).toBe(
      "嗯鿠这份记录的顺序有问题鿠把原始版本拿来鿧",
    );
    // mid-text enders keep their space form; the final one loses it
    expect(toSherpaText("是你？挑这个时间点！先想：一、二；再说……")).toBe(
      "是你鿢挑这个时间点鿣先想鿥一鿠二鿤再说鿦鿦",
    );
    expect(toSherpaText("不要真去偷！")).toBe("不要真去偷鿩");
    expect(toSherpaText("是你？")).toBe("是你鿨");
  });

  it("substitutes ASCII marks only after a CJK character", () => {
    expect(toSherpaText("代码在 scripts merge sort 点 py，好。")).toBe(
      "代码在 scripts merge sort 点 py鿠好鿧",
    );
    expect(toSherpaText("版本 v1.2 不对.")).toBe("版本 v1.2 不对鿧");
    expect(toSherpaText("Hm, the order is wrong.")).toBe(
      "Hm, the order is wrong.",
    );
  });

  it("recognizes a lexicon only when the rows lead it", () => {
    const rows = Object.entries(PLACEHOLDERS)
      .map(([ch, syms]) => `${ch} ${syms}`)
      .join("\n");
    expect(lexiconHasPlaceholders(`${rows}\n一 ㄧ 1 /\n`)).toBe(true);
    expect(lexiconHasPlaceholders("一 ㄧ 1 /\n")).toBe(false);
    expect(lexiconHasPlaceholders("")).toBe(false);
  });
});
