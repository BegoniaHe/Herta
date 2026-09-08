import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { applyVoiceVolume, stopAllVoice } from "../../voice/play-voice.js";
import { setVoiceVolume } from "../../voice/voice-prefs.js";
import { VoiceSettings } from "./VoiceSettings.js";

// Silence the voice modules — not under test here. Mutable holders let the
// per-test state flip what the (hoisted) module mocks report.
const mutedState = { value: false };
const volumeState = { value: 0.8 };
vi.mock("../../voice/play-voice.js", () => ({
  stopAllVoice: vi.fn(),
  applyVoiceVolume: vi.fn(),
}));
vi.mock("../../voice/useVoiceMuted.js", () => ({
  useVoiceMuted: () => mutedState.value,
}));
vi.mock("../../voice/useVoiceVolume.js", () => ({
  useVoiceVolume: () => volumeState.value,
}));
vi.mock("../../voice/voice-prefs.js", () => ({
  setVoiceMuted: vi.fn(),
  setVoiceVolume: vi.fn(),
}));

afterEach(() => {
  mutedState.value = false;
  volumeState.value = 0.8;
  vi.clearAllMocks();
});

function setup(
  opts: Parameters<typeof createMockHertaBridge>[0] = {},
): ReturnType<typeof renderWithLocale> & {
  mock: ReturnType<typeof createMockHertaBridge>;
} {
  const mock = createMockHertaBridge(opts);
  const r = renderWithLocale(
    <HertaBridgeProvider bridge={mock.bridge}>
      <VoiceSettings />
    </HertaBridgeProvider>,
  );
  return Object.assign(r, { mock });
}

describe("VoiceSettings", () => {
  it("renders the mute toggle with localized label", () => {
    const { getByLabelText, getByText } = setup();
    expect(getByLabelText("Mute voice")).toBeTruthy();
    expect(getByText("Mute voice")).toBeTruthy();
    expect(getByText("Silence all of Herta's voice.")).toBeTruthy();
  });

  it("renders the volume slider with the current percentage", () => {
    const { getByLabelText, getByText } = setup();
    const slider = getByLabelText("Volume") as HTMLInputElement;
    expect(slider.value).toBe("80");
    expect(slider.disabled).toBe(false);
    expect(getByText("80%")).toBeTruthy();
  });

  it("dragging the slider persists the volume AND re-scales the playing clip", () => {
    const { getByLabelText } = setup();
    fireEvent.change(getByLabelText("Volume"), { target: { value: "60" } });
    expect(vi.mocked(setVoiceVolume)).toHaveBeenCalledWith(0.6);
    expect(vi.mocked(applyVoiceVolume)).toHaveBeenCalled();
  });

  it("the slider is disabled (and its wrap dimmed) while muted", () => {
    mutedState.value = true;
    const { getByLabelText, container } = setup();
    const slider = getByLabelText("Volume") as HTMLInputElement;
    expect(slider.disabled).toBe(true);
    expect(
      container.querySelector(".settings-slider-wrap.is-disabled"),
    ).not.toBeNull();
  });

  // ── Real-time voice (ADR 0042) ────────────────────────────────────────────

  it("reflects the persisted real-time-voice state and writes on toggle", async () => {
    const { findByLabelText, mock } = setup();
    // The row is absent until its state loads (it must not claim a default
    // that may not match disk), so the query is async.
    const toggle = await findByLabelText("Real-time voice");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(mock.calls.setRealtimeVoice).toEqual([false]);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("turning it OFF cuts a reply that is already speaking", async () => {
    const { findByLabelText } = setup();
    const toggle = await findByLabelText("Real-time voice");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(vi.mocked(stopAllVoice)).toHaveBeenCalled();
  });

  it("a failed write snaps the toggle back and says so", async () => {
    const { findByLabelText, findByText } = setup({
      failSetRealtimeVoice: true,
    });
    const toggle = await findByLabelText("Real-time voice");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(await findByText("Couldn't save — try again.")).toBeTruthy();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("with no model bundle the toggle is inert and the row says why", async () => {
    const { findByLabelText, findByText, mock } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: false,
        runtime: true,
        failed: false,
      },
    });
    const toggle = (await findByLabelText(
      "Real-time voice",
    )) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    // Reads OFF even though the stored preference is on — she cannot speak.
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(
      await findByText(
        "No voice model shipped with this install — she can only type for now.",
      ),
    ).toBeTruthy();
    fireEvent.click(toggle);
    expect(mock.calls.setRealtimeVoice).toEqual([]);
  });

  it("a worker that failed for good reports the restart hint", async () => {
    const { findByText } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: true,
        runtime: true,
        failed: true,
      },
    });
    expect(
      await findByText(
        "The voice process failed repeatedly; it's off for this run. Restart Herta to retry.",
      ),
    ).toBeTruthy();
  });

  it("hides the row entirely on a bridge without the pair (website demo)", () => {
    const mock = createMockHertaBridge();
    // An older bridge shape: the pair simply is not there.
    const {
      getRealtimeVoice: _a,
      setRealtimeVoice: _b,
      ...bridge
    } = mock.bridge;
    const { queryByLabelText } = renderWithLocale(
      <HertaBridgeProvider bridge={bridge}>
        <VoiceSettings />
      </HertaBridgeProvider>,
    );
    expect(queryByLabelText("Real-time voice")).toBeNull();
    // The rest of the pane still renders.
    expect(queryByLabelText("Mute voice")).toBeTruthy();
  });
});
