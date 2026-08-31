import { describe, expect, it } from "vitest";
import { splitBodyAtPath } from "./file-name-target.js";

describe("splitBodyAtPath (ADR 0050 §1)", () => {
  it("splits a localized body around the digest's verbatim path", () => {
    expect(
      splitBodyAtPath("已创建 random-84a57f.txt", "random-84a57f.txt"),
    ).toEqual({
      before: "已创建 ",
      name: "random-84a57f.txt",
      after: "",
    });
    expect(splitBodyAtPath("Writing src/x.ts +2 −0", "src/x.ts")).toEqual({
      before: "Writing ",
      name: "src/x.ts",
      after: " +2 −0",
    });
  });

  it("takes the LAST occurrence — the arg position, not a verb collision", () => {
    const r = splitBodyAtPath("a a/b then a/b", "a/b");
    expect(r?.before).toBe("a a/b then ");
  });

  it("degrades to null when the body no longer carries the path", () => {
    expect(splitBodyAtPath("已创建 something-else.txt", "src/x.ts")).toBeNull();
    expect(splitBodyAtPath("body", "")).toBeNull();
  });
});
