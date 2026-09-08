import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveTtsModelRoots,
  ttsBundleComplete,
  voiceModelStoreRoot,
} from "./tts-path.js";

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

describe("resolveTtsModelRoots (ADR 0061)", () => {
  it("dev: the downloaded copy first, then the workspace's data/tts/<bundle id>", () => {
    expect(
      resolveTtsModelRoots({
        userDataPath: "/home/u/AppData/herta",
        isPackaged: false,
        workspaceRoot: "/ws",
      }),
    ).toEqual([
      join("/home/u/AppData/herta", "tts", "herta-best-e72"),
      join("/ws", "data", "tts", "herta-best-e72"),
    ]);
  });

  it("packaged: ONLY the downloaded copy — the installer carries no bundle", () => {
    expect(
      resolveTtsModelRoots({
        userDataPath: "/home/u/AppData/herta",
        isPackaged: true,
        workspaceRoot: "/ws",
      }),
    ).toEqual([join("/home/u/AppData/herta", "tts", "herta-best-e72")]);
  });

  it("the store root is <userData>/tts", () => {
    expect(voiceModelStoreRoot("/home/u/AppData/herta")).toBe(
      join("/home/u/AppData/herta", "tts"),
    );
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
