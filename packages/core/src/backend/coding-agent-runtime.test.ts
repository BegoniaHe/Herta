import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HertaToAgentBrief } from "../bridge/types.js";
import { InMemoryEventBus } from "../event-bus.js";
import { NoopMemoryManager } from "../memory-manager.js";
import {
  NoopPermissionEngine,
  type PermissionEngine,
} from "../permission-engine.js";
import { FakeProvider } from "../testing/fake-provider.js";
import { InMemoryToolRegistry } from "../tool-registry.js";
import type { AgentEvent } from "../types/events.js";
import type { ProviderPromptFrame } from "../types/provider.js";
import { BackendContextBuilder } from "./backend-context-builder.js";
import { CodingAgentRuntime } from "./coding-agent-runtime.js";

const sampleBrief: HertaToAgentBrief = { taskId: "t-1" };

// Each brief idempotently ensures its workspaceRoot exists, so the suite uses
// a real tmp dir (cleaned per-test) instead of a hardcoded path.
let wsRoot: string;
beforeEach(() => {
  wsRoot = mkdtempSync(join(tmpdir(), "car-ws-"));
});
afterEach(() => {
  rmSync(wsRoot, { recursive: true, force: true });
});

function makeRuntime(provider: FakeProvider): {
  runtime: CodingAgentRuntime;
  tools: InMemoryToolRegistry;
} {
  const tools = new InMemoryToolRegistry();
  const runtime = new CodingAgentRuntime({
    sessionId: "s-1",
    provider,
    tools,
    permissions: new NoopPermissionEngine(),
    backendBuilder: new BackendContextBuilder({ tools }),
    bus: new InMemoryEventBus<AgentEvent>(),
    clock: () => new Date("2026-05-07T00:00:00.000Z"),
    workspaceRoot: wsRoot,
    memory: new NoopMemoryManager(),
  });
  return { runtime, tools };
}

