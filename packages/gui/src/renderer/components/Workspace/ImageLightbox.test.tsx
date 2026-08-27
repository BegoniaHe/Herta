import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { LightboxProvider, useLightbox } from "./ImageLightbox.js";
import { UserBubble } from "./UserBubble.js";

const IMG = {
  path: ".herta/attachments/s/shot-abc-def.png",
  name: "shot.png",
  caption: "一张测试图。",
  width: 640,
  height: 480,
};

/** A trigger the tests can click to open the lightbox directly. */
function OpenTrigger(): JSX.Element {
  const open = useLightbox();
  return (
    <button type="button" onClick={() => open(IMG)}>
      trigger
    </button>
  );
}

function renderLightbox(mock = createMockHertaBridge()) {
  return renderWithLocale(
    <HertaBridgeProvider bridge={mock.bridge}>
      <LightboxProvider>
        <OpenTrigger />
      </LightboxProvider>
    </HertaBridgeProvider>,
  );
}

describe("ImageLightbox", () => {
  it("opens as a dialog showing the full picture through the attachment scheme", () => {
    renderLightbox();
    expect(screen.queryByTestId("lightbox")).toBeNull();
    fireEvent.click(screen.getByText("trigger"));
    const dialog = screen.getByTestId("lightbox");
    expect(dialog.getAttribute("role")).toBe("dialog");
    // The caption is the dialog's name — same rule as the thumb's alt.
    expect(dialog.getAttribute("aria-label")).toBe("一张测试图。");
    const img = dialog.querySelector(".lightbox-img") as HTMLImageElement;
    expect(img.src).toContain("herta-attachment://");
    expect(img.src).toContain("shot-abc-def.png");
  });

  it("the ✕ closes it", () => {
    renderLightbox();
    fireEvent.click(screen.getByText("trigger"));
    fireEvent.click(screen.getByLabelText("Close"));
    expect(screen.queryByTestId("lightbox")).toBeNull();
  });

  it("Escape closes it (topmost-overlay rule)", () => {
    renderLightbox();
    fireEvent.click(screen.getByText("trigger"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("lightbox")).toBeNull();
  });

  it("clicking the dark ground closes; clicking the picture does not", () => {
    renderLightbox();
    fireEvent.click(screen.getByText("trigger"));
    const viewport = document.querySelector(".lightbox-viewport") as Element;
    const img = viewport.querySelector(".lightbox-img") as Element;
    fireEvent.mouseDown(img);
    expect(screen.queryByTestId("lightbox")).not.toBeNull();
    fireEvent.mouseDown(viewport);
    expect(screen.queryByTestId("lightbox")).toBeNull();
  });

  it("the zoom pill steps the scale and says so", () => {
    // jsdom has no layout (clientWidth 0), so the fit never computes — the
    // first step starts from 100%, which is also the real behaviour when a
    // user zooms before the fit lands.
    renderLightbox();
    fireEvent.click(screen.getByText("trigger"));
    fireEvent.click(screen.getByLabelText("Zoom in"));
    expect(document.querySelector(".lightbox-zoom__label")?.textContent).toBe(
      "125%",
    );
    fireEvent.click(screen.getByLabelText("Zoom out"));
    expect(document.querySelector(".lightbox-zoom__label")?.textContent).toBe(
      "100%",
    );
    const img = document.querySelector(".lightbox-img") as HTMLElement;
    // Explicit width = natural × zoom once zoomed.
    expect(img.style.width).toBe("640px");
  });

  it("a session switch closes it — an enlarged picture belongs to its session", () => {
    const mock = createMockHertaBridge();
    renderLightbox(mock);
    fireEvent.click(screen.getByText("trigger"));
    expect(screen.queryByTestId("lightbox")).not.toBeNull();
    act(() => {
      mock.emitReset({
        sessionId: "another",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    expect(screen.queryByTestId("lightbox")).toBeNull();
  });

  it("a sent thumbnail opens it (the UserBubble wiring)", () => {
    const mock = createMockHertaBridge();
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <LightboxProvider>
          <UserBubble text="看看这个" images={[IMG]} />
        </LightboxProvider>
      </HertaBridgeProvider>,
    );
    fireEvent.click(screen.getByLabelText("View picture shot.png"));
    const dialog = screen.getByTestId("lightbox");
    expect(
      (dialog.querySelector(".lightbox-img") as HTMLImageElement).src,
    ).toContain("shot-abc-def.png");
  });
});
