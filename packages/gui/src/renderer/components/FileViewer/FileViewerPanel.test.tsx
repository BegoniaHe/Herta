import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { renderWithSession } from "../../testing/renderWithSession.js";
import { FileViewerPanel } from "./FileViewerPanel.js";
import {
  FileViewerProvider,
  useFileViewerOpen,
} from "./file-viewer-context.js";

// jsdom has no object URLs; the picture renderer mints one per image.
if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:jsdom";
  URL.revokeObjectURL = () => undefined;
}

function Probe(): JSX.Element {
  const open = useFileViewerOpen();
  return (
    <>
      <button
        type="button"
        data-testid="probe"
        data-available={open !== null}
        onClick={() => open?.("src/a.ts")}
      >
        open
      </button>
      <button
        type="button"
        data-testid="probe-png"
        onClick={() => open?.("shots/one.png")}
      >
        open png
      </button>
      <button
        type="button"
        data-testid="probe-md"
        onClick={() => open?.("docs/notes.md")}
      >
        open md
      </button>
      <button
        type="button"
        data-testid="probe-md-anchored"
        onClick={() => open?.("docs/notes.md", { anchor: { from: 1, to: 1 } })}
      >
        open md anchored
      </button>
      <button
        type="button"
        data-testid="probe-b"
        onClick={() => open?.("src/b.ts")}
      >
        open b
      </button>
      <button
        type="button"
        data-testid="probe-anchored"
        onClick={() => open?.("src/a.ts", { anchor: { from: 2, to: 3 } })}
      >
        open anchored
      </button>
    </>
  );
}

function ui(): JSX.Element {
  return (
    <FileViewerProvider>
      <Probe />
      <FileViewerPanel />
    </FileViewerProvider>
  );
}

describe("FileViewerPanel (ADR 0050)", () => {
  it("without the bridge method the opener is null — nothing is clickable", () => {
    const h = renderWithSession(ui());
    h.openSession("s1");
    expect(screen.getByTestId("probe").dataset.available).toBe("false");
  });

  it("opens, reads through the bridge, and shows the file with line numbers", async () => {
    const mock = createMockHertaBridge();
    const readWorkspaceFile = vi.fn(async () => ({
      ok: true as const,
      content: "one\ntwo\n",
      truncated: false,
      size: 8,
      relative: "src/a.ts",
    }));
    Object.assign(mock.bridge, { readWorkspaceFile });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    expect(screen.getByTestId("probe").dataset.available).toBe("true");
    fireEvent.click(screen.getByTestId("probe"));
    await waitFor(() =>
      expect(screen.getByTestId("file-viewer")).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelector(".file-viewer__text")
          ?.textContent,
      ).toContain("one\ntwo"),
    );
    expect(readWorkspaceFile).toHaveBeenCalledWith("s1", "src/a.ts");
    // The tab chip names the file (v1.5 — the tab strip replaced the crumb).
    expect(
      screen.getByTestId("file-viewer").querySelector(".file-viewer__tab-name")
        ?.textContent,
    ).toBe("a.ts");
  });

  it("a vanished file answers with the honest notice, not a blank panel", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: false as const,
        reason: "not_found" as const,
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe"));
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelector(".file-viewer__notice")
          ?.textContent,
      ).toContain("no longer exists"),
    );
  });

  it("tabs: two opens make two chips, activate swaps, × closes one (ADR 0050 v1.5)", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async (_sid: string, p: string) => ({
        ok: true as const,
        content: `content of ${p}\n`,
        truncated: false,
        size: 10,
        relative: p,
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe"));
    await waitFor(() =>
      expect(screen.getByTestId("file-viewer")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("probe-b"));
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelectorAll(".file-viewer__tab")
          .length,
      ).toBe(2),
    );
    // The newest tab is active and shown.
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelector(".file-viewer__text")
          ?.textContent,
      ).toContain("content of src/b.ts"),
    );
    // Re-opening an open path activates its tab instead of duplicating.
    fireEvent.click(screen.getByTestId("probe"));
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelector(".file-viewer__text")
          ?.textContent,
      ).toContain("content of src/a.ts"),
    );
    expect(
      screen.getByTestId("file-viewer").querySelectorAll(".file-viewer__tab")
        .length,
    ).toBe(2);
    // Clicking the other chip swaps back.
    const chips = screen
      .getByTestId("file-viewer")
      .querySelectorAll(".file-viewer__tab-name");
    fireEvent.click(chips[1] as Element);
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelector(".file-viewer__text")
          ?.textContent,
      ).toContain("content of src/b.ts"),
    );
    // × on the active chip closes it; the other remains shown.
    const xs = screen
      .getByTestId("file-viewer")
      .querySelectorAll(".file-viewer__tab-x");
    fireEvent.click(xs[1] as Element);
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelectorAll(".file-viewer__tab")
          .length,
      ).toBe(1),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelector(".file-viewer__text")
          ?.textContent,
      ).toContain("content of src/a.ts"),
    );
  });

  it("a cite anchor renders the highlight band over the cited lines", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: true as const,
        content: "l1\nl2\nl3\nl4\n",
        truncated: false,
        size: 12,
        relative: "src/a.ts",
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-anchored"));
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelector(".file-viewer__anchor"),
      ).not.toBeNull(),
    );
    const band = screen
      .getByTestId("file-viewer")
      .querySelector(".file-viewer__anchor") as HTMLElement;
    // Lines 2-3 at the jsdom fallback line height (19.2px): one line down,
    // two lines tall.
    expect(Number.parseFloat(band.style.top)).toBeCloseTo(19.2, 1);
    expect(Number.parseFloat(band.style.height)).toBeCloseTo(38.4, 1);
  });

  it("Escape closes; a session SWITCH closes too (the transient-state boundary)", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: true as const,
        content: "x",
        truncated: false,
        size: 1,
        relative: "a.txt",
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe"));
    await waitFor(() =>
      expect(screen.getByTestId("file-viewer")).toBeInTheDocument(),
    );
    fireEvent.keyDown(screen.getByTestId("file-viewer"), { key: "Escape" });
    expect(screen.queryByTestId("file-viewer")).toBeNull();

    fireEvent.click(screen.getByTestId("probe"));
    await waitFor(() =>
      expect(screen.getByTestId("file-viewer")).toBeInTheDocument(),
    );
    h.switchSession("s2");
    expect(screen.queryByTestId("file-viewer")).toBeNull();
  });
});

