import { type CSSProperties, useEffect, useState } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useT } from "../../i18n/LocaleProvider.js";
import type {
  RealtimeVoiceState,
  VoiceModelFailure,
  VoiceModelState,
} from "../../ipc/bridge-types.js";
import { applyVoiceVolume, stopAllVoice } from "../../voice/play-voice.js";
import { useVoiceMuted } from "../../voice/useVoiceMuted.js";
import { useVoiceVolume } from "../../voice/useVoiceVolume.js";
import { setVoiceMuted, setVoiceVolume } from "../../voice/voice-prefs.js";
import { SettingRow } from "./SettingRow.js";
import { Toggle } from "./Toggle.js";

const mb = (bytes: number): string => String(Math.round(bytes / 1e6));

function failureKey(reason: VoiceModelFailure) {
  switch (reason) {
    case "network":
      return "voice.modelFailed.network" as const;
    case "http":
      return "voice.modelFailed.http" as const;
    case "size":
      return "voice.modelFailed.size" as const;
    case "hash":
      return "voice.modelFailed.hash" as const;
    case "archive":
      return "voice.modelFailed.archive" as const;
    case "verify":
      return "voice.modelFailed.verify" as const;
    case "disk":
      return "voice.modelFailed.disk" as const;
    case "cancelled":
      return "voice.modelFailed.cancelled" as const;
  }
}

/** The Voice settings section — real-time voice (ADR 0042), its model as a
 *  download (ADR 0061), master mute, master volume. */
