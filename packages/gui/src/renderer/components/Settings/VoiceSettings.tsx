import { type CSSProperties, useEffect, useState } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useT } from "../../i18n/LocaleProvider.js";
import type {
  DeepSeekKeyStatus,
  MiniMaxVoiceError,
  MiniMaxVoiceState,
  RealtimeVoiceState,
  VoiceEngine,
  VoiceModelFailure,
  VoiceModelState,
} from "../../ipc/bridge-types.js";
import { applyVoiceVolume, stopAllVoice } from "../../voice/play-voice.js";
import { useVoiceMuted } from "../../voice/useVoiceMuted.js";
import { useVoiceVolume } from "../../voice/useVoiceVolume.js";
import { setVoiceMuted, setVoiceVolume } from "../../voice/voice-prefs.js";
import { Select } from "./Select.js";
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

function cloneFailureKey(reason: MiniMaxVoiceError) {
  switch (reason) {
    case "no_key":
      return "voice.cloneFailed.no_key" as const;
    case "invalid_key":
      return "voice.cloneFailed.invalid_key" as const;
    case "auth":
      return "voice.cloneFailed.auth" as const;
    case "rate":
      return "voice.cloneFailed.rate" as const;
    case "quota":
      return "voice.cloneFailed.quota" as const;
    case "sensitive":
      return "voice.cloneFailed.sensitive" as const;
    case "voice_missing":
      return "voice.cloneFailed.voice_missing" as const;
    case "invalid":
      return "voice.cloneFailed.invalid" as const;
    case "network":
      return "voice.cloneFailed.network" as const;
    case "http":
      return "voice.cloneFailed.http" as const;
    case "cancelled":
      return "voice.cloneFailed.cancelled" as const;
    case "reference":
      return "voice.cloneFailed.reference" as const;
    case "other":
      return "voice.cloneFailed.other" as const;
  }
}

