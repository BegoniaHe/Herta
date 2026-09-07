import type { RepoContextSnapshot } from "@herta/app-server";
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { FileViewerProvider } from "../FileViewer/file-viewer-context.js";
import { dirtyMark, RepoCard } from "./RepoCard.js";
import { REPO_FOCUS_REFRESH_MIN_MS } from "./useRepoCard.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const SNAPSHOT = {
  sessionId: "s1",
  workspaceRoot: "/r",
  record: [],
  overlay: null,
  backendWorkspace: "/repo",
  backendWorkspaceIsDefault: false,
} as const;

const REPO: RepoContextSnapshot = {
  branch: "feat/repo-card",
  detached: false,
  headShort: "a1b2c3d",
  upstream: "origin/feat/repo-card",
  ahead: 2,
  behind: 1,
  defaultBranch: "main",
  inProgress: null,
  conflicted: [],
  dirty: [
    { x: " ", y: "M", path: "packages/gui/src/renderer/RepoCard.tsx" },
    { x: "A", y: " ", path: "docs/adr/0058.md" },
    { x: "?", y: "?", path: "scratch.txt" },
  ],
  dirtyTotal: 3,
  recentSubjects: ["a1b2c3d feat(gui): the rail shows the repository"],
};

function mount(withViewer = false) {
  const mock = createMockHertaBridge();
  const bridge = withViewer
    ? {
        ...mock.bridge,
        readWorkspaceFile: async () => ({ ok: true as const, text: "" }),
      }
    : mock.bridge;
  const card = <RepoCard />;
  const rendered = renderWithLocale(
    <HertaBridgeProvider bridge={bridge as typeof mock.bridge}>
      {withViewer ? <FileViewerProvider>{card}</FileViewerProvider> : card}
    </HertaBridgeProvider>,
    { locale: "zh" },
  );
  act(() => {
    mock.emitReset(SNAPSHOT);
  });
  return { mock, ...rendered };
}

