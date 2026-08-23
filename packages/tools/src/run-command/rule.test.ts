import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentEvent,
  BackgroundHost,
  InMemoryEventBus,
  NoopMemoryManager,
  ReadLedger,
  RulePermissionEngine,
  TodoStore,
} from "@herta/core";
import { FakeAskResolver } from "@herta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { mkTmpWorkspace, type TmpWorkspace } from "../testing/tmp-workspace.js";
import { registerRunCommandRule } from "./rule.js";

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});

async function canCreateFileSymlinks(): Promise<boolean> {
  const probe = await mkdtemp(join(tmpdir(), "herta-rule-symlink-probe-"));
  try {
    await writeFile(join(probe, "t.txt"), "x");
    await symlink(join(probe, "t.txt"), join(probe, "l.txt"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

function ctxFor(workspaceRoot: string) {
  return {
    sessionId: "s",
    signal: new AbortController().signal,
    workspaceRoot,
    reads: new ReadLedger(),
    todos: new TodoStore(),
    bg: new BackgroundHost(),
    bus: new InMemoryEventBus<AgentEvent>(),
    memory: new NoopMemoryManager(),
  };
}

describe("run_command permission rule", () => {
  it("allows allow-list commands", async () => {
    ws = await mkTmpWorkspace({});
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerRunCommandRule(engine);
    const decision = await engine.check(
      { id: "1", tool: "run_command", input: { argv: ["echo", "hi"] } },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("allow");
  });

  it("blocks catastrophic commands with command_blocked", async () => {
    ws = await mkTmpWorkspace({});
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerRunCommandRule(engine);
    const decision = await engine.check(
      { id: "1", tool: "run_command", input: { argv: ["rm", "-rf", "/"] } },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") throw new Error();
    expect(decision.code).toBe("command_blocked");
  });

  it("asks for destructive with risk=workspace_destructive", async () => {
    ws = await mkTmpWorkspace({});
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerRunCommandRule(engine);
    const decision = await engine.check(
      {
        id: "1",
        tool: "run_command",
        input: { argv: ["git", "reset", "--hard"] },
      },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("ask");
    if (decision.kind !== "ask") throw new Error();
    expect(decision.request.risk).toBe("workspace_destructive");
  });

  it("asks for network with risk=network", async () => {
    ws = await mkTmpWorkspace({});
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerRunCommandRule(engine);
    const decision = await engine.check(
      {
        id: "1",
        tool: "run_command",
        input: { argv: ["curl", "https://example.com"] },
      },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("ask");
    if (decision.kind !== "ask") throw new Error();
    expect(decision.request.risk).toBe("network");
  });

  it("asks for unknown with risk=workspace_write", async () => {
    ws = await mkTmpWorkspace({});
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerRunCommandRule(engine);
    const decision = await engine.check(
      {
        id: "1",
        tool: "run_command",
        input: { argv: ["someUnknownThing"] },
      },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("ask");
    if (decision.kind !== "ask") throw new Error();
    expect(decision.request.risk).toBe("workspace_write");
  });

  it("denies with invalid_input for empty argv", async () => {
    ws = await mkTmpWorkspace({});
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerRunCommandRule(engine);
    const decision = await engine.check(
      { id: "1", tool: "run_command", input: { argv: [] } },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") throw new Error();
    expect(decision.code).toBe("invalid_input");
  });

  it("denies with path_denied when cwd is .git", async () => {
    ws = await mkTmpWorkspace({});
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerRunCommandRule(engine);
    const decision = await engine.check(
      {
        id: "1",
        tool: "run_command",
        input: { argv: ["echo", "hi"], cwd: ".git" },
      },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") throw new Error();
    expect(decision.code).toBe("path_denied");
  });

  it("allows a reader over a real in-workspace file (no regression)", async () => {
    ws = await mkTmpWorkspace({ "notes.md": "hi" });
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerRunCommandRule(engine);
    // Plain read, a grep with a PATTERN (not a path), and a nonexistent
    // operand all stay allow — the async guard only acts on existing files.
    for (const argv of [
      ["cat", "notes.md"],
      ["grep", "TODO", "notes.md"],
      ["cat", "does-not-exist.md"],
    ]) {
      const decision = await engine.check(
        { id: "1", tool: "run_command", input: { argv } },
        ctxFor(ws.root),
      );
      expect(decision.kind, argv.join(" ")).toBe("allow");
    }
  });

  it("lets a reader reach an attachment and the harness evidence, but not the rest of .herta (ADR 0033 carve-outs, 2026-08-23)", async () => {
    ws = await mkTmpWorkspace({
      ".herta/attachments/sid/spec-ab12cd34.docx.txt": "hi",
      ".herta/logs/run.log": "exit 0",
      ".herta/tool-results/t/c.json": "{}",
      ".herta/memory/project.jsonl": "{}",
    });
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerRunCommandRule(engine);
    for (const path of [
      ".herta/attachments/sid/spec-ab12cd34.docx.txt",
      ".herta/logs/run.log",
      ".herta/tool-results/t/c.json",
    ]) {
      const decision = await engine.check(
        { id: "1", tool: "run_command", input: { argv: ["cat", path] } },
        ctxFor(ws.root),
      );
      expect(decision.kind, path).toBe("allow");
    }
    const memory = await engine.check(
      {
        id: "1",
        tool: "run_command",
        input: { argv: ["cat", ".herta/memory/project.jsonl"] },
      },
      ctxFor(ws.root),
    );
    expect(memory.kind).toBe("deny");
    if (memory.kind !== "deny") throw new Error();
    expect(memory.code).toBe("path_denied");
  });

  it("denies a reader whose innocent-named operand is a SYMLINK escaping the workspace (audit T3.4)", async () => {
    if (!(await canCreateFileSymlinks())) return; // Windows w/o Developer Mode
    ws = await mkTmpWorkspace({});
    const outside = `${ws.root}-secret`;
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "id_rsa"), "PRIVATE KEY");
    // An innocent basename that the TEXTUAL guard cannot see through.
    await symlink(join(outside, "id_rsa"), join(ws.root, "notes.txt"));
    try {
      const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
      registerRunCommandRule(engine);
      const decision = await engine.check(
        { id: "1", tool: "run_command", input: { argv: ["cat", "notes.txt"] } },
        ctxFor(ws.root),
      );
      expect(decision.kind).toBe("deny");
      if (decision.kind !== "deny") throw new Error();
      expect(decision.code).toBe("path_outside_workspace");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("denies a reader whose operand symlinks to an IN-workspace credential (audit T3.4)", async () => {
    if (!(await canCreateFileSymlinks())) return;
    ws = await mkTmpWorkspace({ id_rsa: "PRIVATE KEY" });
    // A convenience link inside the repo pointing at the repo's own key file.
    await symlink(join(ws.root, "id_rsa"), join(ws.root, "notes.txt"));
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerRunCommandRule(engine);
    const decision = await engine.check(
      { id: "1", tool: "run_command", input: { argv: ["cat", "notes.txt"] } },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") throw new Error();
    expect(decision.code).toBe("path_denied");
  });
});
