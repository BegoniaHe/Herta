import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The bundle this build speaks with: the voice repo's `models/herta-best`
 * release (Stage 2 best checkpoint, epoch 72 — its `provenance.json` names it
 * `herta-best-e72`). The directory carries the release id so a later retrain
 * lands BESIDE it and the code says which one it expects, rather than a
 * bundle of unknown vintage silently answering to a generic name. Installed
 * and checksum-verified by `scripts/tts-bundle.mjs`.
 */
export const TTS_BUNDLE_ID = "herta-best-e72";

/**
 * Which of the two retained INT8 graphs ships. The voice repo keeps
 * `model.int8-81mb.onnx` (calibrated U8S8 reduced-range, sensitive vocoder
 * output in FP32; 85,111,939 bytes) and `model.int8-97mb.onnx` (more FP32
 * shortcut/prosody layers). On this non-VNNI CPU the larger one is ~8%
 * faster, not audibly better. Owner's call, 2026-09-05: the compact one.
 */
export const TTS_MODEL_FILE = "model.int8-81mb.onnx";

/**
 * The comm-channel treatment applied to every unit — she speaks over the
 * station terminal, so the dry studio render is band-limited with a faint,
 * speech-following noise floor (`terminal_textured`, listening-selected in
 * the voice repo on 2026-09-05 and the owner's pick for the app the same
 * day: "the 86MB one with tele terminal noise"). `none` is the dry voice;
 * `terminal` the older clean tone. Implemented in `comm-channel-effect.cjs`
 * beside the worker — pure JS, whole-unit, ~5 ms per second of audio.
 */
export const TTS_EFFECT = "terminal_textured";

/**
 * On-disk root of the neural-voice model bundle (ADR 0042). Mirrors
 * `resolveVoiceRoot`: a packaged app serves the bundled copy from its
 * resources dir (electron-builder `extraResources` copies `data/tts` →
 * `<resources>/tts`), dev reads straight from the workspace. Pure (the
 * caller injects `app.isPackaged` / `process.resourcesPath`) so it
 * unit-tests without electron.
 */
export function resolveTtsModelRoot(opts: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly workspaceRoot: string;
}): string {
  const base = opts.isPackaged
    ? join(opts.resourcesPath, "tts")
    : join(opts.workspaceRoot, "data", "tts");
  return join(base, TTS_BUNDLE_ID);
}

/** The files the Kokoro runtime actually opens (the `frontend/dict/` cppjieba
 *  tree is NOT among them — verified by smoke synthesis). `available()`
 *  reports false unless every one is present, so a partial/absent bundle
 *  degrades to the paced text reveal instead of a worker that dies on init.
 *  Mirrored in `scripts/check-tts-payload.mjs` and `scripts/tts-bundle.mjs`. */
const REQUIRED_FILES: readonly string[] = [
  TTS_MODEL_FILE,
  "voices.bin",
  "frontend/tokens.txt",
  "frontend/lexicon-us-en.txt",
  "frontend/lexicon-zh.txt",
  "frontend/phone-zh.fst",
  "frontend/date-zh.fst",
  "frontend/number-zh.fst",
];

/** True when `modelRoot` holds a usable bundle (every required file, plus a
 *  non-empty espeak-ng-data dir). Best-effort: any fs error → false. */
export function ttsBundleComplete(modelRoot: string): boolean {
  try {
    for (const rel of REQUIRED_FILES) {
      const p = join(modelRoot, rel);
      if (!existsSync(p) || !statSync(p).isFile()) return false;
    }
    const espeak = join(modelRoot, "frontend", "espeak-ng-data");
    return existsSync(espeak) && statSync(espeak).isDirectory();
  } catch {
    return false;
  }
}
