import {
  type AgentEvent,
  BackgroundHost,
  InMemoryEventBus,
  NoopMemoryManager,
  ReadLedger,
  TodoStore,
  type ToolContext,
} from "@herta/core";
import { describe, expect, it } from "vitest";
import { todoWriteTool } from "./index.js";

function mkCtx(todos = new TodoStore()): {
  ctx: ToolContext;
  events: AgentEvent[];
  todos: TodoStore;
} {
  const bus = new InMemoryEventBus<AgentEvent>();
  const events: AgentEvent[] = [];
  bus.onAny((e) => events.push(e));
  return {
    ctx: {
      sessionId: "test",
      signal: new AbortController().signal,
      workspaceRoot: "/tmp/ws",
      reads: new ReadLedger(),
      todos,
      bg: new BackgroundHost(),
      bus,
      memory: new NoopMemoryManager(),
    },
    events,
    todos,
  };
}

describe("todo_write tool", () => {
  it("replaces the whole list, publishes plan.updated, returns the list", async () => {
    const { ctx, events, todos } = mkCtx();
    const r = await todoWriteTool().run(
      {
        id: "c1",
        tool: "todo_write",
        input: {
          todos: [
            { content: "locate the bug", status: "completed" },
            { content: "patch parser.ts", status: "in_progress" },
            { content: "run targeted tests", status: "pending" },
          ],
        },
      },
      ctx,
      () => {},
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { todos: { content: string; status: string }[] };
    expect(data.todos).toHaveLength(3);
    expect(r.summary).toBe("todos 1/3 completed");
    expect(todos.all()).toHaveLength(3);
    expect(todos.unfinished()).toHaveLength(2);
    const updated = events.find((e) => e.type === "plan.updated");
    expect(updated).toBeDefined();
    if (updated?.type === "plan.updated") {
      expect(updated.layer).toBe("backend");
      expect(updated.todos).toHaveLength(3);
    }
  });

  it("a later call drops omitted items (full replacement, not merge)", async () => {
    const { ctx, todos } = mkCtx();
    const run = (items: { content: string; status: string }[]) =>
      todoWriteTool().run(
        { id: "c", tool: "todo_write", input: { todos: items } },
        ctx,
        () => {},
      );
    await run([
      { content: "a", status: "pending" },
      { content: "b", status: "pending" },
    ]);
    const r = await run([{ content: "b", status: "completed" }]);
    expect(r.ok).toBe(true);
    expect(todos.all()).toHaveLength(1);
    expect(todos.all()[0]?.content).toBe("b");
    expect(r.summary).toBe("todos 1/1 completed");
  });

  it("an empty list clears the todos", async () => {
    const store = new TodoStore();
    store.replace([{ content: "a", status: "pending" }]);
    const { ctx, todos } = mkCtx(store);
    const r = await todoWriteTool().run(
      { id: "c1", tool: "todo_write", input: { todos: [] } },
      ctx,
      () => {},
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("todos cleared");
    expect(todos.all()).toHaveLength(0);
  });

  it("rejects a list over the 32-item cap as invalid_input", async () => {
    const { ctx, todos } = mkCtx();
    const items = Array.from({ length: 33 }, (_, i) => ({
      content: `step ${i}`,
      status: "pending" as const,
    }));
    const r = await todoWriteTool().run(
      { id: "c1", tool: "todo_write", input: { todos: items } },
      ctx,
      () => {},
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("invalid_input");
    expect(todos.all()).toHaveLength(0);
  });

  it("rejects malformed input (bad status, missing todos) without mutating state", async () => {
    const { ctx, events, todos } = mkCtx();
    const bad = await todoWriteTool().run(
      {
        id: "c1",
        tool: "todo_write",
        input: { todos: [{ content: "a", status: "done" }] },
      },
      ctx,
      () => {},
    );
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("invalid_input");
    const missing = await todoWriteTool().run(
      { id: "c2", tool: "todo_write", input: {} },
      ctx,
      () => {},
    );
    expect(missing.ok).toBe(false);
    expect(todos.all()).toHaveLength(0);
    expect(events.find((e) => e.type === "plan.updated")).toBeUndefined();
  });

  it("result data is a snapshot — later replaces don't mutate it", async () => {
    const { ctx, todos } = mkCtx();
    const r = await todoWriteTool().run(
      {
        id: "c1",
        tool: "todo_write",
        input: { todos: [{ content: "a", status: "pending" }] },
      },
      ctx,
      () => {},
    );
    expect(r.ok).toBe(true);
    const data = r.data as { todos: readonly { content: string }[] };
    todos.replace([]);
    expect(data.todos).toHaveLength(1);
  });

  // ADR 0016 amendment (2026-09-03): the list is shown to the user inside the
  // conversation, so the description names the CONVERSATION's language for
  // the item text — without it a Chinese session got an English task list,
  // the model copying the register of the (English) tool prose.
  it("names the session's language for the item text; zh is the default", () => {
    const zh = todoWriteTool().schema().description;
    expect(zh).toContain("Write each item's `content` in Chinese (中文)");
    expect(todoWriteTool({ lang: "zh" }).schema().description).toBe(zh);
    const en = todoWriteTool({ lang: "en" }).schema().description;
    expect(en).toContain("Write each item's `content` in English");
    expect(en).not.toMatch(/[一-鿿]/);
    // The rest of the description is the same either way.
    expect(en.split("Write each item's")[0]).toBe(
      zh.split("Write each item's")[0],
    );
  });
});