describe("CodingAgentRuntime.runBrief", () => {
  it("creates the managed sandbox dir on first use if it does not exist", async () => {
    const provider = new FakeProvider({
      turns: [[{ type: "finish", reason: "stop" }]],
    });
    const tools = new InMemoryToolRegistry();
    const missing = join(wsRoot, "workspaces", "not-yet-created");
    expect(existsSync(missing)).toBe(false);
    const runtime = new CodingAgentRuntime({
      sessionId: "s-1",
      provider,
      tools,
      permissions: new NoopPermissionEngine(),
      backendBuilder: new BackendContextBuilder({ tools }),
      bus: new InMemoryEventBus<AgentEvent>(),
      clock: () => new Date("2026-05-07T00:00:00.000Z"),
      workspaceRoot: missing,
      memory: new NoopMemoryManager(),
    });

    await runtime.runBrief(sampleBrief);

    expect(existsSync(missing)).toBe(true);
  });

  it("runs a brief to completion and returns a partial report when no evidence is collected", async () => {
    const provider = new FakeProvider({
      turns: [[{ type: "finish", reason: "stop" }]],
    });
    const { runtime } = makeRuntime(provider);

    const report = await runtime.runBrief(sampleBrief);

    expect(report.taskId).toBe("t-1");
    expect(report.status).toBe("partial");
    expect(report.evidence).toEqual([]);
    expect(report.tests).toEqual([]);
    expect(report.changedFiles).toEqual([]);
    expect(report.permissions).toEqual([]);
    expect(report.residualRisks).toEqual([]);
  });

  it("a READ-ONLY run does not claim completed (audit 2026-07-24, 1.2)", async () => {
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: {
              id: "call-1",
              tool: "read_file",
              input: { path: "src/parser.ts" },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
    });
    const { runtime, tools } = makeRuntime(provider);
    tools.register({
      name: "read_file",
      schema: () => ({
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object", properties: {} },
      }),
      run: async () => ({
        ok: true,
        data: { content: "fake content" },
        summary: "read 1 file",
      }),
    });

    const report = await runtime.runBrief(sampleBrief);

    // `ToolResult.ok` means the tool EXECUTED, not that the task advanced.
    // This test used to pin the opposite: one read_file → "completed", which
    // is how a backend that investigated and DECLINED ("that function doesn't
    // exist here, I can't do this") reported 完成 into a durable marker that
    // Herta reads as ground truth and the next dispatch inherits.
    expect(report.status).toBe("partial");
    // The evidence is still recorded — only the completion CLAIM changed.
    expect(report.evidence).toHaveLength(1);
    expect(report.evidence[0]?.kind).toBe("tool");
    expect(report.evidence[0]?.summary).toContain("read 1 file");
  });

  it("a successful MUTATION does promote to completed", async () => {
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: {
              id: "call-1",
              tool: "memory_save",
              input: { text: "remember this" },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
    });
    const { runtime, tools } = makeRuntime(provider);
    tools.register({
      name: "memory_save",
      schema: () => ({
        name: "memory_save",
        description: "Save a memory",
        inputSchema: { type: "object", properties: {} },
      }),
      run: async () => ({ ok: true, summary: "saved 1 note" }),
    });

    const report = await runtime.runBrief(sampleBrief);
    expect(report.status).toBe("completed");
  });

  describe("minimal-contract tools (ADR 0040)", () => {
    function scripted(
      calls: Array<{ tool: string; input: unknown }>,
    ): FakeProvider {
      return new FakeProvider({
        turns: [
          [
            ...calls.map((c, i) => ({
              type: "tool-call-request" as const,
              call: { id: `call-${i + 1}`, tool: c.tool, input: c.input },
            })),
            { type: "finish" as const, reason: "tool_calls" as const },
          ],
          [{ type: "finish" as const, reason: "stop" as const }],
        ],
      });
    }
    const schema = (name: string) => () => ({
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
    });

    it("bash at exit 0 argues for completed; a non-zero exit does not, and its testRun lands in report.tests", async () => {
      const okRun = scripted([
        { tool: "bash", input: { command: "npm test" } },
      ]);
      const { runtime, tools } = makeRuntime(okRun);
      tools.register({
        name: "bash",
        schema: schema("bash"),
        run: async () => ({
          ok: true,
          summary: "ran `npm test` (exit 0, 0.4s)",
          modelText: "ok 1\n# pass 3",
          data: {
            argv: ["npm test"],
            cwd: ".",
            exitCode: 0,
            signal: null,
            durationMs: 400,
            stdout: "ok 1\n# pass 3",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutBytes: 15,
            stderrBytes: 0,
            logPath: ".herta/logs/x.log",
            timedOut: false,
            testRun: {
              command: "npm test",
              status: "passed",
              summary: "3 passed",
            },
          },
        }),
      });
      const report = await runtime.runBrief(sampleBrief);
      expect(report.status).toBe("completed");
      expect(report.tests).toEqual([
        { command: "npm test", status: "passed", summary: "3 passed" },
      ]);

      const failRun = scripted([{ tool: "bash", input: { command: "false" } }]);
      const second = makeRuntime(failRun);
      second.tools.register({
        name: "bash",
        schema: schema("bash"),
        run: async () => ({
          ok: true,
          summary: "ran `false` (exit 1, 0.0s)",
          modelText: "[exit code: 1]",
          data: { exitCode: 1, stdout: "", stderr: "" },
        }),
      });
      expect((await second.runtime.runBrief(sampleBrief)).status).toBe(
        "partial",
      );
    });

    it("str_replace_editor: a view proves nothing; a write is a changed file and completion evidence", async () => {
      const viewOnly = scripted([
        {
          tool: "str_replace_editor",
          input: { command: "view", path: "/e/r/a.ts" },
        },
      ]);
      const { runtime, tools } = makeRuntime(viewOnly);
      tools.register({
        name: "str_replace_editor",
        schema: schema("str_replace_editor"),
        run: async () => ({
          ok: true,
          summary: "viewed src/a.ts (12 lines)",
          modelText: "Here's the content of /e/r/a.ts …",
          data: { command: "view", path: "src/a.ts" },
        }),
      });
      const r1 = await runtime.runBrief(sampleBrief);
      expect(r1.status).toBe("partial");
      expect(r1.changedFiles).toEqual([]);

      const write = scripted([
        {
          tool: "str_replace_editor",
          input: {
            command: "str_replace",
            path: "/e/r/a.ts",
            old_str: "a",
            new_str: "b",
          },
        },
        {
          tool: "str_replace_editor",
          input: { command: "create", path: "/e/r/new.ts", file_text: "x" },
        },
      ]);
      const second = makeRuntime(write);
      let n = 0;
      second.tools.register({
        name: "str_replace_editor",
        schema: schema("str_replace_editor"),
        run: async () => {
          n += 1;
          return n === 1
            ? {
                ok: true,
                summary: "edited src/a.ts",
                modelText: "The file /e/r/a.ts has been edited successfully.",
                data: {
                  command: "str_replace",
                  relPath: "src/a.ts",
                  diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
                  wrote: true,
                  created: false,
                },
              }
            : {
                ok: true,
                summary: "created src/new.ts",
                modelText: "New file created successfully at: /e/r/new.ts",
                data: {
                  command: "create",
                  relPath: "src/new.ts",
                  diff: "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+x\n",
                  wrote: true,
                  created: true,
                },
              };
        },
      });
      const r2 = await second.runtime.runBrief(sampleBrief);
      expect(r2.status).toBe("completed");
      expect(
        r2.changedFiles.map((f) => [f.path, f.kind, f.diffSummary]),
      ).toEqual([
        ["src/a.ts", "modified", "+1 -1"],
        ["src/new.ts", "created", "+1 -0"],
      ]);
    });
  });

  it("a recorded FINDING is its own evidence kind and argues for completed (ADR 0039)", async () => {
    // The 1.2 rule keeps read-only tools from claiming 完成 because they only
    // prove execution. A cited finding is the DELIVERABLE of an analysis
    // brief — the thing that used to evaporate — so it counts, and it lands
    // under its own kind so the marker can list conclusions apart from
    // receipts.
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: {
              id: "call-1",
              tool: "read_file",
              input: { path: "log.txt" },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          {
            type: "tool-call-request",
            call: {
              id: "call-2",
              tool: "report_finding",
              input: {
                claim: "The run died of CUDA OOM.",
                cites: ["log.txt:33"],
              },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
    });
    const { runtime, tools } = makeRuntime(provider);
    tools.register({
      name: "read_file",
      schema: () => ({ name: "read_file", description: "r", inputSchema: {} }),
      run: async () => ({
        ok: true,
        data: { content: "x" },
        summary: "read 1 file",
      }),
    });
    tools.register({
      name: "report_finding",
      schema: () => ({
        name: "report_finding",
        description: "f",
        inputSchema: {},
      }),
      run: async () => ({
        ok: true,
        data: {
          index: 1,
          claim: "The run died of CUDA OOM.",
          cites: ["log.txt:33"],
        },
        summary: "finding #1: The run died of CUDA OOM. — log.txt:33",
      }),
    });

    const report = await runtime.runBrief(sampleBrief);
    expect(report.status).toBe("completed");
    expect(report.evidence).toEqual([
      { kind: "tool", summary: "read 1 file", source: "call-1" },
      {
        kind: "finding",
        summary: "The run died of CUDA OOM.",
        source: "log.txt:33",
      },
    ]);
  });

  it("a FAILING command is not completion evidence (audit 2026-07-24, 1.2)", async () => {
    // run_command returns ok:true for every exit code — running the command
    // is what succeeded. A run whose only action is a failing build must not
    // report 完成; a failing test suite counts as a report entry (that is
    // tests[]'s job) but not as evidence the task advanced.
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: {
              id: "call-1",
              tool: "run_command",
              input: { argv: ["pnpm", "test"] },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
    });
    const { runtime, tools } = makeRuntime(provider);
    tools.register({
      name: "run_command",
      schema: () => ({
        name: "run_command",
        description: "fake",
        inputSchema: {},
      }),
      run: async () => ({
        ok: true,
        data: {
          argv: ["pnpm", "test"],
          exitCode: 1,
          durationMs: 1000,
          timedOut: false,
          testRun: {
            command: "pnpm test",
            status: "failed" as const,
            summary: "exit 1, 1.00s",
          },
        },
        summary: "ran pnpm test",
      }),
    });

    const report = await runtime.runBrief(sampleBrief);
    // The failure is REPORTED — just not claimed as success.
    expect(report.tests[0]?.status).toBe("failed");
    expect(report.status).toBe("partial");
  });

  it("returns failed status with a residual risk when the turn fails", async () => {
    const provider = new FakeProvider({
      turns: [
        () => {
          throw new Error("provider exploded");
        },
      ],
    });
    const { runtime } = makeRuntime(provider);

    const report = await runtime.runBrief(sampleBrief);

    expect(report.status).toBe("failed");
    expect(report.residualRisks.length).toBeGreaterThan(0);
    expect(report.residualRisks.join(" ")).toMatch(/provider exploded/);
  });

  it("resets transcript and plan between briefs", async () => {
    const provider = new FakeProvider({
      turns: [
        [
          { type: "text-delta", text: "first response" },
          { type: "finish", reason: "stop" },
        ],
        (frame) => {
          if ("backendSystem" in frame) {
            // No prior assistant messages — fresh transcript per brief.
          }
          return [{ type: "finish", reason: "stop" }];
        },
      ],
    });
    const { runtime } = makeRuntime(provider);

    const first = await runtime.runBrief({ ...sampleBrief, taskId: "t-1" });
    const second = await runtime.runBrief({ ...sampleBrief, taskId: "t-2" });

    expect(first.taskId).toBe("t-1");
    expect(second.taskId).toBe("t-2");
    expect(first).not.toBe(second);
  });

  it("forwards scopedRepoInstructions and scopedMemory through the loop", async () => {
    let capturedFrame: ProviderPromptFrame | undefined;
    const provider = new FakeProvider({
      turns: [
        (frame) => {
          capturedFrame = frame;
          return [{ type: "finish", reason: "stop" }];
        },
      ],
    });
    const { runtime } = makeRuntime(provider);

    await runtime.runBrief(sampleBrief, {
      scopedRepoInstructions: "scoped-repo-text",
      scopedMemory: "scoped-memory-text",
    });

    expect(capturedFrame).toBeDefined();
    if (capturedFrame !== undefined && "backendSystem" in capturedFrame) {
      expect(capturedFrame.scopedRepoInstructions).toBe("scoped-repo-text");
      expect(capturedFrame.scopedMemory).toBe("scoped-memory-text");
    }
  });

  it("captures the actual tool name and risk in permission events", async () => {
    const requestedRisk = "workspace_write" as const;
    const requestedTool = "edit_file";
    const askingPermissions: PermissionEngine = {
      check: async (call) => ({
        kind: "ask" as const,
        request: {
          id: "req-7",
          call: { id: call.id, tool: call.tool, input: {} },
          reason: "writes to workspace",
          risk: requestedRisk,
        },
        decision: Promise.resolve("allow" as const),
      }),
      resolve: () => {},
    };

    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: {
              id: "call-1",
              tool: requestedTool,
              input: { path: "src/x.ts" },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
    });

    const tools = new InMemoryToolRegistry();
    tools.register({
      name: requestedTool,
      schema: () => ({
        name: requestedTool,
        description: "patch a file",
        inputSchema: { type: "object", properties: {} },
      }),
      run: async () => ({ ok: true, summary: "patched 1 file" }),
    });

    const runtime = new CodingAgentRuntime({
      sessionId: "s-1",
      provider,
      tools,
      permissions: askingPermissions,
      backendBuilder: new BackendContextBuilder({ tools }),
      bus: new InMemoryEventBus<AgentEvent>(),
      clock: () => new Date("2026-05-07T00:00:00.000Z"),
      workspaceRoot: wsRoot,
      memory: new NoopMemoryManager(),
    });

    const report = await runtime.runBrief(sampleBrief);

    expect(report.permissions).toHaveLength(1);
    expect(report.permissions[0]?.tool).toBe(requestedTool);
    expect(report.permissions[0]?.risk).toBe(requestedRisk);
    expect(report.permissions[0]?.decision).toBe("allow");
  });

  it("summarizes unified-diff content correctly (excludes +++/--- headers)", async () => {
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: {
              id: "patch-1",
              tool: "edit_file",
              input: { path: "src/x.ts" },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
    });

    const tools = new InMemoryToolRegistry();
    const bus = new InMemoryEventBus<AgentEvent>();
    tools.register({
      name: "edit_file",
      schema: () => ({
        name: "edit_file",
        description: "patch a file",
        inputSchema: { type: "object", properties: {} },
      }),
      run: async (_call, ctx) => {
        // Real rules publish the preview BEFORE the user decides; the report
        // must NOT harvest changed files from it (a denied edit would count).
        // The harvest source is the SUCCESSFUL result's data (relPath/diff),
        // mirroring the real edit_file result shape.
        ctx.bus.publish({
          type: "patch.preview",
          layer: "backend",
          diff: "should-not-be-harvested",
          files: ["src/should-not-appear.ts"],
        });
        return {
          ok: true,
          summary: "patched 1 file",
          data: {
            relPath: "src/x.ts",
            diff: [
              "--- a/src/x.ts",
              "+++ b/src/x.ts",
              "@@ -1,3 +1,3 @@",
              "-old line",
              "+new line",
              " unchanged",
            ].join("\n"),
          },
        };
      },
    });

    const runtime = new CodingAgentRuntime({
      sessionId: "s-1",
      provider,
      tools,
      permissions: new NoopPermissionEngine(),
      backendBuilder: new BackendContextBuilder({ tools }),
      bus,
      clock: () => new Date("2026-05-07T00:00:00.000Z"),
      workspaceRoot: wsRoot,
      memory: new NoopMemoryManager(),
    });

    const report = await runtime.runBrief(sampleBrief);

    expect(report.changedFiles).toHaveLength(1);
    expect(report.changedFiles[0]?.path).toBe("src/x.ts");
    expect(report.changedFiles[0]?.kind).toBe("modified");
    expect(report.changedFiles[0]?.diffSummary).toBe("+1 -1");
    // The pre-decision preview must NOT have been harvested.
    expect(
      report.changedFiles.some((f) => f.path === "src/should-not-appear.ts"),
    ).toBe(false);
  });

  it("a run whose only mutation is DENIED reports status 'blocked' with no changed files", async () => {
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: { id: "tc1", tool: "edit_file", input: {} },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text-delta", text: "stopped" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const tools = new InMemoryToolRegistry();
    tools.register({
      name: "edit_file",
      schema: () => ({
        name: "edit_file",
        description: "patch a file",
        inputSchema: { type: "object", properties: {} },
      }),
      // Never reached — the engine denies before run.
      run: async () => ({ ok: true, summary: "should not run" }),
    });
    // Deny + publish the permission lifecycle the real ask-resolver flow
    // produces (the user clicking Deny). Pre-fix, the denial's own tool
    // result counted as evidence → status "completed" (完成) for work the
    // user explicitly rejected, and "blocked" was unreachable.
    const denyingEngine = {
      check: async (
        call: { id: string; tool: string },
        ctx: { bus: InMemoryEventBus<AgentEvent> },
      ) => {
        ctx.bus.publish({
          type: "permission.requested",
          layer: "backend",
          request: {
            id: "perm-1",
            call,
            risk: "workspace_write",
            reason: "edit a file",
          },
        } as never);
        ctx.bus.publish({
          type: "permission.resolved",
          layer: "backend",
          id: "perm-1",
          decision: "deny",
        } as never);
        return { kind: "deny" as const, code: "permission_denied" as const };
      },
    } as unknown as PermissionEngine;
    const runtime = new CodingAgentRuntime({
      sessionId: "s-1",
      provider,
      tools,
      permissions: denyingEngine,
      backendBuilder: new BackendContextBuilder({ tools }),
      bus: new InMemoryEventBus<AgentEvent>(),
      clock: () => new Date("2026-05-07T00:00:00.000Z"),
      workspaceRoot: wsRoot,
      memory: new NoopMemoryManager(),
    });

    const report = await runtime.runBrief(sampleBrief);

    expect(report.status).toBe("blocked");
    expect(report.changedFiles).toHaveLength(0);
    expect(report.permissions.some((p) => p.decision === "deny")).toBe(true);
  });

  it("a policy-blocked run cannot report 'completed' (audit finding 6)", async () => {
    // The audit scenario: one successful read_file, then a blocklisted
    // run_command that the engine auto-denies. Pre-fix the rule-deny path
    // emitted no permission event, so okEvidence=1 / deniedPermissions=0
    // carried the run to `completed` — Herta reported success for work the
    // harness refused to do.
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: { id: "tc1", tool: "read_file", input: { path: "a.ts" } },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          {
            type: "tool-call-request",
            call: {
              id: "tc2",
              tool: "run_command",
              input: { argv: ["shutdown", "/s"] },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text-delta", text: "giving up" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const tools = new InMemoryToolRegistry();
    tools.register({
      name: "read_file",
      schema: () => ({
        name: "read_file",
        description: "read",
        inputSchema: { type: "object", properties: {} },
      }),
      run: async () => ({ ok: true, summary: "read 1 file" }),
    });
    tools.register({
      name: "run_command",
      schema: () => ({
        name: "run_command",
        description: "run",
        inputSchema: { type: "object", properties: {} },
      }),
      run: async () => ({ ok: true, summary: "should never run" }),
    });
    const blockingEngine: PermissionEngine = {
      check: async (call) =>
        call.tool === "run_command"
          ? {
              kind: "deny",
              reason: "system control: shutdown",
              code: "command_blocked",
            }
          : { kind: "allow" },
      resolve: () => {},
    };
    const runtime = new CodingAgentRuntime({
      sessionId: "s-1",
      provider,
      tools,
      permissions: blockingEngine,
      backendBuilder: new BackendContextBuilder({ tools }),
      bus: new InMemoryEventBus<AgentEvent>(),
      clock: () => new Date("2026-05-07T00:00:00.000Z"),
      workspaceRoot: wsRoot,
      memory: new NoopMemoryManager(),
    });

    const report = await runtime.runBrief(sampleBrief);

    expect(report.status).toBe("blocked");
    expect(report.changedFiles).toHaveLength(0);
    const blocked = report.permissions.find((p) => p.decision === "blocked");
    expect(blocked).toBeDefined();
    expect(blocked?.tool).toBe("run_command");
  });

  it("populates report.tests[] when run_command emits a testRun", async () => {
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: {
              id: "tc1",
              tool: "run_command",
              input: { argv: ["pnpm", "test"] },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text-delta", text: "tests passed" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const { runtime, tools } = makeRuntime(provider);
    tools.register({
      name: "run_command",
      schema: () => ({
        name: "run_command",
        description: "fake",
        inputSchema: {},
      }),
      run: async () => ({
        ok: true,
        data: {
          argv: ["pnpm", "test"],
          exitCode: 0,
          durationMs: 1000,
          timedOut: false,
          testRun: {
            command: "pnpm test",
            status: "passed" as const,
            summary: "exit 0, 1.00s",
          },
        },
        summary: "ran pnpm test",
      }),
    });
    const report = await runtime.runBrief(sampleBrief);
    expect(report.tests.length).toBe(1);
    expect(report.tests[0]?.command).toBe("pnpm test");
    expect(report.tests[0]?.status).toBe("passed");
    expect(report.tests[0]?.summary).toBe("exit 0, 1.00s");
  });

  it("does not add to report.tests[] for non-run_command tool calls", async () => {
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: {
              id: "tc1",
              tool: "echo_tool",
              input: {},
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text-delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const { runtime, tools } = makeRuntime(provider);
    tools.register({
      name: "echo_tool",
      schema: () => ({
        name: "echo_tool",
        description: "fake",
        inputSchema: {},
      }),
      run: async () => ({
        ok: true,
        // Even if data accidentally has a testRun field, non-run_command
        // tools should never contribute to tests[].
        data: {
          testRun: {
            command: "fake",
            status: "passed" as const,
            summary: "fake",
          },
        },
        summary: "echoed",
      }),
    });
    const report = await runtime.runBrief(sampleBrief);
    expect(report.tests.length).toBe(0);
  });

  it("does not add to report.tests[] when run_command has data without testRun", async () => {
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: {
              id: "tc1",
              tool: "run_command",
              input: { argv: ["echo", "hi"] },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text-delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const { runtime, tools } = makeRuntime(provider);
    tools.register({
      name: "run_command",
      schema: () => ({
        name: "run_command",
        description: "fake",
        inputSchema: {},
      }),
      run: async () => ({
        ok: true,
        data: {
          argv: ["echo", "hi"],
          exitCode: 0,
          // No testRun field — this was a non-test command.
        },
        summary: "ran echo",
      }),
    });
    const report = await runtime.runBrief(sampleBrief);
    expect(report.tests.length).toBe(0);
  });

  it("rejects a re-entrant runBrief call with a clear error", async () => {
    // ScriptedTurn is synchronous; stall via a tool's async run callback
    // instead, so the first brief stays in-flight while we attempt the second.
    let releaseTool: () => void = () => {};
    let signalToolStarted: () => void = () => {};
    const toolStarted = new Promise<void>((r) => {
      signalToolStarted = r;
    });
    const toolReleased = new Promise<void>((r) => {
      releaseTool = r;
    });

    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: {
              id: "call-stall",
              tool: "stall_tool",
              input: {},
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
    });

    const tools = new InMemoryToolRegistry();
    tools.register({
      name: "stall_tool",
      schema: () => ({
        name: "stall_tool",
        description: "stalls",
        inputSchema: { type: "object", properties: {} },
      }),
      run: async () => {
        signalToolStarted();
        await toolReleased;
        return { ok: true, summary: "stalled then completed" };
      },
    });

    const runtime = new CodingAgentRuntime({
      sessionId: "s-1",
      provider,
      tools,
      permissions: new NoopPermissionEngine(),
      backendBuilder: new BackendContextBuilder({ tools }),
      bus: new InMemoryEventBus<AgentEvent>(),
      clock: () => new Date("2026-05-07T00:00:00.000Z"),
      workspaceRoot: wsRoot,
      memory: new NoopMemoryManager(),
    });

    // Kick off first brief; do NOT await — it stalls inside the tool.
    const first = runtime.runBrief({ ...sampleBrief, taskId: "t-a" });
    // Wait until the stalling tool is actively running.
    await toolStarted;

    await expect(
      runtime.runBrief({ ...sampleBrief, taskId: "t-b" }),
    ).rejects.toMatchObject({
      kind: "internal",
      message: expect.stringMatching(/in progress/i),
    });
    // A REAL Error (audit finding 22): the old AgentError literal had no
    // stack and `err instanceof Error ? … : String(err)` handlers rendered
    // "[object Object]".
    await expect(
      runtime.runBrief({ ...sampleBrief, taskId: "t-c" }),
    ).rejects.toBeInstanceOf(Error);

    releaseTool();
    await first;
  });
});

/**
 * `changedByPath` only ever learns about a path from one of the three editors,
 * and `bash` is not one of them — so on the DEFAULT (minimal) contract every
 * `sed -i`, heredoc, `mv`, `rm`, formatter and codemod contributed nothing and
 * a commission that did real work reported `完成 · 0 个文件`. Neither editor
 * can delete at all, so the highest-blast-radius operation was the one the
 * attribution was structurally blind to.
 */
describe("the dispatch baseline (2026-08-25)", () => {
  const runWith = async (
    snapshots: Array<{ head: string | null; dirty: string[] } | null>,
  ) => {
    const provider = new FakeProvider({
      turns: [[{ type: "finish", reason: "stop" }]],
    });
    let call = 0;
    const runtime = new CodingAgentRuntime({
      sessionId: "s-1",
      provider,
      tools: new InMemoryToolRegistry(),
      permissions: new NoopPermissionEngine(),
      backendBuilder: new BackendContextBuilder({
        tools: new InMemoryToolRegistry(),
      }),
      bus: new InMemoryEventBus<AgentEvent>(),
      clock: () => new Date("2026-05-07T00:00:00.000Z"),
      workspaceRoot: wsRoot,
      memory: new NoopMemoryManager(),
      repoProbe: async () => snapshots[call++] ?? null,
    });
    return runtime.runBrief(sampleBrief, { userMessages: [{ text: "go" }] });
  };

  it("credits a shell-written file the editors never reported", async () => {
    const report = await runWith([
      { head: "abc", dirty: [] },
      { head: "abc", dirty: ["src/b.ts", "src/new.ts"] },
    ]);
    expect(report.changedFiles.map((f) => f.path).sort()).toEqual([
      "src/b.ts",
      "src/new.ts",
    ]);
  });

  it("does NOT credit work the user had already done", async () => {
    // Without the START snapshot, an end-only status reports the user's own
    // uncommitted work as 板砖's — the same lie inverted.
    const report = await runWith([
      { head: "abc", dirty: ["src/mine.ts"] },
      { head: "abc", dirty: ["src/mine.ts", "src/theirs.ts"] },
    ]);
    expect(report.changedFiles.map((f) => f.path)).toEqual(["src/theirs.ts"]);
    // And it SAYS the carried-in file is outside its reach rather than
    // silently ignoring it.
    expect(report.residualRisks.join(" ")).toContain("src/mine.ts");
  });

  it("refuses to attribute anything when HEAD moved under it", async () => {
    // A commit or checkout means "dirty vs HEAD" no longer describes the same
    // tree at both ends, so the difference would be meaningless.
    const report = await runWith([
      { head: "abc", dirty: [] },
      { head: "def", dirty: ["src/x.ts"] },
    ]);
    expect(report.changedFiles).toEqual([]);
    expect(report.residualRisks.join(" ")).toContain("HEAD moved");
  });

  it("is inert with no probe, and survives one that fails", async () => {
    const noProbe = await runWith([]); // repoProbe returns null both times
    expect(noProbe.changedFiles).toEqual([]);
    expect(noProbe.residualRisks.join(" ")).not.toContain("HEAD moved");

    const provider = new FakeProvider({
      turns: [[{ type: "finish", reason: "stop" }]],
    });
    const runtime = new CodingAgentRuntime({
      sessionId: "s-1",
      provider,
      tools: new InMemoryToolRegistry(),
      permissions: new NoopPermissionEngine(),
      backendBuilder: new BackendContextBuilder({
        tools: new InMemoryToolRegistry(),
      }),
      bus: new InMemoryEventBus<AgentEvent>(),
      clock: () => new Date("2026-05-07T00:00:00.000Z"),
      workspaceRoot: wsRoot,
      memory: new NoopMemoryManager(),
      // Attribution is a nicety; it must never be able to fail a brief.
      repoProbe: async () => {
        throw new Error("git exploded");
      },
    });
    const report = await runtime.runBrief(sampleBrief, {
      userMessages: [{ text: "go" }],
    });
    expect(report.changedFiles).toEqual([]);
  });
});
