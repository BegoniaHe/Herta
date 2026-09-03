import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { renderWithSession } from "../../testing/renderWithSession.js";
import { FileViewerPanel } from "../FileViewer/FileViewerPanel.js";
import { FileViewerProvider } from "../FileViewer/file-viewer-context.js";
import { ActivityBlock, type ActivityBlockProps } from "./ActivityBlock.js";
import type { SystemBlock } from "./group-record.js";
import type { PlanContext, TodoDigestItem } from "./plan-context.js";

const step = (body: string): SystemBlock => ({
  kind: "system",
  label: "差分协处理器",
  body,
});
const done = (
  body: string,
  markerSummary?: SystemBlock["markerSummary"],
): SystemBlock => ({
  kind: "system",
  label: "差分协处理器",
  body,
  role: "done-marker",
  ...(markerSummary !== undefined ? { markerSummary } : {}),
});
const noop = (): SystemBlock => ({
  kind: "system",
  label: "差分协处理器",
  body: "无产出 — 这次没有触发任何文件、目录或命令操作。",
  role: "noop-marker",
});

/** A PlanContext as `planContext()` would return it, with the counts derived
 *  from the rows so a fixture can't quietly disagree with itself. */
function planOf(
  items: readonly TodoDigestItem[],
  opts: { itemsKnown?: boolean } = {},
): PlanContext {
  const current = items.find((i) => i.status === "in_progress")?.content;
  return {
    total: items.length,
    completed: items.filter((i) => i.status === "completed").length,
    ...(current !== undefined ? { current } : {}),
    items,
    itemsKnown: opts.itemsKnown ?? true,
  };
}

const THREE_STEP_PLAN = planOf([
  { content: "定位 bug", status: "completed" },
  { content: "修复 parser", status: "in_progress" },
  { content: "跑测试", status: "pending" },
]);

/** Existing cases render under the default UI locale "en" and assert English
 *  labels; record labels now follow the SESSION lang (this change), so default
 *  lang="en" here. A per-case `lang` overrides it — the parity cases below
 *  pass "zh" to prove the labels track the session, not the UI locale. */
function A(
  props: Omit<ActivityBlockProps, "lang"> & { lang?: "zh" | "en" },
): JSX.Element {
  const { lang = "en", ...rest } = props;
  return <ActivityBlock lang={lang} {...rest} />;
}

