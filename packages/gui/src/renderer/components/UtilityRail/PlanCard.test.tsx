import type { TerminalRecordBlock } from "@herta/app-server";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithSession } from "../../testing/renderWithSession.js";
import { CARD_ROW_ENTER_MS, CARD_ROW_LEAVE_MS } from "./card-motion.js";
import { PlanCard } from "./PlanCard.js";
import { PLAN_HOLD_MS, PLAN_SLIDE_MS } from "./usePlanCard.js";

afterEach(() => {
  vi.useRealTimers();
});

type Status = "pending" | "in_progress" | "completed";

const items = (...rows: [string, Status][]) =>
  rows.map(([content, status]) => ({ content, status }));

const THREE = items(
  ["定位 bug", "completed"],
  ["修 cursor reset", "in_progress"],
  ["加回归测试", "pending"],
);

const todo = (
  completed: number,
  its = THREE,
  extra: Record<string, unknown> = {},
): TerminalRecordBlock =>
  ({
    kind: "system",
    label: "差分协处理器",
    body: `todo ${completed}/${its.length}`,
    digest: {
      kind: "todo",
      total: its.length,
      completed,
      items: its,
      ...extra,
    },
  }) as TerminalRecordBlock;

const doneMarker: TerminalRecordBlock = {
  kind: "system",
  label: "差分协处理器",
  body: "完成 · 1 个文件",
  role: "done-marker",
} as TerminalRecordBlock;

const beat: TerminalRecordBlock = {
  kind: "herta",
  surface: "speech",
  text: "游标没归位。",
} as TerminalRecordBlock;

/** Push blocks into the active session's record. */
function push(
  h: ReturnType<typeof renderWithSession>,
  ...blocks: TerminalRecordBlock[]
): void {
  act(() => {
    for (const [i, block] of blocks.entries()) {
      h.mock.emitRecord({
        kind: "block",
        blockId: `b${Date.now()}-${i}`,
        block,
      });
    }
  });
}

const card = () => document.querySelector('[data-testid="plan-card"]');
const isOpen = () => card()?.className.includes("is-open") ?? false;
const rows = () =>
  [...document.querySelectorAll(".plan-card__row")].map(
    (r) => r.querySelector(".plan-card__text")?.textContent ?? "",
  );

