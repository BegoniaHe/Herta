import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentEvent,
  BackgroundHost,
  InMemoryEventBus,
  NoopMemoryManager,
  ReadLedger,
  TodoStore,
} from "@herta/core";
import { afterEach, describe, expect, it } from "vitest";
import { mkTmpWorkspace, type TmpWorkspace } from "../testing/tmp-workspace.js";
import { editFileTool } from "./index.js";

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});

const noopProgress = () => {};

function ctxFor(workspaceRoot: string, reads: ReadLedger) {
  return {
    sessionId: "s",
    signal: new AbortController().signal,
    workspaceRoot,
    reads,
    todos: new TodoStore(),
    bg: new BackgroundHost(),
    bus: new InMemoryEventBus<AgentEvent>(),
    memory: new NoopMemoryManager(),
  };
}

async function recordSha(reads: ReadLedger, abs: string): Promise<string> {
  const buf = await readFile(abs);
  const sha = createHash("sha256").update(buf).digest("hex");
  reads.record(abs, sha);
  return sha;
}

describe("editFileTool", () => {
  it("happy path: applies hunk, updates ledger to new sha, returns diff", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "alpha\nbeta\n" });
    const abs = join(ws.root, "a.txt");
    const reads = new ReadLedger();
    const oldSha = await recordSha(reads, abs);
    const tool = editFileTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "edit_file",
        input: {
          path: "a.txt",
          hunks: [{ search: "alpha", replace: "ALPHA" }],
        },
      },
      ctxFor(ws.root, reads),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    const data = r.data as {
      relPath: string;
      hunkCount: number;
      bytesWritten: number;
      oldSha256: string;
      newSha256: string;
      diff: string;
    };
    expect(data.relPath).toBe("a.txt");
    expect(data.hunkCount).toBe(1);
    expect(data.oldSha256).toBe(oldSha);
    expect(data.diff).toContain("+ALPHA");
    const onDisk = await readFile(abs, "utf-8");
    expect(onDisk).toBe("ALPHA\nbeta\n");
    const expectedNewSha = createHash("sha256")
      .update(Buffer.from(onDisk))
      .digest("hex");
    expect(data.newSha256).toBe(expectedNewSha);
    expect(reads.get(abs)?.sha256).toBe(expectedNewSha);
  });

  it("TOCTOU: file changes between rule-time and run-time → stale_read", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "alpha\n" });
    const abs = join(ws.root, "a.txt");
    const reads = new ReadLedger();
    await recordSha(reads, abs);
    await writeFile(abs, "MUTATED\n");
    const tool = editFileTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "edit_file",
        input: { path: "a.txt", hunks: [{ search: "alpha", replace: "X" }] },
      },
      ctxFor(ws.root, reads),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("stale_read");
    const onDisk = await readFile(abs, "utf-8");
    expect(onDisk).toBe("MUTATED\n");
  });

  it("returns read_required when ledger has no entry", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "alpha\n" });
    const tool = editFileTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "edit_file",
        input: { path: "a.txt", hunks: [{ search: "alpha", replace: "X" }] },
      },
      ctxFor(ws.root, new ReadLedger()),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("read_required");
  });

  it("multi-hunk: applies all in order", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "one\ntwo\nthree\n" });
    const abs = join(ws.root, "a.txt");
    const reads = new ReadLedger();
    await recordSha(reads, abs);
    const tool = editFileTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "edit_file",
        input: {
          path: "a.txt",
          hunks: [
            { search: "one", replace: "ONE" },
            { search: "three", replace: "THREE" },
          ],
        },
      },
      ctxFor(ws.root, reads),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    expect(await readFile(abs, "utf-8")).toBe("ONE\ntwo\nTHREE\n");
  });

  it("does not leave temp files on success", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "alpha\n" });
    const abs = join(ws.root, "a.txt");
    const reads = new ReadLedger();
    await recordSha(reads, abs);
    const tool = editFileTool();
    await tool.run(
      {
        id: "1",
        tool: "edit_file",
        input: { path: "a.txt", hunks: [{ search: "alpha", replace: "X" }] },
      },
      ctxFor(ws.root, reads),
      noopProgress,
    );
    const entries = await readdir(ws.root);
    const stragglers = entries.filter((n) => n.includes("herta-tmp"));
    expect(stragglers).toHaveLength(0);
  });

  it("returns invalid_input for empty hunks (zod)", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "alpha\n" });
    const abs = join(ws.root, "a.txt");
    const reads = new ReadLedger();
    await recordSha(reads, abs);
    const tool = editFileTool();
    const r = await tool.run(
      { id: "1", tool: "edit_file", input: { path: "a.txt", hunks: [] } },
      ctxFor(ws.root, reads),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("invalid_input");
  });

  // 2026-08-24 (codex study, reproduced before the guard was written): the
  // binary sniff only looks for a NUL, which a legacy-encoded source file
  // never has. It decoded to U+FFFD, and because this tool rewrites the WHOLE
  // file from that string, a hunk touching one ASCII line replaced every
  // non-UTF-8 byte in the file — including bytes the patch never went near.
  it("refuses a non-UTF-8 file instead of rewriting its unreadable bytes", async () => {
    ws = await mkTmpWorkspace({ "legacy.c": "" });
    const abs = join(ws.root, "legacy.c");
    // `/* 测试注释 */` in GBK, then an ASCII line. No NUL anywhere.
    const gbkComment = Buffer.from([
      0x2f, 0x2a, 0x20, 0xb2, 0xe2, 0xca, 0xd4, 0xd7, 0xa2, 0xca, 0xcd, 0x20,
      0x2a, 0x2f, 0x0a,
    ]);
    const original = Buffer.concat([
      gbkComment,
      Buffer.from("int main(void){ return 0; }\n", "ascii"),
    ]);
    await writeFile(abs, original);
    const reads = new ReadLedger();
    await recordSha(reads, abs);
    const tool = editFileTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "edit_file",
        input: {
          path: "legacy.c",
          // Touches ONLY the ASCII line — the corruption was never local to
          // the edit, which is what made it so easy to miss.
          hunks: [{ search: "return 0", replace: "return 1" }],
        },
      },
      ctxFor(ws.root, reads),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("non_utf8_file");
    // The decisive assertion: the file is byte-identical afterwards.
    expect(await readFile(abs)).toEqual(original);
  });

  it("summary names the file and counts hunks", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "alpha\n" });
    const abs = join(ws.root, "a.txt");
    const reads = new ReadLedger();
    await recordSha(reads, abs);
    const tool = editFileTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "edit_file",
        input: {
          path: "a.txt",
          hunks: [{ search: "alpha", replace: "ALPHA" }],
        },
      },
      ctxFor(ws.root, reads),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("a.txt");
    expect(r.summary).toContain("1 hunks");
  });
});