describe("RepoCard (ADR 0058)", () => {
  it("is absent until the session's workspace answers as a repository, then slides in with branch, upstream, ↑↓, the dirty rows and the last commit", () => {
    const { mock, container } = mount();
    expect(container.querySelector(".repo-card")).toBeNull();
    act(() => {
      mock.emitRepo({ kind: "repo", workspace: "/repo", repo: REPO });
    });
    const card = container.querySelector(".repo-card");
    expect(card?.classList.contains("is-open")).toBe(true);
    expect(card?.textContent).toContain("feat/repo-card");
    expect(card?.textContent).toContain("origin/feat/repo-card");
    expect(card?.querySelector(".repo-card__delta")?.textContent).toBe("↑2 ↓1");
    expect(card?.querySelector(".plan-card__count")?.textContent).toBe(
      "3 处改动",
    );
    const rows = card?.querySelectorAll(".repo-card__row") ?? [];
    expect(rows.length).toBe(3);
    expect(rows[0]?.querySelector(".plan-card__mark")?.textContent).toBe("M");
    expect(rows[1]?.querySelector(".plan-card__mark")?.textContent).toBe("A");
    expect(rows[2]?.querySelector(".plan-card__mark")?.textContent).toBe("?");
    expect(rows[2]?.classList.contains("is-untracked")).toBe(true);
    expect(card?.querySelector(".repo-card__commit")?.textContent).toBe(
      REPO.recentSubjects[0],
    );
    // Without a file-reading bridge the paths are plain spans.
    expect(card?.querySelector("button.repo-card__path")).toBeNull();
  });

  it("a clean tree says so, an operation mid-flight is flagged with its conflicts, and a truncated list says how many more", () => {
    const { mock, container } = mount();
    act(() => {
      mock.emitRepo({
        kind: "repo",
        workspace: "/repo",
        repo: { ...REPO, dirty: [], dirtyTotal: 0, ahead: 0, behind: 0 },
      });
    });
    let card = container.querySelector(".repo-card");
    expect(card?.querySelector(".plan-card__count")?.textContent).toBe(
      "工作区干净",
    );
    expect(card?.querySelector(".repo-card__delta")).toBeNull();
    act(() => {
      mock.emitRepo({
        kind: "repo",
        workspace: "/repo",
        repo: {
          ...REPO,
          inProgress: "merge",
          conflicted: ["a.ts", "b.ts"],
          dirtyTotal: 45,
        },
      });
    });
    card = container.querySelector(".repo-card");
    expect(card?.querySelector(".repo-card__flag")?.textContent).toBe(
      "合并进行中 · 2 个冲突",
    );
    expect(card?.querySelector(".repo-card__more")?.textContent).toBe(
      "还有 42 项",
    );
  });

  it("a detached HEAD and an unborn branch are named honestly", () => {
    const { mock, container } = mount();
    act(() => {
      mock.emitRepo({
        kind: "repo",
        workspace: "/repo",
        repo: { ...REPO, branch: null, detached: true, upstream: null },
      });
    });
    expect(
      container.querySelector(".repo-card__branch-name")?.textContent,
    ).toBe("游离 HEAD");
    act(() => {
      mock.emitRepo({
        kind: "repo",
        workspace: "/repo",
        repo: {
          ...REPO,
          branch: null,
          detached: false,
          headShort: null,
          upstream: null,
          recentSubjects: [],
        },
      });
    });
    expect(
      container.querySelector(".repo-card__branch-name")?.textContent,
    ).toBe("尚无提交");
    expect(container.querySelector(".repo-card__commit")).toBeNull();
  });

  it("paths open in the file viewer where the bridge can read files", () => {
    const { mock, container } = mount(true);
    act(() => {
      mock.emitRepo({ kind: "repo", workspace: "/repo", repo: REPO });
    });
    const button = container.querySelector("button.repo-card__path");
    expect(button?.textContent).toBe("packages/gui/src/renderer/RepoCard.tsx");
  });

  it("a window focus asks the session to probe again, throttled", () => {
    vi.useFakeTimers();
    const { mock } = mount();
    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(mock.calls.refreshRepo).toBe(1);
    act(() => {
      vi.advanceTimersByTime(REPO_FOCUS_REFRESH_MIN_MS + 10);
      window.dispatchEvent(new Event("focus"));
    });
    expect(mock.calls.refreshRepo).toBe(2);
  });

  it("when the workspace stops being a repository the card retracts, then unmounts after the slide", () => {
    vi.useFakeTimers();
    const { mock, container } = mount();
    act(() => {
      mock.emitRepo({ kind: "repo", workspace: "/repo", repo: REPO });
    });
    expect(container.querySelector(".repo-card.is-open")).not.toBeNull();
    act(() => {
      mock.emitRepo({ kind: "repo", workspace: "/repo", repo: null });
    });
    const card = container.querySelector(".repo-card");
    expect(card).not.toBeNull();
    expect(card?.classList.contains("is-open")).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.querySelector(".repo-card")).toBeNull();
  });
});

describe("dirtyMark", () => {
  it("reads the worktree column first, the index column when the worktree is clean, and names conflicts and untracked files apart", () => {
    expect(dirtyMark({ x: " ", y: "M", path: "a" }).glyph).toBe("M");
    expect(dirtyMark({ x: "M", y: " ", path: "a" }).glyph).toBe("M");
    expect(dirtyMark({ x: "A", y: " ", path: "a" }).kind).toBe("added");
    expect(dirtyMark({ x: " ", y: "D", path: "a" }).kind).toBe("deleted");
    expect(dirtyMark({ x: "R", y: " ", path: "a" }).kind).toBe("renamed");
    expect(dirtyMark({ x: "?", y: "?", path: "a" }).kind).toBe("untracked");
    expect(dirtyMark({ x: "U", y: "U", path: "a" }).kind).toBe("conflict");
    expect(dirtyMark({ x: "A", y: "A", path: "a" }).glyph).toBe("!");
  });
});
