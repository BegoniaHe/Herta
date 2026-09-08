import { type CSSProperties, useEffect, useState } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useT } from "../../i18n/LocaleProvider.js";
import type { RealtimeVoiceState } from "../../ipc/bridge-types.js";
import { applyVoiceVolume, stopAllVoice } from "../../voice/play-voice.js";
import { useVoiceMuted } from "../../voice/useVoiceMuted.js";
import { useVoiceVolume } from "../../voice/useVoiceVolume.js";
import { setVoiceMuted, setVoiceVolume } from "../../voice/voice-prefs.js";
import { SettingRow } from "./SettingRow.js";
import { Toggle } from "./Toggle.js";

/** The Voice settings section — real-time voice (ADR 0042), master mute,
 *  master volume. */
export function VoiceSettings(): JSX.Element {
  const t = useT();
  const { bridge } = useHertaBridge();
  const muted = useVoiceMuted();
  const volume = useVoiceVolume();
  // Null until the state loads, and for bridges without the pair (the
  // website demo, test fakes) — the row hides rather than claiming a
  // default that may not match disk.
  const [rt, setRt] = useState<RealtimeVoiceState | null>(null);
  const [rtFailed, setRtFailed] = useState(false);

  useEffect(() => {
    const read = bridge.getRealtimeVoice;
    if (read === undefined) return;
    let alive = true;
    void read().then(
      (s) => {
        if (alive) setRt(s);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [bridge]);

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

  return (
    <>
      {rt !== null && (
        <>
          <SettingRow
            title={t("voice.realtime")}
            description={t("voice.realtimeDesc")}
            control={
              <Toggle
                checked={rt.enabled && rt.bundle && rt.runtime && !rt.failed}
                ariaLabel={t("voice.realtime")}
                disabled={!rt.bundle || !rt.runtime || rt.failed}
                onChange={onRealtimeChange}
              />
            }
          />
          {rtFailed ? (
            <p className="settings-note">{t("common.couldntSave")}</p>
          ) : !rt.bundle || !rt.runtime ? (
            <p className="settings-note">{t("voice.realtimeMissing")}</p>
          ) : rt.failed ? (
            <p className="settings-note">{t("voice.realtimeFailed")}</p>
          ) : null}
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
