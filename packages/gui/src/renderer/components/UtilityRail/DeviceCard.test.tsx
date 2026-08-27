import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { DeviceCard } from "./DeviceCard.js";

describe("DeviceCard", () => {
  it("renders the 4-layer composite (2 imgs + 2 divs) inside .agent-preview", () => {
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    const preview = container.querySelector(".agent-preview");
    expect(preview).not.toBeNull();
    expect(preview?.querySelector("img.agent-shadow")).not.toBeNull();
    expect(preview?.querySelector("img.agent-device-img")).not.toBeNull();
    expect(preview?.querySelector("div.agent-spill")).not.toBeNull();
    expect(preview?.querySelector("div.agent-ring")).not.toBeNull();
  });

  it("attaches state class modifier on .agent-spill and .agent-ring", () => {
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    expect(container.querySelector(".agent-spill")?.className).toMatch(
      /is-idle/,
    );
    expect(container.querySelector(".agent-ring")?.className).toMatch(
      /is-idle/,
    );
  });

  it("reflects the device state in the aria-label and data-state", () => {
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    const card = container.querySelector(".device-card");
    expect(card?.getAttribute("aria-label")).toContain("Idle");
    expect(card?.getAttribute("data-state")).toBe("idle");
    act(() => {
      mock.emitAgent({
        kind: "agent",
        event: { type: "turn.started", layer: "backend", userText: "" },
      });
    });
    expect(card?.getAttribute("aria-label")).toContain("Working");
    expect(card?.getAttribute("data-state")).toBe("delegated");
  });

  it("shows the effective backend workspace from the reset snapshot", () => {
    const mock = createMockHertaBridge();
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s-1",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        title: null,
        backendWorkspace: "/home/u/project",
        backendWorkspaceIsDefault: false,
      });
    });
    fireEvent.click(screen.getByLabelText("device card info"));
    expect(screen.getByText("/home/u/project")).toBeInTheDocument();
  });

  it("live-updates the displayed workspace from a workspace event", () => {
    const mock = createMockHertaBridge();
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    act(() => {
      mock.emitWorkspace({
        kind: "workspace",
        workspace: "/live/ws",
        isDefault: false,
      });
    });
    fireEvent.click(screen.getByLabelText("device card info"));
    expect(screen.getByText("/live/ws")).toBeInTheDocument();
  });

  it("⋯ menu lists project command rules on open and removes one via the bridge (ADR 0030)", async () => {
    const mock = createMockHertaBridge({
      commandRules: ["node src/index.mjs:*", "dotnet build:*"],
    });
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    fireEvent.click(screen.getByLabelText("device card info"));
    await waitFor(() =>
      expect(screen.queryByText("node src/index.mjs:*")).toBeTruthy(),
    );
    expect(screen.getByText("Remembered commands")).toBeInTheDocument();
    expect(screen.getByText("dotnet build:*")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Remove rule node src/index.mjs:*" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("node src/index.mjs:*")).toBeNull(),
    );
    expect(mock.calls.removeCommandRule).toEqual(["node src/index.mjs:*"]);
    expect(screen.getByText("dotnet build:*")).toBeInTheDocument();
  });

  it("⋯ menu re-fetches rules on every open (a rule granted mid-session appears)", async () => {
    const mock = createMockHertaBridge();
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    const toggle = screen.getByLabelText("device card info");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.queryByText("No commands remembered")).toBeTruthy(),
    );
    expect(mock.calls.listCommandRules).toBe(1);
    fireEvent.click(toggle); // close
    fireEvent.click(toggle); // reopen → fresh fetch
    await waitFor(() => expect(mock.calls.listCommandRules).toBe(2));
  });

  it("⋯ menu hides the rules section when the bridge lacks the surface", async () => {
    const mock = createMockHertaBridge();
    const {
      listCommandRules: _a,
      removeCommandRule: _b,
      ...rest
    } = mock.bridge;
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={rest as typeof mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    fireEvent.click(screen.getByLabelText("device card info"));
    expect(container.querySelector(".card-menu-rules")).toBeNull();
    // The workspace half of the menu is untouched by the gate.
    expect(screen.getByRole("button", { name: /Set workspace/ })).toBeTruthy();
  });

  it("opens the picker and sets the chosen workspace", async () => {
    const mock = createMockHertaBridge({ pickWorkspaceResult: "/picked" });
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s-1",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        title: null,
        backendWorkspace: "/home/u/project",
        backendWorkspaceIsDefault: false,
      });
    });
    fireEvent.click(screen.getByLabelText("device card info"));
    expect(screen.getByText("/home/u/project")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Set workspace/ }));
    await waitFor(() => expect(mock.calls.setWorkspace).toHaveLength(1));
    expect(mock.calls.setWorkspace[0]).toEqual(["s-1", "/picked"]);
  });

  it("surfaces a validation error inline when setWorkspace is rejected", async () => {
    const mock = createMockHertaBridge({
      pickWorkspaceResult: "/x",
      setWorkspaceResult: { ok: false, message: "refusing a filesystem root" },
    });
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s-1",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        title: null,
        backendWorkspace: "/home/u/project",
        backendWorkspaceIsDefault: false,
      });
    });
    fireEvent.click(screen.getByLabelText("device card info"));
    fireEvent.click(screen.getByRole("button", { name: /Set workspace/ }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/refusing/),
    );
  });

  it("shows no alert on the happy path", async () => {
    const mock = createMockHertaBridge({ pickWorkspaceResult: "/picked" });
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s-1",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        title: null,
        backendWorkspace: "/home/u/project",
        backendWorkspaceIsDefault: false,
      });
    });
    fireEvent.click(screen.getByLabelText("device card info"));
    fireEvent.click(screen.getByRole("button", { name: /Set workspace/ }));
    await waitFor(() => expect(mock.calls.setWorkspace).toHaveLength(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not call setWorkspace when the picker is cancelled", async () => {
    const mock = createMockHertaBridge({ pickWorkspaceResult: null });
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s-1",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        title: null,
        backendWorkspace: "/home/u/project",
        backendWorkspaceIsDefault: false,
      });
    });
    fireEvent.click(screen.getByLabelText("device card info"));
    fireEvent.click(screen.getByRole("button", { name: /Set workspace/ }));
    await Promise.resolve();
    expect(mock.calls.setWorkspace).toHaveLength(0);
  });

  it("does not open the folder picker for Set workspace when there is no active session", async () => {
    const mock = createMockHertaBridge({ pickWorkspaceResult: "/picked" });
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    // Do NOT emit a reset — sessionId stays null
    fireEvent.click(screen.getByLabelText("device card info"));
    fireEvent.click(screen.getByRole("button", { name: /Set workspace/ }));
    await Promise.resolve();
    expect(mock.calls.pickWorkspace).toBe(0);
  });

  it("fires maybePlayEasterEgg on a successful upward lift", () => {
    // matchMedia stub (jsdom lacks it) so reduced-motion is false and the lift
    // is allowed; Math.random=0 forces a chance-pass (chance < liftProbability).
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    const preview = container.querySelector(".agent-preview") as HTMLElement;
    fireEvent.mouseDown(preview, { clientY: 100 });
    act(() => {
      // 20px upward, past the 8px threshold → a successful lift.
      fireEvent(window, new MouseEvent("mousemove", { clientY: 80 }));
    });
    expect(mock.calls.maybePlayEasterEgg).toBe(1);
    fireEvent.mouseUp(window);
    randomSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("resets the workspace to default", () => {
    const mock = createMockHertaBridge();
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s-1",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        title: null,
        backendWorkspace: "/home/u/project",
        backendWorkspaceIsDefault: false,
      });
    });
    fireEvent.click(screen.getByLabelText("device card info"));
    fireEvent.click(screen.getByRole("button", { name: /Reset to default/ }));
    expect(mock.calls.resetWorkspace).toEqual(["s-1"]);
  });
});