export function VoiceSettings(): JSX.Element {
  const t = useT();
  const { bridge } = useHertaBridge();
  const muted = useVoiceMuted();
  const volume = useVoiceVolume();
  // The rows render on the FIRST frame whenever the bridge has the methods
  // (the settings-pane rule, owner 2026-09-07: gate on the METHOD's presence,
  // never on an async read's result); the controls stay inert until the
  // state lands, so nothing pops in a frame later.
  const supported =
    bridge.getRealtimeVoice !== undefined &&
    bridge.setRealtimeVoice !== undefined;
  const modelSupported = bridge.downloadVoiceModel !== undefined;
  const [rt, setRt] = useState<RealtimeVoiceState | null>(null);
  const [rtFailed, setRtFailed] = useState(false);
  const [model, setModel] = useState<VoiceModelState | null>(null);

  useEffect(() => {
    const read = bridge.getRealtimeVoice;
    if (read === undefined) return;
    let alive = true;
    void read().then(
      (s) => {
        if (!alive) return;
        setRt(s);
        setModel(s.model);
      },
      () => undefined,
    );
    const unsub = bridge.onVoiceModel?.((m) => {
      if (!alive) return;
      setModel(m);
      // A phase change may have changed what the synthesizer can see — the
      // downloaded copy landed, or went — so re-read the facts rather than
      // infer them here (a dev workspace copy would be inferred wrong).
      if (m.phase !== "downloading") {
        void read().then(
          (s) => {
            if (alive) setRt(s);
          },
          () => undefined,
        );
      }
    });
    return () => {
      alive = false;
      unsub?.();
    };
  }, [bridge]);

  // A downloaded bundle counts the moment its state says ready; the initial
  // read's `bundle` covers the dev workspace's copy, which no download owns.
  const bundle =
    model !== null && model.phase === "ready" ? true : (rt?.bundle ?? false);
  const runtime = rt?.runtime ?? false;
  const failed = rt?.failed ?? false;
  const canSpeak = bundle && runtime && !failed;

  const onRealtimeChange = (next: boolean): void => {
    const write = bridge.setRealtimeVoice;
    if (write === undefined || rt === null) return;
    // Optimistic, with a snap-back on a failed write — same contract as the
    // Dream toggle, so the switch never claims a state that missed disk.
    setRt({ ...rt, enabled: next });
    setRtFailed(false);
    void write(next).catch(() => {
      setRt({ ...rt, enabled: !next });
      setRtFailed(true);
    });
    // Turning it OFF cuts a reply already speaking (immediate silence,
    // mirroring the mute below).
    if (!next) stopAllVoice();
  };

  const modelRow = ((): {
    readonly description: string;
    readonly control: JSX.Element | null;
  } => {
    if (model === null) return { description: "—", control: null };
    const size = mb(model.unpackedBytes);
    switch (model.phase) {
      case "downloading":
        return {
          description: t("voice.modelDownloading", {
            received: mb(model.receivedBytes),
            total: mb(model.totalBytes),
          }),
          control: (
            <button
              type="button"
              className="settings-btn"
              onClick={() => void bridge.cancelVoiceModelDownload?.()}
            >
              {t("voice.modelCancel")}
            </button>
          ),
        };
      case "ready":
        return {
          description: t("voice.modelReady", { size }),
          control: (
            <button
              type="button"
              className="settings-btn"
              onClick={() => {
                stopAllVoice();
                void bridge.removeVoiceModel?.();
              }}
            >
              {t("voice.modelRemove")}
            </button>
          ),
        };
      case "failed":
        return {
          description:
            model.error !== undefined
              ? t(failureKey(model.error))
              : t("voice.modelFailed.disk"),
          control: (
            <button
              type="button"
              className="settings-btn settings-btn--primary"
              disabled={!runtime}
              onClick={() => void bridge.downloadVoiceModel?.()}
            >
              {t("voice.modelRetry")}
            </button>
          ),
        };
      default:
        // Absent. In dev the workspace's own copy may already be answering.
        return bundle
          ? { description: t("voice.modelDev"), control: null }
          : {
              description: t("voice.modelAbsent", { size }),
              control: (
                <button
                  type="button"
                  className="settings-btn settings-btn--primary"
                  disabled={!runtime}
                  onClick={() => void bridge.downloadVoiceModel?.()}
                >
                  {t("voice.modelDownload")}
                </button>
              ),
            };
    }
  })();

  const progress =
    model !== null && model.phase === "downloading" && model.totalBytes > 0
      ? Math.min(
          100,
          Math.round((model.receivedBytes / model.totalBytes) * 100),
        )
      : null;

  return (
    <>
      {supported && (
        <>
          <SettingRow
            title={t("voice.realtime")}
            description={t("voice.realtimeDesc")}
            control={
              <Toggle
                checked={rt !== null && rt.enabled && canSpeak}
                ariaLabel={t("voice.realtime")}
                disabled={rt === null || !canSpeak}
                onChange={onRealtimeChange}
              />
            }
          />
          {rtFailed ? (
            <p className="settings-note">{t("common.couldntSave")}</p>
          ) : rt !== null && !runtime ? (
            <p className="settings-note">{t("voice.realtimeMissing")}</p>
          ) : failed ? (
            <p className="settings-note">{t("voice.realtimeFailed")}</p>
          ) : null}
          {modelSupported && (
            <>
              <SettingRow
                title={t("voice.model")}
                description={modelRow.description}
                control={modelRow.control}
              />
              {progress !== null && (
                <div
                  className="settings-progress"
                  role="progressbar"
                  aria-label={t("voice.model")}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress}
                >
                  <span
                    className="settings-progress__fill"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              )}
            </>
          )}
        </>
      )}
      <SettingRow
        title={t("voice.mute")}
        description={t("voice.muteDesc")}
        control={
          <Toggle
            checked={muted}
            ariaLabel={t("voice.mute")}
            onChange={(next) => {
              setVoiceMuted(next);
              // Turning mute ON cuts any clip already playing (immediate silence).
              if (next) stopAllVoice();
            }}
          />
        }
      />
      <SettingRow
        title={t("voice.volume")}
        description={t("voice.volumeDesc")}
        control={
          <span
            className={`settings-slider-wrap${muted ? " is-disabled" : ""}`}
          >
            <input
              type="range"
              className="settings-slider"
              min={0}
              max={100}
              step={5}
              value={Math.round(volume * 100)}
              /* The custom track paints its LED fill from this var — CSS
                 alone can't know a range input's value. */
              style={
                {
                  "--slider-fill": `${Math.round(volume * 100)}%`,
                } as CSSProperties
              }
              aria-label={t("voice.volume")}
              disabled={muted}
              onChange={(e) => {
                setVoiceVolume(Number(e.target.value) / 100);
                // Re-scale a clip that is ALREADY playing, so dragging the
                // slider mid-line is audible immediately.
                applyVoiceVolume();
              }}
            />
            <span className="settings-slider-value">
              {Math.round(volume * 100)}%
            </span>
          </span>
        }
      />
    </>
  );
}
