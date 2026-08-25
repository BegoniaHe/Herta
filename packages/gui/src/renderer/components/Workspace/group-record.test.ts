import type { TerminalRecordBlock } from "@herta/app-server";
import { describe, expect, it } from "vitest";
import {
  activityChipLabel,
  activityHasTerminalMarker,
  activityRows,
  activitySteps,
  activitySummary,
  groupRecord,
  type SystemBlock,
} from "./group-record.js";

const user = (text: string): TerminalRecordBlock => ({ kind: "user", text });
const herta = (text: string): TerminalRecordBlock => ({
  kind: "herta",
  surface: "speech",
  text,
});
const sys = (
  body: string,
  label: SystemBlock["label"] = "差分协处理器",
  role?: SystemBlock["role"],
  markerSummary?: SystemBlock["markerSummary"],
): SystemBlock => ({
  kind: "system",
  label,
  body,
  ...(role !== undefined ? { role } : {}),
  ...(markerSummary !== undefined ? { markerSummary } : {}),
});

describe("groupRecord", () => {
  it("returns nothing for an empty record", () => {
    expect(groupRecord([])).toEqual([]);
  });

  it("passes user/herta blocks through with their index", () => {
    const items = groupRecord([user("hi"), herta("yo")]);
    expect(items).toEqual([
      { kind: "block", block: user("hi"), index: 0 },
      { kind: "block", block: herta("yo"), index: 1 },
    ]);
  });

  it("folds consecutive system blocks into one activity item keyed by startIndex", () => {
    const items = groupRecord([
      user("go"),
      sys("Reading scripts"),
      sys("Writing a.ts"),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ kind: "block", block: user("go"), index: 0 });
    expect(items[1]).toMatchObject({ kind: "activity", startIndex: 1 });
    if (items[1]?.kind === "activity") expect(items[1].blocks).toHaveLength(2);
  });

  it("splits a run when a herta beat interrupts it", () => {
    const items = groupRecord([sys("Reading"), herta("beat"), sys("Writing")]);
    expect(items.map((x) => x.kind)).toEqual(["activity", "block", "activity"]);
    expect((items[0] as { startIndex: number }).startIndex).toBe(0);
    expect((items[2] as { startIndex: number }).startIndex).toBe(2);
  });

  it("chip label is 差分协处理器 if any block has it, else 系统", () => {
    expect(
      activityChipLabel([sys("x", "系统"), sys("y", "差分协处理器")]),
    ).toBe("差分协处理器");
    expect(activityChipLabel([sys("x", "系统")])).toBe("系统");
  });

  it("summary prefers the structured marker; terminal-marker + steps split out", () => {
    const blocks = [
      sys("Reading"),
      sys("完成 · 2 files", "差分协处理器", "done-marker", {
        kind: "done",
        state: "completed",
        fileCount: 2,
        riskCount: 0,
      }),
    ];
    expect(activitySummary(blocks)).toEqual({
      kind: "structured",
      marker: { kind: "done", state: "completed", fileCount: 2, riskCount: 0 },
    });
    expect(activityHasTerminalMarker(blocks)).toBe(true);
    expect(activitySteps(blocks)).toHaveLength(1);
    expect(activitySteps(blocks)[0]?.body).toBe("Reading");
    expect(activitySummary([sys("Reading")])).toBeNull();
    expect(activityHasTerminalMarker([sys("Reading")])).toBe(false);
  });

  it("summary carries the marker's own at stamp, for the roll-up's recency gate", () => {
    const marker: SystemBlock = {
      ...sys("完成 · 1 file", "差分协处理器", "done-marker", {
        kind: "done",
        state: "completed",
        fileCount: 1,
        riskCount: 0,
      }),
      at: "2026-08-25T10:00:00.000Z",
    };
    expect(activitySummary([marker])).toEqual({
      kind: "structured",
      marker: { kind: "done", state: "completed", fileCount: 1, riskCount: 0 },
      at: "2026-08-25T10:00:00.000Z",
    });
  });

  it("summary falls back to the raw body for a pre-structured done-marker", () => {
    const blocks = [sys("完成 · 2 files", "差分协处理器", "done-marker")];
    expect(activitySummary(blocks)).toEqual({
      kind: "raw",
      text: "完成 · 2 files",
    });
  });

  it("summary reports a noop marker by role alone (no counts to localize)", () => {
    const blocks = [sys("无产出 — …", "差分协处理器", "noop-marker")];
    expect(activitySummary(blocks)).toEqual({ kind: "noop" });
  });
});

