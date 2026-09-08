import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SpeechSynthesizer,
  SynthesisRequest,
  SynthesizedAudio,
  VoiceCueEvent,
} from "../types.js";
import {
  createVoicedReveal,
  PREROLL_MAX_MS,
  SILENT_UNIT_MS,
  type VoicedRevealDeps,
} from "./voiced-reveal.js";

/** A synthesizer whose requests resolve only when the test says so. */
function fakeSynth(): SpeechSynthesizer & {
  readonly requests: SynthesisRequest[];
  readonly cancelled: string[];
  resolve(seq: number, durationMs: number | null): void;
} {
  const pending = new Map<number, (a: SynthesizedAudio | null) => void>();
  const requests: SynthesisRequest[] = [];
  const cancelled: string[] = [];
  return {
    requests,
    cancelled,
    available: () => true,
    synthesize(req) {
      requests.push(req);
      return new Promise((res) => {
        pending.set(req.seq, res);
      });
    },
    cancel(id) {
      cancelled.push(id);
    },
    resolve(seq, durationMs) {
      const res = pending.get(seq);
      if (res === undefined) throw new Error(`no pending request ${seq}`);
      pending.delete(seq);
      res(
        durationMs === null
          ? null
          : {
              samples: new Int16Array(Math.round((durationMs / 1000) * 24000)),
              sampleRate: 24000,
              durationMs,
            },
      );
    },
  };
}

