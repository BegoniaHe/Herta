import type { TerminalRecordBlock } from "@herta/app-server";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithSession } from "../../testing/renderWithSession.js";
import { TRACE_MAX_ROWS } from "../Workspace/trace-context.js";
import { CARD_ROW_ENTER_MS, CARD_ROW_LEAVE_MS } from "./card-motion.js";
import { TraceCard } from "./TraceCard.js";
import { PLAN_HOLD_MS, PLAN_SLIDE_MS } from "./usePlanCard.js";

afterEach(() => {
  vi.useRealTimers();
});

const user = (text = "修一下"): TerminalRecordBlock =>
  ({ kind: "user", text }) as TerminalRecordBlock;
const sys = (digest: unknown, body = "row"): TerminalRecordBlock =>
  ({
    kind: "system",
    label: "差分协处理器",
    body,
    digest,
  }) as TerminalRecordBlock;
const op = (verb: string, arg: string) => sys({ kind: "op", verb, arg });
const exit = (exitCode: number | null, lineCount = 3) =>
  sys({ kind: "text", exitCode, lineCount });
const todo = (): TerminalRecordBlock =>
  ({
    kind: "system",
    label: "差分协处理器",
    body: "todo 0/2",
    digest: {
      kind: "todo",
      total: 2,
      completed: 0,
      items: [
        { content: "步骤一", status: "in_progress" },
        { content: "步骤二", status: "pending" },
      ],
    },
  }) as TerminalRecordBlock;
const doneMarker: TerminalRecordBlock = {
  kind: "system",
  label: "差分协处理器",
  body: "完成 · 1 个文件",
  role: "done-marker",
} as TerminalRecordBlock;

function push(
  h: ReturnType<typeof renderWithSession>,
  ...blocks: TerminalRecordBlock[]
): void {
  act(() => {
    for (const [i, block] of blocks.entries()) {
      h.mock.emitRecord({
        kind: "block",
        blockId: `t${Date.now()}-${i}`,
        block,
      });
    }
  });
}

const card = () => document.querySelector('[data-testid="trace-card"]');
const isOpen = () => card()?.className.includes("is-open") ?? false;
const rows = () => [...document.querySelectorAll(".trace-card__row")];