/** The Voice settings section — real-time voice (ADR 0042), its engine
 *  (ADR 0062: the local model with its download, ADR 0061, or the MiniMax
 *  clone on the user's key), master mute, master volume. */
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
  const engineSupported =
    bridge.setVoiceEngine !== undefined &&
    bridge.setMiniMaxKey !== undefined &&
    bridge.prepareMiniMaxVoice !== undefined;
  const [rt, setRt] = useState<RealtimeVoiceState | null>(null);
  const [rtFailed, setRtFailed] = useState(false);
  const [model, setModel] = useState<VoiceModelState | null>(null);
  const [engine, setEngine] = useState<VoiceEngine>("local");
  const [engineFailed, setEngineFailed] = useState(false);
  const [mmKey, setMmKey] = useState<DeepSeekKeyStatus | null>(null);
  const [clone, setClone] = useState<MiniMaxVoiceState | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [keySaving, setKeySaving] = useState(false);
  const [keyDeleting, setKeyDeleting] = useState(false);
  const [keyFailed, setKeyFailed] = useState(false);
  const [keyRejected, setKeyRejected] = useState(false);
  const [keyUnverified, setKeyUnverified] = useState(false);

  useEffect(() => {
    const read = bridge.getRealtimeVoice;
    if (read === undefined) return;
    let alive = true;
    const refresh = (): void => {
      void read().then(
        (s) => {
          if (!alive) return;
          setRt(s);
          setModel(s.model);
          setEngine(s.engine);
          setMmKey(s.minimax.key);
          setClone(s.minimax.voice);
        },
        () => undefined,
      );
    };
    refresh();
    const unsubModel = bridge.onVoiceModel?.((m) => {
      if (!alive) return;
      setModel(m);
      // A phase change may have changed what the synthesizer can see — the
      // downloaded copy landed, or went — so re-read the facts rather than
      // infer them here (a dev workspace copy would be inferred wrong).
      if (m.phase !== "downloading") refresh();
    });
    const unsubClone = bridge.onMiniMaxVoice?.((c) => {
      if (alive) setClone(c);
    });
    return () => {
      alive = false;
      unsubModel?.();
      unsubClone?.();
    };
  }, [bridge]);

  // A downloaded bundle counts the moment its state says ready; the initial
  // read's `bundle` covers the dev workspace's copy, which no download owns.
  const bundle =
    model !== null && model.phase === "ready" ? true : (rt?.bundle ?? false);
  const runtime = rt?.runtime ?? false;
  const failed = rt?.failed ?? false;
  const localCanSpeak = bundle && runtime && !failed;
  const cloudCanSpeak =
    (mmKey?.set ?? false) && clone !== null && clone.phase === "ready";
  const canSpeak = engine === "minimax" ? cloudCanSpeak : localCanSpeak;

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

  const onEngineChange = (next: VoiceEngine): void => {
    const write = bridge.setVoiceEngine;
    if (write === undefined) return;
    const prev = engine;
    setEngine(next);
    setEngineFailed(false);
    void write(next).catch(() => {
      setEngine(prev);
      setEngineFailed(true);
    });
  };

  const onKeySave = (): void => {
    const write = bridge.setMiniMaxKey;
    const key = keyDraft.trim();
    if (write === undefined || key.length === 0 || keySaving) return;
    setKeySaving(true);
    setKeyFailed(false);
    setKeyRejected(false);
    setKeyUnverified(false);
    void write(key)
      .then((r) => {
        if (!r.ok) {
          setKeyRejected(true);
          return;
        }
        setMmKey(r.status);
        setKeyDraft("");
        setKeyUnverified(r.unverified);
      })
      .catch(() => setKeyFailed(true))
      .finally(() => setKeySaving(false));
  };

  const onKeyDelete = (): void => {
    const clear = bridge.clearMiniMaxKey;
    if (clear === undefined || keyDeleting) return;
    setKeyDeleting(true);
    setKeyFailed(false);
    void clear()
      .then((r) => setMmKey(r.status))
      .catch(() => setKeyFailed(true))
      .finally(() => setKeyDeleting(false));
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

  const cloneRow = ((): {
    readonly description: string;
    readonly control: JSX.Element | null;
  } => {
    const keySet = mmKey?.set ?? false;
    const prepare = (
      <button
        type="button"
        className="settings-btn settings-btn--primary"
        disabled={!keySet || clone === null}
        onClick={() => void bridge.prepareMiniMaxVoice?.()}
      >
        {t("voice.clonePrepare")}
      </button>
    );
    if (clone === null) return { description: "—", control: prepare };
    switch (clone.phase) {
      case "preparing":
        return {
          description: t("voice.clonePreparing"),
          control: (
            <button type="button" className="settings-btn" disabled>
              {t("voice.clonePrepare")}
            </button>
          ),
        };
      case "ready":
        return {
          description: t("voice.cloneReady", {
            date: (clone.clonedAt ?? "").slice(0, 10),
          }),
          control: (
            <button
              type="button"
              className="settings-btn"
              disabled={!keySet}
              onClick={() => {
                const reset = bridge.resetMiniMaxVoice;
                const again = bridge.prepareMiniMaxVoice;
                if (reset === undefined || again === undefined) return;
                void reset().then(() => again());
              }}
            >
              {t("voice.cloneRedo")}
            </button>
          ),
        };
      case "failed":
        return {
          description: t(cloneFailureKey(clone.error ?? "other")),
          control: (
            <button
              type="button"
              className="settings-btn settings-btn--primary"
              disabled={!keySet}
              onClick={() => void bridge.prepareMiniMaxVoice?.()}
            >
              {t("voice.cloneRetry")}
            </button>
          ),
        };
      default:
        return { description: t("voice.cloneAbsent"), control: prepare };
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
          ) : engine === "local" && rt !== null && !runtime ? (
            <p className="settings-note">{t("voice.realtimeMissing")}</p>
          ) : engine === "local" && failed ? (
            <p className="settings-note">{t("voice.realtimeFailed")}</p>
          ) : null}
          {engineSupported && (
            <SettingRow
              title={t("voice.engine")}
              description={t("voice.engineDesc")}
              control={
                <Select<VoiceEngine>
                  value={engine}
                  ariaLabel={t("voice.engine")}
                  options={[
                    { value: "local", label: t("voice.engine.local") },
                    { value: "minimax", label: t("voice.engine.minimax") },
                  ]}
                  onChange={onEngineChange}
                />
              }
            />
          )}
          {engineFailed && (
            <p className="settings-note">{t("common.couldntSave")}</p>
          )}
          {modelSupported && engine === "local" && (
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
          {engineSupported && engine === "minimax" && (
            <>
              <p className="settings-note">{t("voice.minimaxNote")}</p>
              <SettingRow
                title={t("voice.minimaxKey")}
                description={t("voice.minimaxKeyDesc")}
                control={
                  mmKey === null ? (
                    <span className="settings-key-state is-muted">
                      {t("deepseek.checking")}
                    </span>
                  ) : mmKey.set ? (
                    <span className="settings-key-state is-connected">
                      <span className="settings-key-dot" aria-hidden="true" />
                      {t("deepseek.connected")} · …{mmKey.hint}
                    </span>
                  ) : (
                    <span className="settings-key-state is-muted">
                      {t("deepseek.noKey")}
                    </span>
                  )
                }
              />
              <div className="settings-key-form">
                <input
                  type="password"
                  className="settings-key-input"
                  placeholder={
                    mmKey?.set ? t("deepseek.replaceKey") : "sk-api-…"
                  }
                  aria-label={t("voice.minimaxKeyAria")}
                  autoComplete="off"
                  spellCheck={false}
                  value={keyDraft}
                  disabled={keySaving || keyDeleting}
                  onChange={(e) => {
                    setKeyDraft(e.target.value);
                    setKeyRejected(false);
                    setKeyUnverified(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onKeySave();
                    }
                  }}
                />
                <button
                  type="button"
                  className="settings-key-save"
                  disabled={
                    keyDraft.trim().length === 0 || keySaving || keyDeleting
                  }
                  onClick={onKeySave}
                >
                  {keySaving ? t("deepseek.verifying") : t("deepseek.save")}
                </button>
              </div>
              {mmKey?.set && (
                <button
                  type="button"
                  className="settings-key-delete"
                  disabled={keySaving || keyDeleting}
                  onClick={onKeyDelete}
                >
                  {keyDeleting
                    ? t("deepseek.deleting")
                    : t("deepseek.deleteKey")}
                </button>
              )}
              {keyRejected && (
                <p className="settings-note is-error">
                  {t("voice.minimaxRejected")}
                </p>
              )}
              {keyFailed && (
                <p className="settings-note">{t("common.couldntSave")}</p>
              )}
              {keyUnverified && (
                <p className="settings-note">{t("voice.minimaxUnverified")}</p>
              )}
              {mmKey?.set && !mmKey.encrypted && (
                <p className="settings-note">{t("deepseek.unencrypted")}</p>
              )}
              <SettingRow
                title={t("voice.clone")}
                description={cloneRow.description}
                control={cloneRow.control}
              />
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