describe("FileViewerPanel — the file's kind picks the read and the renderer (ADR 0054)", () => {
  it("a picture takes the BYTES read, not the text read, and draws through <img>", async () => {
    const mock = createMockHertaBridge();
    const readWorkspaceFile = vi.fn(async () => ({
      ok: true as const,
      content: "",
      truncated: false,
      size: 0,
      relative: "x",
    }));
    const readWorkspaceBytes = vi.fn(async () => ({
      ok: true as const,
      bytes: new Uint8Array([137, 80, 78, 71]),
      size: 4,
      relative: "shots/one.png",
    }));
    Object.assign(mock.bridge, { readWorkspaceFile, readWorkspaceBytes });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-png"));
    await waitFor(() =>
      expect(
        screen
          .getByTestId("file-viewer")
          .querySelector("img.file-viewer__image"),
      ).not.toBeNull(),
    );
    expect(readWorkspaceBytes).toHaveBeenCalledWith("s1", "shots/one.png");
    expect(readWorkspaceFile).not.toHaveBeenCalled();
    expect(screen.getByTestId("file-viewer").dataset.kind).toBe("image");
  });

  it("without the bytes read (an older bridge) a picture falls to the text read's binary notice", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: false as const,
        reason: "binary" as const,
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-png"));
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelector(".file-viewer__notice")
          ?.textContent,
      ).toContain("Binary file"),
    );
  });

  it("a file over the bytes ceiling answers with the honest notice", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(),
      readWorkspaceBytes: vi.fn(async () => ({
        ok: false as const,
        reason: "too_large" as const,
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-png"));
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelector(".file-viewer__notice")
          ?.textContent,
      ).toContain("Too large"),
    );
  });

  it("Markdown renders as the page; the header toggle swaps to the source with line numbers and back", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: true as const,
        content: "# Hello\n\ntext\n",
        truncated: false,
        size: 14,
        relative: "docs/notes.md",
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-md"));
    const panel = () => screen.getByTestId("file-viewer");
    await waitFor(() =>
      expect(panel().querySelector(".file-viewer__doc h1")?.textContent).toBe(
        "Hello",
      ),
    );
    expect(panel().querySelector(".file-viewer__text")).toBeNull();
    fireEvent.click(screen.getByTestId("viewer-toggle-source"));
    await waitFor(() =>
      expect(
        panel().querySelector(".file-viewer__text")?.textContent,
      ).toContain("# Hello"),
    );
    expect(
      panel().querySelector(".file-viewer__gutter")?.textContent,
    ).toContain("1\n2\n3");
    fireEvent.click(screen.getByTestId("viewer-toggle-source"));
    await waitFor(() =>
      expect(panel().querySelector(".file-viewer__doc h1")).not.toBeNull(),
    );
  });

  it("a cite anchor opens Markdown at the SOURCE (lines are a source concept)", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: true as const,
        content: "# Hello\n",
        truncated: false,
        size: 8,
        relative: "docs/notes.md",
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-md-anchored"));
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelector(".file-viewer__anchor"),
      ).not.toBeNull(),
    );
    expect(
      screen.getByTestId("file-viewer").querySelector(".file-viewer__doc"),
    ).toBeNull();
  });

  it("code files keep the gutter layout and gain tokens once the highlighter lands", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: true as const,
        content: "const a = 1;\n",
        truncated: false,
        size: 13,
        relative: "src/a.ts",
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe"));
    await waitFor(() =>
      expect(
        screen
          .getByTestId("file-viewer")
          .querySelector(".file-viewer__text .hljs-keyword"),
      ).not.toBeNull(),
    );
    expect(
      screen.getByTestId("file-viewer").querySelector(".file-viewer__text")
        ?.textContent,
    ).toBe("const a = 1;\n");
  });
});
