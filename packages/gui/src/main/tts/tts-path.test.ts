import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTtsModelRoot, ttsBundleComplete } from "./tts-path.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "herta-tts-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A bundle with every file the Kokoro runtime opens. */
function makeBundle(root: string, opts: { omit?: string } = {}): void {
  const files = [
    "model.int8-81mb.onnx",
    "voices.bin",
    "frontend/tokens.txt",
    "frontend/lexicon-us-en.txt",
    "frontend/lexicon-zh.txt",
    "frontend/phone-zh.fst",
    "frontend/date-zh.fst",
    "frontend/number-zh.fst",
  ].filter((f) => f !== opts.omit);
  for (const rel of files) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "x");
  }
  if (opts.omit !== "frontend/espeak-ng-data") {
    mkdirSync(join(root, "frontend", "espeak-ng-data"), { recursive: true });
  }
}

describe("resolveTtsModelRoot", () => {
  it("dev: the workspace's data/tts/<bundle id>", () => {
    expect(
      resolveTtsModelRoot({
        isPackaged: false,
        resourcesPath: "/app/resources",
        workspaceRoot: "/ws",
      }),
    ).toBe(join("/ws", "data", "tts", "herta-best-e72"));
  });

  it("packaged: the bundled resources copy", () => {
    expect(
      resolveTtsModelRoot({
        isPackaged: true,
        resourcesPath: "/app/resources",
        workspaceRoot: "/ws",
      }),
    ).toBe(join("/app/resources", "tts", "herta-best-e72"));
  });
});

describe("ttsBundleComplete", () => {
  it("true for a complete bundle", () => {
    const root = tmp();
    makeBundle(root);
    expect(ttsBundleComplete(root)).toBe(true);
  });

  it("false when the model, the voicepack, a lexicon or an FST is missing", () => {
    for (const omit of [
      "model.int8-81mb.onnx",
      "voices.bin",
      "frontend/lexicon-zh.txt",
      "frontend/phone-zh.fst",
    ]) {
      const root = tmp();
      makeBundle(root, { omit });
      expect(ttsBundleComplete(root), `omitting ${omit}`).toBe(false);
    }
  });

  it("false without the espeak data directory", () => {
    const root = tmp();
    makeBundle(root, { omit: "frontend/espeak-ng-data" });
    expect(ttsBundleComplete(root)).toBe(false);
  });

  it("false — never throws — for a path that does not exist at all", () => {
    expect(ttsBundleComplete(join(tmp(), "nope"))).toBe(false);
  });

  it("false when a required entry is a DIRECTORY rather than a file", () => {
    const root = tmp();
    makeBundle(root, { omit: "model.int8-81mb.onnx" });
    mkdirSync(join(root, "model.int8-81mb.onnx"));
    expect(ttsBundleComplete(root)).toBe(false);
  });
});
