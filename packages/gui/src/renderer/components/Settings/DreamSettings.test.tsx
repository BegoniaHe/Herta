import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { DreamSettings } from "./DreamSettings.js";

describe("DreamSettings", () => {
  it("reflects the persisted value, writes on toggle, shows the restart note", async () => {
    const mock = createMockHertaBridge({
      getDreamConfigResult: { enabled: false },
    });
    const { getByLabelText, queryByText } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DreamSettings />
      </HertaBridgeProvider>,
    );
    const toggle = getByLabelText("Enable Dream");
    // The async getDreamConfig resolves → toggle reflects enabled:false.
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
    // No restart note until the user changes it.
    expect(queryByText("Restart to apply")).toBeNull();
    fireEvent.click(toggle);
    expect(mock.calls.setDreamConfig).toEqual([{ enabled: true }]);
    expect(queryByText("Restart to apply")).toBeTruthy();
  });

  it("hides the restart note when toggled back to the original value", async () => {
    const mock = createMockHertaBridge({
      getDreamConfigResult: { enabled: true },
    });
    const { getByLabelText, queryByText } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DreamSettings />
      </HertaBridgeProvider>,
    );
    const toggle = getByLabelText("Enable Dream");
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    fireEvent.click(toggle); // off → differs from the loaded value
    expect(queryByText("Restart to apply")).toBeTruthy();
    fireEvent.click(toggle); // back on → matches the loaded value
    expect(queryByText("Restart to apply")).toBeNull();
  });

  it("reverts and surfaces an error if the write fails", async () => {
    const mock = createMockHertaBridge({
      getDreamConfigResult: { enabled: true },
    });
    Object.assign(mock.bridge, {
      setDreamConfig: async () => {
        throw new Error("disk full");
      },
    });
    const { getByLabelText, queryByText } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DreamSettings />
      </HertaBridgeProvider>,
    );
    const toggle = getByLabelText("Enable Dream");
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    fireEvent.click(toggle); // optimistic off → write fails → snaps back on
    await waitFor(() =>
      expect(queryByText("Couldn't save — try again.")).toBeTruthy(),
    );
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(queryByText("Restart to apply")).toBeNull();
  });
});