describe("TraceCard", () => {
  it("is absent for a session with no dispatch ops", () => {
    const h = renderWithSession(<TraceCard />);
    h.openSession();
    expect(card()).toBeNull();
    push(h, user());
    expect(card()).toBeNull();
  });

  it("slides out with one row per op; marks ✓ / ✗ / ▸ by status; notes carry results", () => {
    const h = renderWithSession(<TraceCard />);
    h.openSession();
    push(
      h,
      user(),
      op("Running", "npm test"),
      exit(1),
      op("Writing", "src/store.mjs"),
      op("Running", "node --test test/"),
    );
    expect(isOpen()).toBe(true);
    const r = rows();
    expect(r).toHaveLength(3);
    // Failed op: ✗ mark + the exit note, danger-tinted.
    expect(r[0]?.className).toContain("is-fail");
    expect(r[0]?.querySelector(".trace-card__note")?.textContent).toContain(
      "1",
    );
    expect(r[0]?.querySelector(".trace-card__note")?.className).toContain(
      "is-fail",
    );
    // Settled-by-succession op: ✓, no note.
    expect(r[1]?.className).toContain("is-ok");
    expect(r[1]?.querySelector(".trace-card__note")).toBeNull();
    // The op in flight: caret, full-ink row, live meter sweeping.
    expect(r[2]?.className).toContain("is-running");
    expect(r[2]?.querySelector(".plan-card__caret")).not.toBeNull();
    expect(
      document.querySelector(".trace-card__meter-fill")?.className,
    ).toContain("is-live");
    // Verb localizes (EN test locale), arg verbatim.
    expect(r[2]?.querySelector(".trace-card__text")?.textContent).toContain(
      "node --test test/",
    );
    // Header counts steps and written files.
    expect(document.querySelector(".plan-card__count")?.textContent).toBe(
      "3 steps · 1 files",
    );
  });

  it("an appended op enters; the window's dropped head leaves then drops; the first trace lands still (ADR 0058 §5.7)", () => {
    vi.useFakeTimers();
    const h = renderWithSession(<TraceCard />);
    h.openSession();
    push(h, user(), op("Running", "npm test"), op("Reading", "a.ts"));
    expect(document.querySelector(".trace-card__row.is-entering")).toBeNull();
    push(h, op("Writing", "b.ts"));
    let r = rows();
    expect(r).toHaveLength(3);
    expect(r.map((x) => x.classList.contains("is-entering"))).toEqual([
      false,
      false,
      true,
    ]);
    act(() => {
      vi.advanceTimersByTime(CARD_ROW_ENTER_MS + 5);
    });
    expect(document.querySelector(".trace-card__row.is-entering")).toBeNull();
    // Fill the window, then one more: the head slides out, the tail enters.
    const fill: TerminalRecordBlock[] = [];
    for (let i = rows().length; i < TRACE_MAX_ROWS; i += 1) {
      fill.push(op("Reading", `f${i}.ts`));
    }
    push(h, ...fill);
    act(() => {
      vi.advanceTimersByTime(CARD_ROW_ENTER_MS + 5);
    });
    expect(rows()).toHaveLength(TRACE_MAX_ROWS);
    push(h, op("Reading", "tail.ts"));
    r = rows();
    expect(r).toHaveLength(TRACE_MAX_ROWS + 1);
    expect(r[0]?.classList.contains("is-leaving")).toBe(true);
    expect(r[0]?.querySelector(".trace-card__text")?.textContent).toContain(
      "npm test",
    );
    expect(r[r.length - 1]?.classList.contains("is-entering")).toBe(true);
    act(() => {
      vi.advanceTimersByTime(CARD_ROW_LEAVE_MS + 5);
    });
    expect(rows()).toHaveLength(TRACE_MAX_ROWS);
    expect(
      rows()[0]?.querySelector(".trace-card__text")?.textContent,
    ).toContain("a.ts");
  });

  it("HOLDS past the done-marker with the running tail settled, then slides back and unmounts", () => {
    vi.useFakeTimers();
    const h = renderWithSession(<TraceCard />);
    h.openSession();
    push(h, user(), op("Running", "npm test"));
    expect(rows()[0]?.className).toContain("is-running");
    push(h, doneMarker);
    // Held open; the tail is settled (nothing is in flight after the marker)
    // and the meter rests.
    expect(isOpen()).toBe(true);
    expect(rows()[0]?.className).toContain("is-ok");
    expect(
      document.querySelector(".trace-card__meter-fill")?.className,
    ).not.toContain("is-live");
    act(() => {
      vi.advanceTimersByTime(PLAN_HOLD_MS + 100);
    });
    expect(isOpen()).toBe(false);
    expect(rows()).toHaveLength(1); // content kept through the slide
    act(() => {
      vi.advanceTimersByTime(PLAN_SLIDE_MS + 200);
    });
    expect(card()).toBeNull();
  });

  it("stands down IMMEDIATELY when a todo projection lands — PlanCard owns the slot", () => {
    const h = renderWithSession(<TraceCard />);
    h.openSession();
    push(h, user(), op("Reading", "src/store.mjs"));
    expect(card()).not.toBeNull();
    push(h, todo());
    expect(card()).toBeNull();
  });

  it("stills the live meter while parked on a permission gate (is-waiting)", () => {
    const h = renderWithSession(<TraceCard />);
    h.openSession();
    push(h, user(), op("Running", "npm install"));
    act(() => {
      h.mock.emitOverlay({
        kind: "pending",
        overlay: {
          kind: "pending-permission",
          requestId: "r1",
          risk: "network",
          tool: "bash",
          summary: "npm install",
          cacheable: false,
        },
      });
    });
    expect(card()?.className).toContain("is-waiting");
    act(() => {
      h.mock.emitOverlay({ kind: "resolved", requestId: "r1" });
    });
    expect(card()?.className).not.toContain("is-waiting");
  });

  it("a chained dispatch after the first's marker restarts the trace with the new ops", () => {
    const h = renderWithSession(<TraceCard />);
    h.openSession();
    push(h, user(), op("Running", "npm test"), exit(0), doneMarker);
    push(h, op("Running", "git push"));
    expect(rows()).toHaveLength(1);
    expect(
      rows()[0]?.querySelector(".trace-card__text")?.textContent,
    ).toContain("git push");
  });
});