describe("PlanCard", () => {
  it("is absent for a session that never had a plan", () => {
    const h = renderWithSession(<PlanCard />);
    h.openSession();
    expect(card()).toBeNull();
  });

  it("slides out with one row per item when 板砖 projects a plan", () => {
    const h = renderWithSession(<PlanCard />);
    h.openSession();
    push(h, todo(1));
    expect(isOpen()).toBe(true);
    expect(rows()).toEqual(["定位 bug", "修 cursor reset", "加回归测试"]);
  });

  it("marks the three item states distinctly (check / caret / hollow)", () => {
    const h = renderWithSession(<PlanCard />);
    h.openSession();
    push(h, todo(1));
    const rows = [...document.querySelectorAll(".plan-card__row")];
    expect(rows[0]?.className).toContain("is-completed");
    expect(rows[1]?.className).toContain("is-in-progress");
    expect(rows[2]?.className).toContain("is-pending");
    // Form, not motion (2026-07-27): the current step is the CLI's ▸ caret,
    // matching plan-strip.ts's MARK triad — nothing in this card pulses; the
    // record's activity LED is the one live element during a dispatch.
    expect(rows[0]?.querySelector("svg")).not.toBeNull();
    expect(rows[1]?.querySelector(".plan-card__caret")).not.toBeNull();
    expect(rows[2]?.querySelector("svg")).toBeNull();
  });

  it("rows move on CHANGE, not on the first plan: an added step enters, a dropped step leaves then drops (ADR 0058 §5.7)", () => {
    vi.useFakeTimers();
    const h = renderWithSession(<PlanCard />);
    h.openSession();
    push(h, todo(1));
    // The first plan lands still — the card's slide is its entrance.
    expect(document.querySelector(".plan-card__row.is-entering")).toBeNull();
    // 板砖 adds a fourth step: only that row enters.
    push(h, todo(1, [...THREE, { content: "写文档", status: "pending" }]));
    const grown = [...document.querySelectorAll(".plan-card__row")];
    expect(grown.map((r) => r.classList.contains("is-entering"))).toEqual([
      false,
      false,
      false,
      true,
    ]);
    act(() => {
      vi.advanceTimersByTime(CARD_ROW_ENTER_MS + 5);
    });
    expect(document.querySelector(".plan-card__row.is-entering")).toBeNull();
    // The list shrinks to two: the last two rows leave in place, then drop.
    push(h, todo(1, THREE.slice(0, 2)));
    const shrunk = [...document.querySelectorAll(".plan-card__row")];
    expect(shrunk.map((r) => r.classList.contains("is-leaving"))).toEqual([
      false,
      false,
      true,
      true,
    ]);
    act(() => {
      vi.advanceTimersByTime(CARD_ROW_LEAVE_MS + 5);
    });
    expect(rows()).toEqual(["定位 bug", "修 cursor reset"]);
  });

  it("live-updates as steps advance, without closing", () => {
    const h = renderWithSession(<PlanCard />);
    h.openSession();
    push(h, todo(1));
    push(
      h,
      todo(
        2,
        items(
          ["定位 bug", "completed"],
          ["修 cursor reset", "completed"],
          ["加回归测试", "in_progress"],
        ),
      ),
    );
    expect(isOpen()).toBe(true);
    expect(document.querySelector(".plan-card__count")?.textContent).toBe(
      "2/3",
    );
    expect(
      document.querySelector(".plan-card__row.is-in-progress .plan-card__text")
        ?.textContent,
    ).toBe("加回归测试");
  });

  it("survives a beat splitting the dispatch — the whole point of the move", () => {
    const h = renderWithSession(<PlanCard />);
    h.openSession();
    push(h, todo(1), beat);
    expect(isOpen()).toBe(true);
    expect(rows()).toHaveLength(3);
  });

  it("HOLDS the settled plan past the done-marker, then slides back", () => {
    vi.useFakeTimers();
    const h = renderWithSession(<PlanCard />);
    h.openSession();
    push(h, todo(2));
    push(h, doneMarker);
    // Still open, still showing the final state: retracting on the marker
    // would pull the plan away at the exact moment the outcome lands.
    expect(isOpen()).toBe(true);
    expect(rows()).toHaveLength(3);

    act(() => {
      vi.advanceTimersByTime(PLAN_HOLD_MS - 100);
    });
    expect(isOpen()).toBe(true);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(isOpen()).toBe(false);
    // Content is KEPT through the slide-back — an emptied card would collapse
    // outward instead of gliding.
    expect(rows()).toHaveLength(3);

    // ...and once the slide has finished the card UNMOUNTS. Left mounted, its
    // padding box keeps its place in the rail's flex column: measured, 48px
    // of dead space (28px collapsed box + the 20px gap) under the device card
    // for the rest of the session, since content-visibility hides contents,
    // not the element (audit 2026-07-26).
    act(() => {
      vi.advanceTimersByTime(PLAN_SLIDE_MS + 50);
    });
    expect(card()).toBeNull();
  });

  it("a dispatch starting during the SLIDE-BACK cancels the unmount", () => {
    vi.useFakeTimers();
    const h = renderWithSession(<PlanCard />);
    h.openSession();
    push(h, todo(2));
    push(h, doneMarker);
    act(() => {
      vi.advanceTimersByTime(PLAN_HOLD_MS + 10);
    });
    expect(isOpen()).toBe(false); // sliding back
    push(h, todo(0, items(["赶上来的一步", "in_progress"])));
    act(() => {
      vi.advanceTimersByTime(PLAN_SLIDE_MS * 3);
    });
    expect(card()).not.toBeNull();
    expect(isOpen()).toBe(true);
    expect(rows()).toEqual(["赶上来的一步"]);
  });

  it("a second dispatch inside the hold window cancels the retract", () => {
    vi.useFakeTimers();
    const h = renderWithSession(<PlanCard />);
    h.openSession();
    push(h, todo(2));
    push(h, doneMarker);
    act(() => {
      vi.advanceTimersByTime(PLAN_HOLD_MS / 2);
    });
    // New dispatch starts before the old card finished retracting.
    push(h, todo(0, items(["新的一步", "in_progress"])));
    act(() => {
      vi.advanceTimersByTime(PLAN_HOLD_MS * 2);
    });
    expect(isOpen()).toBe(true);
    expect(rows()).toEqual(["新的一步"]);
  });

  it("a legacy digest with no items shows counts, not an empty plan", () => {
    const h = renderWithSession(<PlanCard />);
    h.openSession();
    act(() => {
      h.mock.emitRecord({
        kind: "block",
        blockId: "legacy",
        block: {
          kind: "system",
          label: "差分协处理器",
          body: "todo 2/5",
          digest: { kind: "todo", total: 5, completed: 2 },
        } as TerminalRecordBlock,
      });
    });
    expect(isOpen()).toBe(true);
    expect(rows()).toHaveLength(0);
    expect(document.querySelector(".plan-card__count")?.textContent).toBe(
      "2/5",
    );
    expect(document.querySelector(".plan-card__unknown")).not.toBeNull();
  });

  it("stills the in-flight pulse while a permission gate is pending", () => {
    const h = renderWithSession(<PlanCard />);
    h.openSession();
    push(h, todo(1));
    expect(card()?.className).not.toContain("is-waiting");
    act(() => {
      h.mock.emitOverlay({
        kind: "pending",
        overlay: {
          kind: "pending-permission",
          requestId: "r",
          risk: "workspace_write",
          tool: "edit_file",
          summary: "edit x",
        },
      });
    });
    // The step marked in_progress is NOT being worked — it is waiting on the
    // user, which is what the device card beside it already says.
    expect(card()?.className).toContain("is-waiting");
  });

  it("HOLDS the plan when the record window trimmed the scan (not a retract)", () => {
    vi.useFakeTimers();
    const h = renderWithSession(<PlanCard />);
    h.openSession();
    push(h, todo(1));
    expect(isOpen()).toBe(true);
    // Conversation trims the live window back to its tail bound on a long
    // dispatch, which can drop the todo projection out of the array. That is
    // the RENDERER dropping rows, not 板砖 finishing — reading it as an
    // ending would slide the plan away mid-run (audit 2026-07-26).
    act(() => {
      h.mock.emitRecord({
        kind: "reset",
        record: [
          {
            kind: "system",
            label: "差分协处理器",
            body: "Reading src/a.ts",
            digest: { kind: "op", verb: "Reading", arg: "src/a.ts" },
          } as TerminalRecordBlock,
        ],
        start: 400,
      } as never);
    });
    act(() => {
      vi.advanceTimersByTime(PLAN_HOLD_MS * 3);
    });
    expect(isOpen()).toBe(true);
    expect(rows()).toHaveLength(3);
  });

  // ── Lifecycle boundaries (audit 2026-07-24) ─────────────────────────────

  it("does not follow a session switch", () => {
    const h = renderWithSession(<PlanCard />);
    h.openSession("a");
    push(h, todo(1));
    expect(isOpen()).toBe(true);
    h.switchSession("b");
    expect(card()).toBeNull();
  });

  it("does not survive deleting the session it belongs to", () => {
    const h = renderWithSession(<PlanCard />);
    h.openSession("a");
    push(h, todo(1));
    h.deleteSession("a");
    expect(card()).toBeNull();
  });

  it("a retract armed in session A never fires against session B", () => {
    vi.useFakeTimers();
    const h = renderWithSession(<PlanCard />);
    h.openSession("a");
    push(h, todo(2));
    push(h, doneMarker); // arms the hold
    h.switchSession("b");
    push(h, todo(1)); // B opens its own plan inside A's hold window
    act(() => {
      vi.advanceTimersByTime(PLAN_HOLD_MS * 2);
    });
    // A's timer must not have closed B's card.
    expect(isOpen()).toBe(true);
  });
});
