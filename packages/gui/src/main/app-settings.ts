import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * User app settings, persisted to `<workspaceRoot>/.herta/settings.json`
 * (workspace-scoped, gitignored). Extensible — future sections add keys. Read
 * at app-server bootstrap (`buildConfig`); changes apply on the next launch.
 */
/** Backend (差分协处理器) reasoning effort tiers, as accepted by the DeepSeek
 *  API since its 2026-07-31 update. NOTE: deepseek-v4-pro maps a sent "low"
 *  to "high" server-side until its announced early-August-2026 update — we
 *  store and send the user's choice as-is so it starts meaning "low" the day
 *  DeepSeek ships that, with no change here. */
export type BackendThinking = "low" | "high" | "max";

const BACKEND_THINKING_VALUES: readonly string[] = ["low", "high", "max"];

/** Narrow an untrusted (hand-editable settings.json) value to a valid tier. */
export function isBackendThinking(v: unknown): v is BackendThinking {
  return typeof v === "string" && BACKEND_THINKING_VALUES.includes(v);
}

/** The DeepSeek models the app can drive each stage with (2026-08-17, owner:
 *  API prices rose; the actor is the biggest per-turn lever). The completion
 *  endpoint accepts only the first two names — which is why the vision model
 *  below is BACKEND-only. */
export type ModelChoice = "deepseek-v4-pro" | "deepseek-v4-flash";

const MODEL_CHOICE_VALUES: readonly string[] = [
  "deepseek-v4-pro",
  "deepseek-v4-flash",
];

export function isModelChoice(v: unknown): v is ModelChoice {
  return typeof v === "string" && MODEL_CHOICE_VALUES.includes(v);
}

/**
 * 板砖's models (ADR 0048 §5) — the two above plus the vision model, which
 * mounts `view_image` so a visual question can be answered by a re-look
 * instead of the attachment caption's one-shot reading.
 *
 * Backend-only, for a hard reason: images ride chat-shaped endpoints, and the
 * ACTOR runs on the completion endpoint, which accepts neither images nor
 * this model name (D8). Opt-in and not the default while it is `-Exp`, and
 * until the backend labs have been rerun on it (the stage→model rule).
 */
export type BackendModelChoice = ModelChoice | "deepseek-v4-flash-vision-exp";

const BACKEND_MODEL_VALUES: readonly string[] = [
  ...MODEL_CHOICE_VALUES,
  "deepseek-v4-flash-vision-exp",
];

export function isBackendModelChoice(v: unknown): v is BackendModelChoice {
  return typeof v === "string" && BACKEND_MODEL_VALUES.includes(v);
}

/** Which model-facing tool contract 板砖 runs (ADR 0040, 2026-08-17).
 *  `standard` = the 15-tool set + the long execution contract; `minimal` = the
 *  DeepSeek-trained shape (persistent `bash` + `str_replace_editor` + the
 *  two record channels) with the short 板砖 prompt — same reliability in the
 *  lab, ~½ the prompt tokens, ~⅒ the cache-miss tokens. Needs a bash on this
 *  machine (Git for Windows ships one); without one the app falls back to
 *  `standard` and says so at session start. */
export type BackendContractChoice = "standard" | "minimal";

const BACKEND_CONTRACT_VALUES: readonly string[] = ["standard", "minimal"];

export function isBackendContract(v: unknown): v is BackendContractChoice {
  return typeof v === "string" && BACKEND_CONTRACT_VALUES.includes(v);
}

export interface AppSettings {
  readonly dream?: { readonly enabled?: boolean };
  readonly backend?: {
    readonly thinking?: BackendThinking;
    /** Settings → 差分协处理器 → 工具契约. Absent = standard. Restart-to-apply. */
    readonly contract?: BackendContractChoice;
  };
  /** Per-stage model choice (Settings → DeepSeek → 模型). `actor` drives the
   *  narrative actor (speech / thought / beats, completion mode); `backend`
   *  drives 板砖 (chat + tools). Absent = the built-in default (Pro for
   *  both). Read at bootstrap; restart-to-apply like the rows above. */
  readonly models?: {
    readonly actor?: ModelChoice;
    /** 板砖 may also run the vision model (ADR 0048 §5); the actor may not —
     *  the completion endpoint does not accept it. */
    readonly backend?: BackendModelChoice;
  };
}

function settingsPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".herta", "settings.json");
}

/**
 * Read the settings file. Best-effort: a missing / unreadable / corrupt /
 * non-object file resolves to `{}` so every setting falls back to its default.
 */
export async function readAppSettings(
  workspaceRoot: string,
): Promise<AppSettings> {
  try {
    const raw = await readFile(settingsPath(workspaceRoot), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    // A malformed nested section (e.g. a hand-edited `"dream": 5`) → fall back
    // to defaults rather than hand back a shape that violates AppSettings.
    const { dream, backend, models } = parsed as {
      dream?: unknown;
      backend?: unknown;
      models?: unknown;
    };
    if (dream !== undefined && (typeof dream !== "object" || dream === null)) {
      return {};
    }
    if (
      backend !== undefined &&
      (typeof backend !== "object" || backend === null)
    ) {
      return {};
    }
    if (
      models !== undefined &&
      (typeof models !== "object" || models === null)
    ) {
      return {};
    }
    return parsed as AppSettings;
  } catch {
    return {};
  }
}

/** Write the settings file, creating `.herta/` if needed. Temp + rename so a
 *  crash mid-write can't tear the file into "all defaults" (audit 2026-07-13
 *  T3.9, same fix as app-global-settings). */
export async function writeAppSettings(
  workspaceRoot: string,
  settings: AppSettings,
): Promise<void> {
  const path = settingsPath(workspaceRoot);
  await mkdir(dirname(path), { recursive: true });
  // Unique temp name (audit BL7). A FIXED `.tmp` path with no serialization
  // meant two concurrent writes — two Settings panes, or a fast toggle —
  // interleaved on the same file: writer A's rename could publish writer B's
  // half-written bytes. That race is what made the Settings error-note bug
  // (BL14) reachable at all.
  const tmp = `${path}.${process.pid}.${settingsWriteSeq++}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {
      /* temp already gone or undeletable */
    });
    throw err;
  }
}

/** Per-process counter for temp names. */
let settingsWriteSeq = 0;
