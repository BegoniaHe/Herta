import { act, fireEvent } from "@testing-library/react";
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

const ABSENT = {
  phase: "absent" as const,
  receivedBytes: 0,
  totalBytes: 60_000_000,
  unpackedBytes: 116_000_000,
};

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

  it("the rows are on the FIRST frame, inert until the state lands, then live", async () => {
    const { getByLabelText, getByText, findByText, mock } = setup();
    // Present immediately — gated on the bridge's METHODS, not on the read
    // (settings-pane first-paint rule) — but the switch cannot flip yet.
    const toggle = getByLabelText("Real-time voice") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(getByText("Voice model")).toBeTruthy();
    await findByText("Installed, about 116 MB on disk.");
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(mock.calls.setRealtimeVoice).toEqual([false]);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("turning it OFF cuts a reply that is already speaking", async () => {
    const { getByLabelText, findByText } = setup();
    await findByText("Installed, about 116 MB on disk.");
    const toggle = getByLabelText("Real-time voice");
    fireEvent.click(toggle);
    expect(vi.mocked(stopAllVoice)).toHaveBeenCalled();
  });

  it("a failed write snaps the toggle back and says so", async () => {
    const { getByLabelText, findByText } = setup({
      failSetRealtimeVoice: true,
    });
    await findByText("Installed, about 116 MB on disk.");
    const toggle = getByLabelText("Real-time voice");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(await findByText("Couldn't save — try again.")).toBeTruthy();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("without the runtime the toggle is inert and the row says why", async () => {
    const { getByLabelText, findByText, mock } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: true,
        runtime: false,
        failed: false,
      },
    });
    expect(
      await findByText(
        "This install lacks the voice runtime — she can only type for now.",
      ),
    ).toBeTruthy();
    const toggle = getByLabelText("Real-time voice") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    // Reads OFF even though the stored preference is on — she cannot speak.
    expect(toggle.getAttribute("aria-checked")).toBe("false");
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

  it("hides the rows entirely on a bridge without the pair (website demo)", () => {
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
    expect(queryByLabelText("Voice model")).toBeNull();
    // The rest of the pane still renders.
    expect(queryByLabelText("Mute voice")).toBeTruthy();
  });

  // ── The model as a download (ADR 0061) ───────────────────────────────────

  it("no model: the toggle is inert, the row quotes the size and offers Download", async () => {
    const { getByLabelText, findByText, getByRole, mock } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: false,
        runtime: true,
        failed: false,
        model: ABSENT,
      },
    });
    expect(
      await findByText(
        "About 116 MB; she can speak once it's on this machine.",
      ),
    ).toBeTruthy();
    const toggle = getByLabelText("Real-time voice") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    fireEvent.click(getByRole("button", { name: "Download" }));
    expect(mock.calls.downloadVoiceModel).toBe(1);
    // The mock's download ends ready and pushes it: the toggle comes alive
    // without a re-read.
    expect(await findByText("Installed, about 116 MB on disk.")).toBeTruthy();
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("while downloading: progress in MB, a bar, and Cancel", async () => {
    const { findByText, getByRole, mock } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: false,
        runtime: true,
        failed: false,
        model: ABSENT,
      },
    });
    await findByText("About 116 MB; she can speak once it's on this machine.");
    act(() => {
      mock.emitVoiceModel({
        ...ABSENT,
        phase: "downloading",
        receivedBytes: 15_000_000,
      });
    });
    expect(await findByText("Downloaded 15 / 60 MB")).toBeTruthy();
    const bar = getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    fireEvent.click(getByRole("button", { name: "Cancel" }));
    expect(mock.calls.cancelVoiceModelDownload).toBe(1);
    expect(
      await findByText(
        "About 116 MB; she can speak once it's on this machine.",
      ),
    ).toBeTruthy();
  });

  it("a failed download names the reason and offers Retry", async () => {
    const { findByText, getByRole, mock } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: false,
        runtime: true,
        failed: false,
        model: { ...ABSENT, phase: "failed", error: "hash" },
      },
    });
    expect(
      await findByText("The downloaded file failed its checksum; discarded."),
    ).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Retry" }));
    expect(mock.calls.downloadVoiceModel).toBe(1);
  });

  it("a ready model offers Remove, which silences playback and goes back to absent", async () => {
    const { findByText, getByLabelText, getByRole, mock } = setup();
    await findByText("Installed, about 116 MB on disk.");
    fireEvent.click(getByRole("button", { name: "Remove" }));
    expect(vi.mocked(stopAllVoice)).toHaveBeenCalled();
    expect(mock.calls.removeVoiceModel).toBe(1);
    expect(
      await findByText(
        "About 116 MB; she can speak once it's on this machine.",
      ),
    ).toBeTruthy();
    expect(
      (getByLabelText("Real-time voice") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("without the runtime the Download button is inert — nothing could play it", async () => {
    const { findByText, getByRole } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: false,
        runtime: false,
        failed: false,
        model: ABSENT,
      },
    });
    await findByText("About 116 MB; she can speak once it's on this machine.");
    expect(
      (getByRole("button", { name: "Download" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  // ── The engine and the cloud voice (ADR 0062) ────────────────────────────

  it("the engine picker is on the first frame; choosing MiniMax swaps the model row for the key and clone rows", async () => {
    const { findByText, getByRole, queryByText, mock } = setup();
    await findByText("Installed, about 116 MB on disk.");
    const picker = getByRole("button", { name: "Voice engine" });
    fireEvent.click(picker);
    fireEvent.click(getByRole("option", { name: "MiniMax cloud" }));
    expect(mock.calls.setVoiceEngine).toEqual(["minimax"]);
    expect(queryByText("Voice model")).toBeNull();
    expect(await findByText("MiniMax API key")).toBeTruthy();
    expect(await findByText("Clone voice")).toBeTruthy();
    expect(queryByText("No key set")).toBeTruthy();
    // No key yet: the clone cannot be prepared, and she cannot speak.
    expect(
      (getByRole("button", { name: "Prepare" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (getByRole("switch", { name: "Real-time voice" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("saving a key, then Prepare: absent → preparing → ready, and the toggle comes alive", async () => {
    const { findByText, getByRole, getByLabelText, mock } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: true,
        runtime: true,
        failed: false,
        engine: "minimax",
      },
    });
    await findByText("Clone voice");
    fireEvent.change(getByLabelText("MiniMax API key"), {
      target: { value: "sk-api-secret-9876" },
    });
    fireEvent.click(getByRole("button", { name: "Save" }));
    expect(mock.calls.setMiniMaxKey).toEqual(["sk-api-secret-9876"]);
    expect(await findByText("Connected · …9876")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Prepare" }));
    expect(mock.calls.prepareMiniMaxVoice).toBe(1);
    expect(await findByText("Ready; cloned on 2026-09-08.")).toBeTruthy();
    const toggle = getByRole("switch", {
      name: "Real-time voice",
    }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    // Re-clone resets then prepares again.
    fireEvent.click(getByRole("button", { name: "Re-clone" }));
    await findByText("Ready; cloned on 2026-09-08.");
    expect(mock.calls.resetMiniMaxVoice).toBe(1);
    expect(mock.calls.prepareMiniMaxVoice).toBe(2);
  });

  it("a rejected key says so and stores nothing", async () => {
    const { findByText, getByRole, getByLabelText, mock } = setup({
      rejectMiniMaxKey: true,
      realtimeVoiceResult: {
        enabled: true,
        bundle: true,
        runtime: true,
        failed: false,
        engine: "minimax",
      },
    });
    await findByText("Clone voice");
    fireEvent.change(getByLabelText("MiniMax API key"), {
      target: { value: "bad" },
    });
    fireEvent.click(getByRole("button", { name: "Save" }));
    expect(
      await findByText(
        "MiniMax did not accept that key — check it and try again.",
      ),
    ).toBeTruthy();
    expect(mock.calls.setMiniMaxKey).toEqual(["bad"]);
    expect(await findByText("No key set")).toBeTruthy();
  });

  it("a failed clone names its reason and offers Retry; a push updates the row", async () => {
    const { findByText, getByRole, mock } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: true,
        runtime: true,
        failed: false,
        engine: "minimax",
        minimax: {
          key: { set: true, hint: "1234", encrypted: true },
          voice: { phase: "failed", error: "sensitive" },
        },
      },
    });
    expect(
      await findByText(
        "The reference recording failed the platform's content check.",
      ),
    ).toBeTruthy();
    expect(
      (getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    act(() => {
      mock.emitMiniMaxVoice({ phase: "preparing" });
    });
    expect(await findByText("Uploading and cloning…")).toBeTruthy();
  });

  it("dev: the workspace's own copy shows as such, with nothing to download", async () => {
    const { findByText, queryByRole } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: true,
        runtime: true,
        failed: false,
        model: ABSENT,
      },
    });
    expect(
      await findByText("Using the model in the workspace's data/tts."),
    ).toBeTruthy();
    expect(queryByRole("button", { name: "Download" })).toBeNull();
  });
});
