import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpeningChoice } from "@herta/herta";
import { describe, expect, it } from "vitest";
import { loadSessionVoice } from "./session-voice.js";
import type {
  SpeechSynthesizer,
  SynthesisRequest,
  VoiceCueEvent,
} from "./types.js";

/** A voice-clip root with one easter-egg clip whose stem is the line. */
const EGG_LINE = "你动它干什么？实在没事的话，过来帮我测模拟宇宙？";
function assets(): string {
  const root = mkdtempSync(join(tmpdir(), "herta-voice-"));
  mkdirSync(join(root, "easter_egg"));
  writeFileSync(join(root, "easter_egg", `${EGG_LINE}.opus`), "");
  mkdirSync(join(root, "particle", "唉"), { recursive: true });
  writeFileSync(join(root, "particle", "唉", "01.opus"), "");
  return root;
}

function fakeSynth(opts: {
  available: boolean;
  answer?: "audio" | "null" | "throw";
}): SpeechSynthesizer & { requests: SynthesisRequest[] } {
  const requests: SynthesisRequest[] = [];
  return {
    requests,
    available: () => opts.available,
    async synthesize(req) {
      requests.push(req);
      if (opts.answer === "throw") throw new Error("boom");
      if (opts.answer === "null") return null;
      return {
        samples: new Int16Array([1, 2, 3]),
        sampleRate: 24000,
        durationMs: 125,
      };
    },
    cancel: () => undefined,
  };
}

const opening: OpeningChoice = {
  preamble: "",
  seedText: "你来了。",
  sourceFile: "004-late-night-audit.txt",
  band: "neutral",
  voiceClipId: "004-late-night-audit",
};

async function voice(opts: {
  synth?: SpeechSynthesizer;
  lang?: "zh" | "en";
  withOpening?: boolean;
}) {
  const emitted: VoiceCueEvent[] = [];
  const v = await loadSessionVoice({
    voiceAssetsDir: assets(),
    lang: opts.lang ?? "zh",
    opening: opts.withOpening === false ? undefined : opening,
    emit: (e) => emitted.push(e),
    openingDurationMs: 1000,
    particleRandom: () => 0,
    easterEggRandom: () => 0, // the 50% roll always wins; the pick is the first
    easterEggNow: () => 1,
    ...(opts.synth !== undefined ? { synth: opts.synth } : {}),
  });
  return { v, emitted };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("session voice — one voice with the synthesizer on (ADR 0042 §7a)", () => {
  it("the opening: the clip cues by default; told `voiced`, no clip — the sink speaks it", async () => {
    const a = await voice({});
    a.v.onOpeningStreamStart();
    expect(a.emitted).toEqual([
      { kind: "cue", category: "openings", clipId: "004-late-night-audit" },
    ]);
    const b = await voice({ synth: fakeSynth({ available: true }) });
    b.v.onOpeningStreamStart(true);
    expect(b.emitted).toEqual([]);
  });

  it("the particle cue is withheld while the synthesizer is available — the synthesized unit carries it", async () => {
    const off = await voice({ synth: fakeSynth({ available: false }) });
    off.v.onPrimarySpeechStart("唉，又来了。");
    expect(off.emitted).toHaveLength(1);
    expect(off.emitted[0]).toMatchObject({
      kind: "cue",
      category: "particle/唉",
    });
    const on = await voice({ synth: fakeSynth({ available: true }) });
    on.v.onPrimarySpeechStart("唉，又来了。");
    expect(on.emitted).toEqual([]);
  });

  it("the lift's line is synthesized from the clip's stem: everything stops, then the unit", async () => {
    const synth = fakeSynth({ available: true, answer: "audio" });
    const { v, emitted } = await voice({ synth });
    v.maybePlayEasterEgg();
    await flush();
    expect(synth.requests).toEqual([
      { utteranceId: "egg1", seq: 0, text: EGG_LINE, lang: "zh" },
    ]);
    expect(emitted).toEqual([
      { kind: "ttsStop" },
      {
        kind: "tts",
        utteranceId: "egg1",
        seq: 0,
        samples: new Int16Array([1, 2, 3]),
        sampleRate: 24000,
        durationMs: 125,
      },
    ]);
  });

  it("a synthesis that answers null, or throws, falls back to the recording", async () => {
    for (const answer of ["null", "throw"] as const) {
      const { v, emitted } = await voice({
        synth: fakeSynth({ available: true, answer }),
      });
      v.maybePlayEasterEgg();
      await flush();
      expect(emitted).toEqual([
        { kind: "cue", category: "easter_egg", clipId: EGG_LINE },
      ]);
    }
  });

  it("without the synthesizer, or with it unavailable, the lift plays the recording as before", async () => {
    const none = await voice({});
    none.v.maybePlayEasterEgg();
    await flush();
    expect(none.emitted).toEqual([
      { kind: "cue", category: "easter_egg", clipId: EGG_LINE },
    ]);
    const off = await voice({ synth: fakeSynth({ available: false }) });
    off.v.maybePlayEasterEgg();
    await flush();
    expect(off.emitted).toEqual([
      { kind: "cue", category: "easter_egg", clipId: EGG_LINE },
    ]);
  });

  it("an EN session cues nothing, synthesizer or not (no EN voice in v1)", async () => {
    const synth = fakeSynth({ available: true });
    const { v, emitted } = await voice({ synth, lang: "en" });
    v.onPrimarySpeechStart("Well, again.");
    v.maybePlayEasterEgg();
    await flush();
    expect(emitted).toEqual([]);
    expect(synth.requests).toEqual([]);
  });
});
