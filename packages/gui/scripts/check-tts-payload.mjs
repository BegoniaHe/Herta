/**
 * Report (and optionally require) the neural-voice payload before packaging.
 *
 *   node scripts/check-tts-payload.mjs            # report; never fails
 *   node scripts/check-tts-payload.mjs --strict   # missing payload = failure
 *
 * WHY (the B3 lesson, applied ahead of time). `extraResources` entries whose
 * source does not exist make electron-builder log one line and exit 0 — so a
 * voiceless build packages, uploads, and becomes the release, and at runtime
 * it fails silently too: the synthesizer reports unavailable and every reply
 * simply types. That is a legitimate build (an install without the model is
 * supposed to degrade quietly), which is exactly why it needs SAYING at build
 * time rather than being discovered by a user who expected a voice.
 *
 * Reporting rather than failing by default is deliberate: unlike the voice
 * CLIPS — which the README promises in every official installer — the ~110 MB
 * model bundle is an asset the owner may or may not want in a given build.
 * `--strict` is there for the release script the day that decision is made.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GUI_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(GUI_ROOT, "../..");
const MODEL_ROOT = join(REPO_ROOT, "data", "tts", "herta-best-e72");
const STAGE_DIR = join(GUI_ROOT, "tts-runtime");
const STRICT = process.argv.includes("--strict");

/** The files the Kokoro runtime opens — mirrors `REQUIRED_FILES` in
 *  src/main/tts/tts-path.ts, which decides `available()` at runtime. */
const REQUIRED = [
  "model.int8-81mb.onnx",
  "voices.bin",
  "frontend/tokens.txt",
  "frontend/lexicon-us-en.txt",
  "frontend/lexicon-zh.txt",
  "frontend/phone-zh.fst",
  "frontend/date-zh.fst",
  "frontend/number-zh.fst",
];

function dirBytes(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  };
  walk(dir);
  return total;
}

const problems = [];

if (!existsSync(MODEL_ROOT)) {
  problems.push(`no model bundle at ${MODEL_ROOT}`);
} else {
  const missing = REQUIRED.filter((r) => !existsSync(join(MODEL_ROOT, r)));
  if (missing.length > 0) {
    problems.push(`model bundle incomplete — missing ${missing.join(", ")}`);
  }
  const espeak = join(MODEL_ROOT, "frontend", "espeak-ng-data");
  if (!existsSync(espeak)) {
    problems.push("model bundle has no frontend/espeak-ng-data");
  }
}

if (!existsSync(STAGE_DIR)) {
  problems.push(
    `no staged native runtime at ${STAGE_DIR} — run: node scripts/stage-tts.mjs`,
  );
} else if (!existsSync(join(STAGE_DIR, "sherpa-onnx-node", "sherpa-onnx.js"))) {
  problems.push("staged runtime has no sherpa-onnx-node");
} else {
  const addons = readdirSync(STAGE_DIR).filter((n) =>
    existsSync(join(STAGE_DIR, n, "sherpa-onnx.node")),
  );
  if (addons.length === 0) {
    problems.push("staged runtime has no platform addon (sherpa-onnx.node)");
  }
}

if (problems.length === 0) {
  const model = (dirBytes(MODEL_ROOT) / 1e6).toFixed(1);
  const runtime = (dirBytes(STAGE_DIR) / 1e6).toFixed(1);
  const addons = readdirSync(STAGE_DIR)
    .filter((n) => existsSync(join(STAGE_DIR, n, "sherpa-onnx.node")))
    .join(", ");
  console.log(
    `[tts-payload] OK — model ${model} MB, runtime ${runtime} MB (${addons})`,
  );
  process.exit(0);
}

const label = STRICT ? "ERROR" : "NOTICE";
console.error(
  `\n[tts-payload] ${label}: this build will ship WITHOUT a voice.`,
);
for (const p of problems) console.error(`  - ${p}`);
console.error(
  "  Herta will still run; every reply types at the read-along pace.\n" +
    "  To include it: node scripts/tts-bundle.mjs <voice-repo>/models/herta-best\n" +
    "  (from the repo root; installs data/tts/herta-best-e72 — see ADR 0042),\n" +
    "  then run  node scripts/stage-tts.mjs\n",
);
process.exit(STRICT ? 1 : 0);
