import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { renderWithSession } from "../../testing/renderWithSession.js";
import { FileViewerPanel } from "./FileViewerPanel.js";
import {
  FileViewerProvider,
  useFileViewerOpen,
} from "./file-viewer-context.js";

function Probe(): JSX.Element {
  const open = useFileViewerOpen();
  return (
    <button
      type="button"
      data-testid="probe"
      data-available={open !== null}
      onClick={() => open?.("src/a.ts")}
    >
      open
    </button>
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
    // The breadcrumb names the file.
    expect(
      screen.getByTestId("file-viewer").querySelector(".file-viewer__name")
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