describe("ActivityBlock", () => {
  it("running: one collapsed line with LED, latest step, and live duration", () => {
    const { container } = renderWithLocale(
      <A
        blocks={[step("Reading scripts"), step("Writing a.ts")]}
        active={true}
        turnStartedAt={Date.now() - 3000}
        backendStartedAt={Date.now() - 3000}
      />,
    );
    // Default-collapsed while running — the panel is mounted (for the reveal
    // animation) but not open.
    expect(
      container.querySelector(".activity-line__history.is-open"),
    ).toBeNull();
    expect(container.querySelector(".activity-block")).toBeNull();
    const led = container.querySelector(".activity-line__led");
    expect(led).not.toBeNull();
    expect(led?.classList.contains("is-pulsing")).toBe(true);
    expect(screen.getByText("Coprocessor")).toBeInTheDocument();
    // The swap line shows the LATEST step.
    expect(container.querySelector(".swap-text__in")?.textContent).toBe(
      "Writing a.ts",
    );
    // …and it shimmers (continuous with the pending 处理中… shimmer) so the
    // working line reads as live even between step changes.
    expect(
      container
        .querySelector(".swap-text__in")
        ?.classList.contains("is-shimmer"),
    ).toBe(true);
    expect(container.querySelector(".activity-line__duration")).not.toBeNull();
  });

  it("running: the live line shows the latest OP, never a result row (bug 3)", () => {
    const { container } = renderWithLocale(
      <A
        blocks={[
          step("Running python3 scripts/merge_sort.py"),
          step("↳ exit 1 · 0 lines"),
        ]}
        active={true}
        turnStartedAt={Date.now() - 3000}
        backendStartedAt={Date.now() - 3000}
      />,
    );
    // "↳ exit 1 · 0 lines" as the "current activity" reads wrong — the op
    // that produced it stays the honest in-flight label.
    expect(container.querySelector(".swap-text__in")?.textContent).toBe(
      "Running python3 scripts/merge_sort.py",
    );
  });

  it("localizes op verbs from the digest under zh, keeping the canonical icon (bug 4)", () => {
    const opStep = (
      verb: "Reading" | "Writing" | "Running",
      arg: string,
    ): SystemBlock => ({
      kind: "system",
      label: "差分协处理器",
      body: `${verb} ${arg}`,
      digest: { kind: "op", verb, arg },
    });
    const { container } = renderWithLocale(
      <A
        lang="zh"
        blocks={[opStep("Writing", "scripts/a.py")]}
        active={true}
        turnStartedAt={Date.now() - 3000}
        backendStartedAt={Date.now() - 3000}
      />,
      { locale: "zh" },
    );
    // Display verb localized (D7: display-only — the canonical body keeps
    // the English verb; that is what Herta's prompt reads).
    expect(container.querySelector(".swap-text__in")?.textContent).toBe(
      "写入 scripts/a.py",
    );
    // Expanded history rows localize too, with the icon still keyed off the
    // canonical English body.
    fireEvent.click(container.querySelector(".activity-line") as Element);
    expect(
      container.querySelector(".activity-line__history .activity-step__body")
        ?.textContent,
    ).toBe("写入 scripts/a.py");
    expect(
      container.querySelector('.activity-step [data-icon="write"]'),
    ).not.toBeNull();
  });

  it("running: click expands the quiet history rows", () => {
    const { container } = renderWithLocale(
      <A
        blocks={[step("Reading scripts"), step("Writing a.ts")]}
        active={true}
        turnStartedAt={Date.now() - 3000}
        backendStartedAt={Date.now() - 3000}
      />,
    );
    expect(screen.getByRole("button")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    const history = container.querySelector(".activity-line__history.is-open");
    expect(history).not.toBeNull();
    expect(history?.textContent).toContain("Reading scripts");
    // The active row still shimmers in the history.
    expect(container.querySelectorAll(".activity-step.is-active")).toHaveLength(
      1,
    );
  });

  it("done: static dot, summary, duration label, chevron; toggles open", () => {
    const { container } = renderWithLocale(
      <A
        blocks={[step("Reading scripts"), done("完成 · 2 files")]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={null}
      />,
    );
    expect(screen.getByText("完成 · 2 files")).toBeInTheDocument();
    // Mounted but collapsed before the click.
    expect(
      container.querySelector(".activity-line__history.is-open"),
    ).toBeNull();
    expect(
      container.querySelector(".activity-line__led.is-pulsing"),
    ).toBeNull();
    expect(
      container.querySelector("svg.activity-line__chevron"),
    ).not.toBeNull();
    // No swap line when not running.
    expect(container.querySelector(".swap-text")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(
      container.querySelector(".activity-line__history.is-open"),
    ).not.toBeNull();
    expect(screen.getByText("Reading scripts")).toBeInTheDocument();
  });

  it("the toggle is the CONTENT, not the whole row — dead space is not clickable", () => {
    // Owner 2026-07-27: `.activity-line` was `width: 100%`, so the wide gap
    // between the summary and the right edge belonged to the button — the
    // cursor turned into a pointer over empty space and clicking there
    // expanded the row, with no affordance anywhere near the click.
    const { container } = renderWithLocale(
      <A
        blocks={[step("Reading scripts"), done("完成 · 2 files")]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={Date.now() - 5000}
      />,
    );
    const row = container.querySelector(".activity-line-row");
    const button = screen.getByRole("button");
    expect(row).not.toBeNull();
    // The button is a CHILD of the full-width row, not the row itself.
    expect(button.classList.contains("activity-line-row")).toBe(false);
    expect(row?.contains(button)).toBe(true);
    // The duration sits in the row, OUTSIDE the toggle: it is a fact about
    // the run, not part of the control's label — and it was what pinned the
    // button to the full row width.
    const duration = container.querySelector(".activity-line__duration");
    expect(duration).not.toBeNull();
    expect(button.contains(duration)).toBe(false);
    // Everything the user can see as "the toggle" is still inside it.
    expect(button.querySelector(".activity-line__led")).not.toBeNull();
    expect(button.querySelector(".activity-line__summary")).not.toBeNull();
    expect(button.querySelector("svg.activity-line__chevron")).not.toBeNull();
  });

  it("done with only a terminal marker (no steps): no chevron, nothing to expand", () => {
    // Bug 1: a group that is just 完成 · 1 file has no operational rows behind
    // the chevron — so there must be no chevron, no toggle, no empty panel.
    const { container } = renderWithLocale(
      <A
        blocks={[done("完成 · 1 file")]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={null}
      />,
    );
    expect(screen.getByText("完成 · 1 file")).toBeInTheDocument();
    expect(container.querySelector("svg.activity-line__chevron")).toBeNull();
    expect(container.querySelector(".activity-line__history")).toBeNull();
    // The line is not an expandable toggle, and clicking reveals nothing.
    const btn = screen.getByRole("button");
    expect(btn).not.toHaveAttribute("aria-expanded");
    fireEvent.click(btn);
    expect(container.querySelector(".activity-line__history")).toBeNull();
  });

  it("structured marker: composes a localized summary (en) instead of the body", () => {
    renderWithLocale(
      <A
        blocks={[
          step("Reading scripts"),
          done("完成 · 2 files", {
            kind: "done",
            state: "completed",
            fileCount: 2,
            riskCount: 0,
          }),
        ]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={null}
      />,
      { locale: "en" },
    );
    // The English header reads from the structured marker, NOT the canonical
    // Chinese body — the body never appears in en mode.
    expect(screen.getByText("Done · 2 files")).toBeInTheDocument();
    expect(screen.queryByText("完成 · 2 files")).toBeNull();
  });

  it("structured marker: composes the same summary in zh", () => {
    renderWithLocale(
      <A
        lang="zh"
        blocks={[
          done("完成 · 1 file · tests 1/1", {
            kind: "done",
            state: "completed",
            fileCount: 1,
            tests: { passed: 1, failed: 0 },
            riskCount: 0,
          }),
        ]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={null}
      />,
      { locale: "zh" },
    );
    expect(screen.getByText("完成 · 1 个文件 · 测试 1/1")).toBeInTheDocument();
  });

  it("noop marker: renders the localized no-output word (en)", () => {
    renderWithLocale(
      <A
        blocks={[noop()]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={null}
      />,
      {
        locale: "en",
      },
    );
    expect(screen.getByText("No output")).toBeInTheDocument();
  });

  it("shows no duration for a historical group (never active, no start)", () => {
    const { container } = renderWithLocale(
      <A
        blocks={[step("Reading"), done("完成 · 1 file")]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={null}
      />,
    );
    expect(container.querySelector(".activity-line__duration")).toBeNull();
  });

  it("anchors elapsed duration to backendStartedAt, NOT turnStartedAt, when both are set", () => {
    // turnStartedAt is 80s ago (Herta's turn start, inflated by speech time).
    // backendStartedAt is 3s ago (actual 板砖 dispatch).
    // The displayed duration must be ~3s, NOT ~1:20.
    const turnStartedAt = Date.now() - 80_000;
    const backendStartedAt = Date.now() - 3_000;
    const { container } = renderWithLocale(
      <A
        blocks={[step("Reading a.ts")]}
        active={true}
        turnStartedAt={turnStartedAt}
        backendStartedAt={backendStartedAt}
      />,
    );
    const durationEl = container.querySelector(".activity-line__duration");
    expect(durationEl).not.toBeNull();
    const text = durationEl?.textContent ?? "";
    // Should show something like "3s" — definitely not "1:20" or anything over 10s.
    expect(text).toMatch(/^\d+s$/);
    const seconds = parseInt(text, 10);
    expect(seconds).toBeLessThan(10);
  });

  it("intermediate split part (frozen, not the 完成 part): shows no duration", () => {
    // A backend run split by a beat: this part was live, then a beat interrupted
    // it (active → false) with NO terminal marker. Only the final 完成 part shows
    // the total, so an intermediate part renders no duration (one per run).
    const backendStartedAt = Date.now() - 3000;
    const { container, rerender } = renderWithLocale(
      <A
        blocks={[step("Reading a.ts")]}
        active={true}
        turnStartedAt={null}
        backendStartedAt={backendStartedAt}
      />,
    );
    // Active → a live duration shows.
    expect(container.querySelector(".activity-line__duration")).not.toBeNull();
    // Beat interrupts: freeze, still no terminal marker.
    rerender(
      <A
        blocks={[step("Reading a.ts")]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={backendStartedAt}
      />,
    );
    expect(container.querySelector(".activity-line__duration")).toBeNull();
  });

  it("final split part (frozen, with 完成): shows the single total duration", () => {
    const backendStartedAt = Date.now() - 3000;
    const { container, rerender } = renderWithLocale(
      <A
        blocks={[step("Reading a.ts")]}
        active={true}
        turnStartedAt={null}
        backendStartedAt={backendStartedAt}
      />,
    );
    // The run completes: 完成 lands and the part goes inactive → shows the total.
    rerender(
      <A
        blocks={[step("Reading a.ts"), done("完成 · 1 file")]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={backendStartedAt}
      />,
    );
    expect(container.querySelector(".activity-line__duration")).not.toBeNull();
  });

  it("born-done final part (beat split it before 完成): shows the run total from backendStartedAt", () => {
    // The last beat fired right before 完成, so the final part is JUST [完成] and
    // was never active — no live timing. It must still show the whole-run total
    // (完成.at − backendStartedAt), frozen while backendStartedAt is still set.
    const now = Date.now();
    const backendStartedAt = now - 5000;
    const doneBlock: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "完成 · 1 file",
      role: "done-marker",
      at: new Date(now).toISOString(),
    };
    const { container } = renderWithLocale(
      <A
        blocks={[doneBlock]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={backendStartedAt}
      />,
    );
    const durationEl = container.querySelector(".activity-line__duration");
    expect(durationEl).not.toBeNull();
    // 完成 at `now`, backend started 5s earlier → total reads 5s.
    expect(durationEl?.textContent ?? "").toMatch(/\b5s\b/);
  });

  it("record labels follow the SESSION lang, not the UI locale (parity with @Brick)", () => {
    // UI locale is EN (renderWithLocale default) but the session is zh: the
    // coprocessor chip renders in Chinese, proving the activity line tracks the
    // session interaction language, not the app chrome.
    renderWithLocale(
      <A
        lang="zh"
        blocks={[step("Reading a.ts")]}
        active={true}
        turnStartedAt={Date.now() - 1000}
        backendStartedAt={Date.now() - 1000}
      />,
    );
    expect(screen.getByText("差分协处理器")).toBeInTheDocument();
    expect(screen.queryByText("Coprocessor")).toBeNull();
  });

  it("mirror: UI locale zh but session en → English chip + done-marker", () => {
    const { container } = renderWithLocale(
      <A
        lang="en"
        blocks={[
          step("Reading a.ts"),
          done("完成 · 1 file", {
            kind: "done",
            state: "completed",
            fileCount: 1,
            riskCount: 0,
          }),
        ]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={null}
      />,
      { locale: "zh" },
    );
    expect(screen.getByText("Coprocessor")).toBeInTheDocument();
    expect(screen.queryByText("差分协处理器")).toBeNull();
    // The done-marker summary is composed from the structured markerSummary in
    // English too — "Done", not 完成.
    expect(container.textContent).toContain("Done");
  });
});

describe("ActivityBlock live plan strip", () => {
  it("renders one row per todo item under the status line while the run is live", () => {
    const { container } = renderWithLocale(
      <A
        blocks={[step("Reading a.ts")]}
        active={true}
        turnStartedAt={Date.now() - 1000}
        backendStartedAt={Date.now() - 1000}
        plan={THREE_STEP_PLAN}
      />,
    );
    const rows = container.querySelectorAll(".activity-plan__row");
    expect(rows).toHaveLength(3);
    expect([...rows].map((r) => r.textContent)).toEqual([
      "定位 bug",
      "修复 parser",
      "跑测试",
    ]);
    // The item text is backend-authored and renders VERBATIM (D7) — the same
    // string the record shows Herta, never translated.
    expect(rows[0]?.getAttribute("title")).toBe("定位 bug");
    // The strip is a SIBLING of the collapsible history, not a child: the
    // history animates a measured max-height and must not see this growth.
    expect(
      container.querySelector(".activity-line__history .activity-plan"),
    ).toBeNull();
    expect(container.querySelector(".activity-plan")).not.toBeNull();
    // …and the header keeps doing its own job (latest op + duration).
    expect(container.querySelector(".swap-text__in")?.textContent).toBe(
      "Reading a.ts",
    );
  });

  it("marks the three item states distinctly (check / caret / hollow)", () => {
    const { container } = renderWithLocale(
      <A
        blocks={[step("Reading a.ts")]}
        active={true}
        turnStartedAt={Date.now() - 1000}
        backendStartedAt={Date.now() - 1000}
        plan={THREE_STEP_PLAN}
      />,
    );
    const rows = [...container.querySelectorAll(".activity-plan__row")];
    expect(rows[0]?.className).toContain("is-completed");
    expect(rows[1]?.className).toContain("is-in-progress");
    expect(rows[2]?.className).toContain("is-pending");
    // The mark triad is FORM, not motion (2026-07-27): ✓ on done, the CLI's
    // ▸ caret on the current step, and a bare marker (hollow ring via CSS)
    // on pending. Nothing in the strip pulses — the header LED is the pulse.
    expect(container.querySelectorAll(".activity-plan__check")).toHaveLength(1);
    expect(rows[0]?.querySelector(".activity-plan__check")).not.toBeNull();
    expect(container.querySelectorAll(".activity-plan__caret")).toHaveLength(1);
    expect(rows[1]?.querySelector(".activity-plan__caret")).not.toBeNull();
    expect(rows[2]?.querySelector("svg")).toBeNull();
  });

  it("no plan prop → no strip (a dispatch that never wrote a todo list)", () => {
    const { container } = renderWithLocale(
      <A
        blocks={[step("Reading a.ts")]}
        active={true}
        turnStartedAt={Date.now() - 1000}
        backendStartedAt={Date.now() - 1000}
      />,
    );
    expect(container.querySelector(".activity-plan")).toBeNull();
  });

  it("inactive group → no strip, even if a plan is handed to it", () => {
    // The strip is LIVE status. Conversation already withholds the plan from
    // a historical group; this is the component's own third guard, so a
    // finished run can never claim to still be working through a plan.
    const { container } = renderWithLocale(
      <A
        blocks={[step("Reading a.ts"), done("完成 · 1 file")]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={null}
        plan={THREE_STEP_PLAN}
      />,
    );
    expect(container.querySelector(".activity-plan")).toBeNull();
    // The collapsed done rendering is untouched.
    expect(screen.getByText("完成 · 1 file")).toBeInTheDocument();
    expect(
      container.querySelector("svg.activity-line__chevron"),
    ).not.toBeNull();
  });

  it("the run ending removes the strip and leaves the done rendering alone", () => {
    const backendStartedAt = Date.now() - 3000;
    const { container, rerender } = renderWithLocale(
      <A
        blocks={[step("Reading a.ts")]}
        active={true}
        turnStartedAt={null}
        backendStartedAt={backendStartedAt}
        plan={THREE_STEP_PLAN}
      />,
    );
    expect(container.querySelectorAll(".activity-plan__row")).toHaveLength(3);
    // 完成 lands: Conversation stops passing a live plan (planContext stops at
    // the terminal marker) AND the group goes inactive.
    rerender(
      <A
        blocks={[step("Reading a.ts"), done("完成 · 1 file")]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={backendStartedAt}
        plan={null}
      />,
    );
    expect(container.querySelector(".activity-plan")).toBeNull();
    expect(container.querySelector(".activity-line__duration")).not.toBeNull();
  });

  it("a pre-2026-07-26 digest (itemsKnown false) draws no rows, not empty ones", () => {
    // The list is UNKNOWN, not empty — inventing rows from the counts would
    // be fabrication. The header's 步骤 k/n keeps working.
    const { container } = renderWithLocale(
      <A
        blocks={[step("Reading a.ts")]}
        active={true}
        turnStartedAt={Date.now() - 1000}
        backendStartedAt={Date.now() - 1000}
        plan={{
          total: 4,
          completed: 2,
          current: "修复",
          items: [],
          itemsKnown: false,
        }}
      />,
    );
    expect(container.querySelector(".activity-plan")).toBeNull();
  });

  it("a genuinely empty plan draws no strip either", () => {
    const { container } = renderWithLocale(
      <A
        blocks={[step("Reading a.ts")]}
        active={true}
        turnStartedAt={Date.now() - 1000}
        backendStartedAt={Date.now() - 1000}
        plan={planOf([])}
      />,
    );
    expect(container.querySelector(".activity-plan")).toBeNull();
  });

  it("caps the visible rows at 8 and tails the rest with a localized +n more", () => {
    const items: TodoDigestItem[] = Array.from({ length: 11 }, (_, i) => ({
      content: `step ${i + 1}`,
      status: i === 0 ? "completed" : "pending",
    }));
    const { container } = renderWithLocale(
      <A
        blocks={[step("Reading a.ts")]}
        active={true}
        turnStartedAt={Date.now() - 1000}
        backendStartedAt={Date.now() - 1000}
        plan={planOf(items)}
      />,
    );
    // 8 item rows + the tail row.
    expect(container.querySelectorAll(".activity-plan__row")).toHaveLength(9);
    expect(screen.getByText("step 8")).toBeInTheDocument();
    expect(screen.queryByText("step 9")).toBeNull();
    expect(container.querySelector(".activity-plan__more")?.textContent).toBe(
      "+3 more",
    );
  });

  it("exactly 8 items: all shown, no tail row", () => {
    const items: TodoDigestItem[] = Array.from({ length: 8 }, (_, i) => ({
      content: `step ${i + 1}`,
      status: "pending",
    }));
    const { container } = renderWithLocale(
      <A
        blocks={[step("Reading a.ts")]}
        active={true}
        turnStartedAt={Date.now() - 1000}
        backendStartedAt={Date.now() - 1000}
        plan={planOf(items)}
      />,
    );
    expect(container.querySelectorAll(".activity-plan__row")).toHaveLength(8);
    expect(container.querySelector(".activity-plan__more")).toBeNull();
  });

  it("the +n more chrome follows the SESSION lang, not the UI locale", () => {
    // UI locale EN, session zh (ADR 0018/0019): the tail row is Chinese while
    // the item text — backend-authored — is untouched either way.
    const items: TodoDigestItem[] = Array.from({ length: 10 }, (_, i) => ({
      content: `step ${i + 1}`,
      status: "pending",
    }));
    const { container } = renderWithLocale(
      <A
        lang="zh"
        blocks={[step("Reading a.ts")]}
        active={true}
        turnStartedAt={Date.now() - 1000}
        backendStartedAt={Date.now() - 1000}
        plan={planOf(items)}
      />,
      { locale: "en" },
    );
    expect(container.querySelector(".activity-plan__more")?.textContent).toBe(
      "还有 2 项",
    );
    expect(container.querySelector(".activity-plan")).toHaveAttribute(
      "aria-label",
      "任务清单",
    );
  });

  it("the strip does not disturb the history panel's expand toggle", () => {
    const { container } = renderWithLocale(
      <A
        blocks={[step("Reading a.ts"), step("Writing b.ts")]}
        active={true}
        turnStartedAt={Date.now() - 1000}
        backendStartedAt={Date.now() - 1000}
        plan={THREE_STEP_PLAN}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    const history = container.querySelector(".activity-line__history.is-open");
    expect(history).not.toBeNull();
    expect(history?.textContent).toContain("Reading a.ts");
    // The plan rows live outside the panel, so opening it neither duplicates
    // nor swallows them.
    expect(container.querySelectorAll(".activity-plan")).toHaveLength(1);
    expect(history?.querySelector(".activity-plan__row")).toBeNull();
  });
});

describe("ActivityBlock — attachment groups (ADR 0033, owner 2026-08-10)", () => {
  const attach = (name: string, over: { at?: string } = {}): SystemBlock => ({
    kind: "system",
    label: "系统",
    body: `附件 ${name} · 87 行 · 1.3K 字 · .herta/attachments/s/${name}`,
    digest: {
      kind: "attachment",
      name,
      path: `.herta/attachments/s/${name}`,
      lines: 87,
      chars: 1300,
    },
    ...over,
  });

  it("defaults OPEN — the filenames are the point of the row", () => {
    const { container } = renderWithLocale(
      <A
        blocks={[attach("spec.md"), attach("notes.txt")]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={null}
      />,
    );
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "true",
    );
    const history = container.querySelector(".activity-line__history.is-open");
    expect(history).not.toBeNull();
    expect(history?.textContent).toContain("spec.md");
    expect(history?.textContent).toContain("notes.txt");
    // …with the composer's paperclip glyph, not the generic dot.
    expect(history?.querySelector('[data-icon="attach"]')).not.toBeNull();
  });

  it("the user can still collapse it", () => {
    const { container } = renderWithLocale(
      <A
        blocks={[attach("spec.md")]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={null}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(
      container.querySelector(".activity-line__history.is-open"),
    ).toBeNull();
  });

  it("a mixed group counts as backend activity and stays collapsed", () => {
    renderWithLocale(
      <A
        blocks={[attach("spec.md"), step("Reading a.ts")]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={null}
      />,
    );
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("shortens a long filename from the MIDDLE, keeping the extension", () => {
    // Owner 2026-08-10: a long name wrapped the row onto three lines. The
    // extension is the most informative part, so the cut is in the middle.
    const long =
      "jiuwen-vs-aisf-sysagent-multi-intent-summary-20260806-超级无敌长的文件-这个文件就很长长长长长.txt";
    renderWithLocale(
      <A
        blocks={[
          {
            ...attach("x"),
            digest: {
              kind: "attachment",
              name: long,
              path: ".herta/attachments/s/x.txt",
              lines: 3,
              chars: 128,
            },
          },
        ]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={null}
      />,
    );
    const row = screen.getByText(/jiuwen-vs-aisf/);
    expect(row.textContent).toContain("…");
    expect(row.textContent).toContain(".txt");
    expect(row.textContent).not.toContain(long);
    // The record itself is untouched — only the row is shortened.
    expect(long.length).toBeGreaterThan(60);
  });

  it("offers a take-back only where it can work, and passes the stored path", () => {
    const removed: string[] = [];
    const { container } = renderWithLocale(
      <A
        blocks={[
          attach("spec.md"),
          // Already withdrawn — no second ✕.
          {
            ...attach("old.md"),
            digest: {
              kind: "attachment",
              name: "old.md",
              path: ".herta/attachments/s/old.md",
              lines: 0,
              chars: 0,
              unreadable: "removed",
            },
          },
          // Nothing on disk to delete — no ✕ either.
          {
            ...attach("id_rsa"),
            digest: {
              kind: "attachment",
              name: "id_rsa",
              path: "",
              lines: 0,
              chars: 0,
              unreadable: "denied",
            },
          },
        ]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={null}
        onRemoveAttachment={(p) => () => removed.push(p)}
      />,
    );
    const buttons = container.querySelectorAll(".activity-step__remove");
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0] as Element);
    expect(removed).toEqual([".herta/attachments/s/spec.md"]);
  });

  it("a document's row opens the ORIGINAL in the viewer and takes it back by whichever path it has (ADR 0038 amendment / ADR 0054)", async () => {
    const removed: string[] = [];
    const mock = createMockHertaBridge();
    const readWorkspaceFile = vi.fn(async () => ({
      ok: true as const,
      content: "",
      truncated: false,
      size: 0,
      relative: "x",
    }));
    const readWorkspaceBytes = vi.fn(async (_s: string, p: string) => ({
      ok: true as const,
      bytes: new Uint8Array([1]),
      size: 1,
      relative: p,
    }));
    Object.assign(mock.bridge, { readWorkspaceFile, readWorkspaceBytes });
    const h = renderWithSession(
      <FileViewerProvider>
        <A
          blocks={[
            // A PDF with its text extracted: the row names the PDF, the
            // viewer draws the PDF, the take-back addresses the TEXT path.
            {
              ...attach("report.pdf"),
              digest: {
                kind: "attachment",
                name: "report.pdf",
                path: ".herta/attachments/s/report-ab12cd34.pdf.txt",
                source: ".herta/attachments/s/report-ab12cd34.pdf",
                lines: 40,
                chars: 900,
                format: "pdf",
                pages: 2,
              },
            },
            // A spreadsheet: no text for 板砖, the file itself for the
            // viewer, the take-back addresses the SOURCE path.
            {
              ...attach("sheet.xlsx"),
              digest: {
                kind: "attachment",
                name: "sheet.xlsx",
                path: "",
                source: ".herta/attachments/s/sheet-ab12cd34.xlsx",
                lines: 0,
                chars: 0,
                unreadable: "unsupported",
              },
            },
          ]}
          active={false}
          turnStartedAt={null}
          backendStartedAt={null}
          onRemoveAttachment={(p) => () => removed.push(p)}
        />
        <FileViewerPanel />
      </FileViewerProvider>,
      { mock },
    );
    h.openSession("s1");
    const names = h.container.querySelectorAll(".file-open-name");
    expect([...names].map((n) => n.textContent)).toEqual([
      "report.pdf",
      "sheet.xlsx",
    ]);
    fireEvent.click(names[1] as Element);
    await waitFor(() =>
      expect(readWorkspaceBytes).toHaveBeenCalledWith(
        "s1",
        ".herta/attachments/s/sheet-ab12cd34.xlsx",
      ),
    );
    fireEvent.click(names[0] as Element);
    await waitFor(() =>
      expect(readWorkspaceBytes).toHaveBeenCalledWith(
        "s1",
        ".herta/attachments/s/report-ab12cd34.pdf",
      ),
    );
    expect(readWorkspaceFile).not.toHaveBeenCalled();
    const xs = h.container.querySelectorAll(".activity-step__remove");
    expect(xs).toHaveLength(2);
    fireEvent.click(xs[0] as Element);
    fireEvent.click(xs[1] as Element);
    expect(removed).toEqual([
      ".herta/attachments/s/report-ab12cd34.pdf.txt",
      ".herta/attachments/s/sheet-ab12cd34.xlsx",
    ]);
  });

  it("shows no take-back at all when the factory is absent (mid-turn)", () => {
    // Conversation withholds the factory while a turn runs — the removal
    // rides the same out-of-turn record write as the attach, so an ✕ that
    // could only earn a refusal is not rendered.
    const { container } = renderWithLocale(
      <A
        blocks={[attach("spec.md")]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={null}
      />,
    );
    expect(container.querySelector(".activity-step__remove")).toBeNull();
  });

  it("a removed attachment renders its state instead of counts", () => {
    renderWithLocale(
      <A
        blocks={[
          {
            ...attach("spec.md"),
            body: "附件 spec.md · 已移除",
            digest: {
              kind: "attachment",
              name: "spec.md",
              path: ".herta/attachments/s/spec.md",
              lines: 0,
              chars: 0,
              unreadable: "removed",
            },
          },
        ]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={null}
      />,
    );
    expect(
      screen.getByText(/attachment spec\.md · removed/i),
    ).toBeInTheDocument();
  });

  it("a LIVE attach mounts with the entrance; a loaded one does not", () => {
    // Recency-gated off the block's own `at` stamp, decided once at mount —
    // no store flag, no cross-component state (the 2026-07-24 audit class).
    const live = renderWithLocale(
      <A
        blocks={[attach("spec.md", { at: new Date().toISOString() })]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={null}
      />,
    );
    expect(live.container.querySelector(".is-attach-enter")).not.toBeNull();
    live.unmount();

    const loaded = renderWithLocale(
      <A
        blocks={[
          attach("spec.md", {
            at: new Date(Date.now() - 60_000).toISOString(),
          }),
        ]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={null}
      />,
    );
    expect(loaded.container.querySelector(".is-attach-enter")).toBeNull();
    loaded.unmount();

    // No timestamp at all (pre-stamp records): never animate.
    const unstamped = renderWithLocale(
      <A
        blocks={[attach("spec.md")]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={null}
      />,
    );
    expect(unstamped.container.querySelector(".is-attach-enter")).toBeNull();
  });

  it("a recent backend group never borrows the attach entrance", () => {
    const { container } = renderWithLocale(
      <A
        blocks={[
          {
            ...step("Reading a.ts"),
            at: new Date().toISOString(),
          },
        ]}
        active={false}
        turnStartedAt={null}
        backendStartedAt={null}
      />,
    );
    expect(container.querySelector(".is-attach-enter")).toBeNull();
  });
});