function harness(
  over: Partial<VoicedRevealDeps> & {
    synth?: ReturnType<typeof fakeSynth>;
  } = {},
) {
  const synth = over.synth ?? fakeSynth();
  const emitted: string[] = [];
  const voice: VoiceCueEvent[] = [];
  let begun = 0;
  let finished: boolean[] = [];
  const deps: VoicedRevealDeps = {
    synth,
    utteranceId: "u1",
    lang: "zh",
    mode: "cjk",
    fallbackBaseMs: 80,
    maxUtteranceMs: 600_000,
    emitRange: (text) => emitted.push(text),
    onBegin: () => {
      begun += 1;
    },
    onFinish: (b) => {
      finished = [...finished, b];
    },
    emitVoice: (ev) => voice.push(ev),
    ...over,
  };
  const ctl = createVoicedReveal(deps);
  return {
    ctl,
    synth,
    emitted,
    voice,
    text: () => emitted.join(""),
    begun: () => begun,
    finished: () => finished,
    tts: () => voice.filter((v) => v.kind === "tts"),
    stops: () => voice.filter((v) => v.kind === "ttsStop"),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createVoicedReveal", () => {
  it("synthesizes a unit the moment it closes and reveals its text across the audio", async () => {
    const h = harness();
    h.ctl.pushToken("第一句话。第二");
    // Unit 0 ("第一句话。") closed once a char followed the ender.
    expect(h.synth.requests.map((r) => [r.seq, r.text])).toEqual([
      [0, "第一句话。"],
    ]);
    expect(h.text()).toBe(""); // nothing until the audio exists
    h.synth.resolve(0, 1000);
    // Pre-roll: with a second unit still open, unit 0 waits out the cap
    // before starting (see PREROLL_MAX_MS).
    await vi.advanceTimersByTimeAsync(PREROLL_MAX_MS);
    // Audio emitted as the unit starts; the first char lands at t≈0 of the span.
    expect(h.tts()).toHaveLength(1);
    expect(h.begun()).toBe(1);
    // Unit 0 = "第一句话。": 5 chars, 。 weighted 3 → total 7; char i lands
    // at 1000·(cumulative weight)/7. By 300 ms two chars are out.
    await vi.advanceTimersByTimeAsync(300);
    expect(h.text()).toBe("第一"); // 2 chars by ~285 ms
    await vi.advanceTimersByTimeAsync(700);
    expect(h.text()).toBe("第一句话。");
    // Unit 1 is still open (no ender) → nothing more yet.
    h.ctl.pushToken("句。");
    h.ctl.finishInput();
    expect(h.synth.requests.map((r) => r.seq)).toEqual([0, 1]);
    h.synth.resolve(1, 500);
    await vi.advanceTimersByTimeAsync(600);
    expect(h.text()).toBe("第一句话。第二句。");
    await h.ctl.done;
    expect(h.finished()).toEqual([true]);
    expect(h.tts().map((t) => (t as { seq: number }).seq)).toEqual([0, 1]);
  });

  it("holds the LAST unit of a supervised stream until fastForward; earlier units play pre-verdict", async () => {
    let resolveVerdict!: () => void;
    const verdictPending = new Promise<void>((r) => {
      resolveVerdict = r;
    });
    const h = harness({ verdictPending });
    h.ctl.pushToken("先说这个。再说那个。");
    h.ctl.finishInput();
    h.synth.resolve(0, 400);
    h.synth.resolve(1, 400);
    await vi.advanceTimersByTimeAsync(1000);
    // Unit 0 played; unit 1 (the last) holds.
    expect(h.text()).toBe("先说这个。");
    expect(h.tts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.text()).toBe("先说这个。");
    resolveVerdict();
    const ff = h.ctl.fastForward();
    await vi.advanceTimersByTimeAsync(500);
    await ff;
    expect(h.text()).toBe("先说这个。再说那个。");
    expect(h.tts()).toHaveLength(2);
  });

  it("a single-sentence supervised reply reveals nothing until the verdict", async () => {
    const h = harness({ verdictPending: new Promise<void>(() => {}) });
    h.ctl.pushToken("就一句。");
    h.ctl.finishInput();
    h.synth.resolve(0, 300);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.text()).toBe("");
    expect(h.tts()).toHaveLength(0);
    h.ctl.done.catch(() => undefined);
  });

  it("cancel (a veto) stops the audio mid-unit, rejects done, and reports the partial cursor", async () => {
    const h = harness();
    h.ctl.pushToken("这句话会被否掉。然后");
    h.synth.resolve(0, 1000);
    // Past the pre-roll (the second unit is still open), then partway in.
    await vi.advanceTimersByTimeAsync(PREROLL_MAX_MS);
    await vi.advanceTimersByTimeAsync(400);
    const shown = h.text();
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(8);
    expect(h.ctl.cancel()).toBe(true);
    expect(h.ctl.cancel()).toBe(false); // idempotent
    expect(h.stops()).toEqual([{ kind: "ttsStop", utteranceId: "u1" }]);
    expect(h.synth.cancelled).toEqual(["u1"]);
    expect(h.ctl.cursor).toBe([...shown].length);
    await expect(h.ctl.done).rejects.toThrow("slow-stream cancelled");
    // No further reveal after the cut.
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.text()).toBe(shown);
  });

  it("flushTail (interrupt) lands the whole remainder in one emit and stops the audio", async () => {
    const h = harness();
    h.ctl.pushToken("第一句。第二句还在生成");
    h.synth.resolve(0, 1000);
    await vi.advanceTimersByTimeAsync(300);
    h.ctl.flushTail();
    expect(h.text()).toBe("第一句。第二句还在生成");
    expect(h.emitted[h.emitted.length - 1]).toContain("第二句还在生成");
    expect(h.stops()).toHaveLength(1);
    await h.ctl.done;
    expect(h.finished()).toEqual([true]);
  });

  it("a failed synthesis types that unit unvoiced at the fallback cadence (no audio event)", async () => {
    const h = harness({ fallbackBaseMs: 100 });
    h.ctl.pushToken("坏掉的一句。");
    h.ctl.finishInput();
    h.synth.resolve(0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.tts()).toHaveLength(0);
    // 6 chars, 。 weighted 3 → 8 × 100 ms.
    await vi.advanceTimersByTimeAsync(400);
    expect(h.text().length).toBeGreaterThan(0);
    expect(h.text().length).toBeLessThan(6);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.text()).toBe("坏掉的一句。");
    await h.ctl.done;
  });

  it("a silent unit (fenced code) lands atomically, holds a beat, then the next unit plays", async () => {
    const h = harness();
    const text = "看这段：\n```\nx = 1\n```\n完了。";
    h.ctl.pushToken(text);
    h.ctl.finishInput();
    // Units: "看这段：\n" (spoken), fence (silent), "完了。" (spoken).
    expect(h.synth.requests.map((r) => r.seq)).toEqual([0, 2]);
    h.synth.resolve(0, 200);
    h.synth.resolve(2, 200);
    // Unit 0 ("看这段：\n") plays over 200 ms; when it ends the silent fence
    // unit lands atomically in ONE emit and holds SILENT_UNIT_MS.
    await vi.advanceTimersByTimeAsync(210);
    expect(h.text()).toBe("看这段：\n```\nx = 1\n```\n");
    expect(h.emitted[h.emitted.length - 1]).toBe("```\nx = 1\n```\n");
    // The next audio waits out the silent beat (still only unit 0's tts).
    expect(h.tts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SILENT_UNIT_MS);
    expect(h.tts()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(300);
    expect(h.text()).toBe(text);
    await h.ctl.done;
  });

  it("synthesizes only `lookahead` units past the one playing", async () => {
    const h = harness({ lookahead: 1 });
    h.ctl.pushToken("一句。两句。三句。四句。");
    h.ctl.finishInput();
    expect(h.synth.requests.map((r) => r.seq)).toEqual([0, 1]);
    h.synth.resolve(0, 100);
    // Unit 1's audio in hand satisfies the pre-roll, so unit 0 starts at once.
    h.synth.resolve(1, 100);
    await vi.advanceTimersByTimeAsync(110);
    expect(h.synth.requests.map((r) => r.seq)).toEqual([0, 1, 2]);
    h.synth.resolve(2, 100);
    await vi.advanceTimersByTimeAsync(220);
    expect(h.synth.requests.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    h.synth.resolve(3, 100);
    await vi.advanceTimersByTimeAsync(200);
    await h.ctl.done;
    expect(h.text()).toBe("一句。两句。三句。四句。");
  });

  it("finishInput on an empty stream resolves done without ever beginning", async () => {
    const h = harness();
    h.ctl.finishInput();
    await h.ctl.done;
    expect(h.begun()).toBe(0);
    expect(h.finished()).toEqual([false]);
    expect(h.synth.requests).toHaveLength(0);
  });

  it("EN word mode reveals whole words per step across the audio", async () => {
    const h = harness({ lang: "en", mode: "word" });
    h.ctl.pushToken("Run it again. ");
    h.ctl.pushToken("Now.");
    h.ctl.finishInput();
    h.synth.resolve(0, 600);
    h.synth.resolve(1, 100); // satisfies the pre-roll
    await vi.advanceTimersByTimeAsync(700);
    expect(h.emitted.slice(0, 3)).toEqual(["Run ", "it ", "again. "]);
    await vi.advanceTimersByTimeAsync(200);
    await h.ctl.done;
    expect(h.text()).toBe("Run it again. Now.");
  });

  it("the reveal ceiling flushes a runaway utterance once input is finished and the verdict resolved", async () => {
    const h = harness({ maxUtteranceMs: 1000 });
    h.ctl.pushToken("一句。两句。三句。");
    h.ctl.finishInput();
    h.synth.resolve(0, 800);
    h.synth.resolve(1, 800);
    h.synth.resolve(2, 800);
    await vi.advanceTimersByTimeAsync(850);
    expect(h.text()).toBe("一句。");
    // Unit 1 starts at ~800 ms (under the ceiling); by its end we are past it,
    // so unit 2 is flushed rather than played.
    await vi.advanceTimersByTimeAsync(850);
    expect(h.text()).toBe("一句。两句。三句。");
    expect(h.tts()).toHaveLength(2);
    expect(h.stops()).toHaveLength(1);
    await h.ctl.done;
  });

  it("pre-roll: a SHORT opener waits for the next unit's audio instead of stranding the reply", async () => {
    // The shape the voice lab caught: "行。" (0.9 s of audio) followed by a
    // sentence that takes 3 s to synthesize — starting immediately meant 2.4 s
    // of dead silence mid-reply. The wait now sits BEFORE she speaks.
    const h = harness();
    h.ctl.pushToken("行。@板砖 去把游标重置修了。");
    h.ctl.finishInput();
    h.synth.resolve(0, 900);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.text()).toBe(""); // holding for unit 1
    expect(h.tts()).toHaveLength(0);
    h.synth.resolve(1, 3000);
    await vi.advanceTimersByTimeAsync(1);
    // Both are in hand → she starts, and the two play back to back.
    expect(h.tts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(900);
    expect(h.tts()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.text()).toBe("行。@板砖 去把游标重置修了。");
    await h.ctl.done;
  });

  it("pre-roll: a slow second unit does not hold speech past the cap", async () => {
    const h = harness();
    h.ctl.pushToken("行。再说一句。");
    h.ctl.finishInput();
    h.synth.resolve(0, 900);
    await vi.advanceTimersByTimeAsync(PREROLL_MAX_MS - 1);
    expect(h.tts()).toHaveLength(0); // still waiting
    await vi.advanceTimersByTimeAsync(2);
    expect(h.tts()).toHaveLength(1); // cap reached — she starts anyway
    h.synth.resolve(1, 500);
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.text()).toBe("行。再说一句。");
    await h.ctl.done;
  });

  it("pre-roll: a lone unit on finished input starts immediately", async () => {
    const h = harness();
    h.ctl.pushToken("就一句。");
    h.ctl.finishInput();
    h.synth.resolve(0, 300);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.tts()).toHaveLength(1); // nothing to wait for
    await vi.advanceTimersByTimeAsync(320);
    expect(h.text()).toBe("就一句。");
    await h.ctl.done;
  });

  it("startAfter defers the first unit until the previous voiced stream settles", async () => {
    let release!: () => void;
    const startAfter = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({ startAfter });
    h.ctl.pushToken("等前面说完。");
    h.ctl.finishInput();
    h.synth.resolve(0, 200);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.text()).toBe("");
    release();
    await vi.advanceTimersByTimeAsync(250);
    expect(h.text()).toBe("等前面说完。");
    await h.ctl.done;
  });
});