/** A patch preview, as the permission rule projects it BEFORE the tool runs. */
const patch = (files: string[], add?: number, del?: number): SystemBlock => ({
  kind: "system",
  label: "系统",
  body: `patch preview: ${files.join(", ")}\n\n\`\`\`diff\n+a\n\`\`\``,
  digest: {
    kind: "patch",
    files,
    ...(add !== undefined ? { add } : {}),
    ...(del !== undefined ? { del } : {}),
  },
});
const op = (
  verb: "Writing" | "Reading" | "Running",
  arg: string,
): SystemBlock => ({
  kind: "system",
  label: "差分协处理器",
  body: `${verb} ${arg}`,
  digest: { kind: "op", verb, arg },
});

describe("activityRows", () => {
  it("folds a patch preview into the write that follows it", () => {
    // The ordering bug in one assertion: the record holds patch-then-write,
    // the rendered row is the write carrying the patch.
    const blocks = [patch(["a.ts"], 11, 1), op("Writing", "a.ts")];
    const rows = activityRows(blocks);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.block.body).toBe("Writing a.ts");
    expect(rows[0]?.patch?.digest).toMatchObject({ kind: "patch", add: 11 });
  });

  it("folds into a Running row too — a heredoc write comes from bash", () => {
    // The minimal contract is the DEFAULT (ADR 0040): a heredoc write is
    // previewed by the bash rule and its operation row reads `Running`.
    // Pairing on the verb `Writing` would have left every one of those diffs
    // stranded above its command.
    const rows = activityRows([
      patch(["notes.md"], 7, 0),
      op("Running", "cat > notes.md << EOF"),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.patch?.digest).toMatchObject({ add: 7 });
  });

  it("leaves a DENIED write's preview as its own row — never mis-attributes it", () => {
    // A denied write publishes its preview and then never starts, so what
    // follows is the failure row. Without the adjacency requirement the
    // orphaned diff would attach itself to the NEXT operation, which is a
    // different file entirely.
    const fail: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "↳ edit_file failed: permission_denied",
      digest: {
        kind: "tool-fail",
        tool: "edit_file",
        code: "permission_denied",
      },
    };
    const rows = activityRows([
      patch(["secret.env"], 3, 0),
      fail,
      op("Writing", "other.ts"),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.patch === undefined)).toBe(true);
    expect(rows[0]?.block.digest?.kind).toBe("patch");
  });

  it("pairs each preview with its own write in a multi-write run", () => {
    const rows = activityRows([
      patch(["a.ts"], 1, 0),
      op("Writing", "a.ts"),
      patch(["b.ts"], 2, 0),
      op("Writing", "b.ts"),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.patch?.digest).toMatchObject({ add: 1 });
    expect(rows[1]?.patch?.digest).toMatchObject({ add: 2 });
  });

  it("a trailing preview survives as its own row", () => {
    // Mid-run: the tool has been permitted but has not started yet.
    const rows = activityRows([op("Reading", "a.ts"), patch(["a.ts"], 1, 0)]);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.block.digest?.kind).toBe("patch");
    expect(rows[1]?.patch).toBeUndefined();
  });

  it("folds a pre-2026-08-25 `skip` preview the same way", () => {
    const legacy: SystemBlock = {
      kind: "system",
      label: "系统",
      body: "patch preview: a.ts\n\n```diff\n+a\n```",
      digest: { kind: "skip" },
    };
    const rows = activityRows([legacy, op("Writing", "a.ts")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.patch).toBe(legacy);
  });

  it("drops terminal markers, like activitySteps", () => {
    const blocks = [
      op("Writing", "a.ts"),
      sys("完成 · 1 file", "差分协处理器", "done-marker"),
    ];
    expect(activityRows(blocks)).toHaveLength(1);
  });
});
