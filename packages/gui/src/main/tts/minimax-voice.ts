import {
  cloneVoice,
  type FetchLike,
  MiniMaxError,
  type MiniMaxFailure,
  makeVoiceId,
  probeHost,
  uploadReference,
} from "./minimax-api.js";

/**
 * The clone this install owns on MiniMax (ADR 0062): made from the shipped
 * reference on the user's say-so (Settings → 语音 → 准备声音), remembered
 * with the platform it lives on, re-made when MiniMax has deleted it (a
 * clone idle for 7 days is removed) — the synthesizer reports the missing
 * voice and this re-clones once, automatically, because the user already
 * chose the engine and the key.
 */
export type MiniMaxVoicePhase = "absent" | "preparing" | "ready" | "failed";

export type MiniMaxVoiceError = MiniMaxFailure | "reference";

export interface MiniMaxVoiceRecord {
  readonly voiceId: string;
  readonly host: string;
  readonly clonedAt: string;
  readonly lastUsedAt?: string;
}

export interface MiniMaxVoiceState {
  readonly phase: MiniMaxVoicePhase;
  readonly error?: MiniMaxVoiceError;
  readonly voiceId?: string;
  readonly host?: string;
  readonly clonedAt?: string;
}

export interface MiniMaxVoiceServiceOptions {
  readonly fetch: FetchLike;
  readonly key: () => string | null;
  /** The shipped reference WAV, or null when the install lacks it. */
  readonly readReference: () => Promise<Uint8Array | null>;
  /** The persisted record at start (the settings file), or null. */
  readonly initial: MiniMaxVoiceRecord | null;
  /** Persist the record (null = forget). Never throws to the caller. */
  readonly save: (record: MiniMaxVoiceRecord | null) => Promise<void>;
  readonly onChange: (state: MiniMaxVoiceState) => void;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
  readonly random?: () => string;
  /** Minimum ms between `lastUsedAt` writes. */
  readonly usedStampEveryMs?: number;
}

export interface MiniMaxVoiceService {
  state(): MiniMaxVoiceState;
  /** The current clone for the synthesizer, or null. */
  voice(): { readonly voiceId: string; readonly host: string } | null;
  /** Probe the key's platform, upload the reference, clone. Idempotent while
   *  one runs; a no-op when a voice is already ready. Never rejects. */
  prepare(): Promise<MiniMaxVoiceState>;
  /** Forget the clone (the platform's copy expires on its own). */
  reset(): Promise<MiniMaxVoiceState>;
  /** The synthesizer found the voice gone: forget it and re-clone once. */
  markMissing(voiceId: string): void;
  /** A unit was billed: stamp `lastUsedAt`, throttled. */
  stampUsed(): void;
}

export function createMiniMaxVoiceService(
  opts: MiniMaxVoiceServiceOptions,
): MiniMaxVoiceService {
  const log = opts.log ?? ((l: string) => console.log(`[herta-minimax] ${l}`));
  const now = opts.now ?? (() => new Date());
  const stampEvery = opts.usedStampEveryMs ?? 10 * 60 * 1000;
  let record: MiniMaxVoiceRecord | null = opts.initial;
  let inFlight: Promise<MiniMaxVoiceState> | null = null;
  // Set INSIDE `run` before its first push: the promise is assigned to
  // `inFlight` only after `run()` returns, and its synchronous head has
  // already reported the state by then.
  let preparing = false;
  let lastError: MiniMaxVoiceError | null = null;
  let lastStamp = 0;
  let recloneUsed = false;

  const state = (): MiniMaxVoiceState => {
    if (preparing || inFlight !== null) return { phase: "preparing" };
    if (record !== null) {
      return {
        phase: "ready",
        voiceId: record.voiceId,
        host: record.host,
        clonedAt: record.clonedAt,
      };
    }
    return lastError !== null
      ? { phase: "failed", error: lastError }
      : { phase: "absent" };
  };

  const persist = async (next: MiniMaxVoiceRecord | null): Promise<void> => {
    record = next;
    try {
      await opts.save(next);
    } catch (err) {
      log(`could not persist the voice record: ${String(err)}`);
    }
  };

  const run = async (): Promise<MiniMaxVoiceState> => {
    preparing = true;
    lastError = null;
    opts.onChange(state());
    try {
      const key = opts.key();
      if (key === null) throw new MiniMaxError("no_key", "no MiniMax key");
      const reference = await opts.readReference();
      if (reference === null) {
        lastError = "reference";
        throw new Error("the reference audio is not in this install");
      }
      const host = await probeHost(opts.fetch, key);
      const fileId = await uploadReference(
        opts.fetch,
        host,
        key,
        reference,
        "herta-reference.wav",
      );
      const voiceId = makeVoiceId(opts.random);
      await cloneVoice(opts.fetch, host, key, fileId, voiceId);
      await persist({ voiceId, host, clonedAt: now().toISOString() });
      log(`cloned ${voiceId} on ${host}`);
    } catch (err) {
      if (lastError === null) {
        lastError = err instanceof MiniMaxError ? err.reason : "other";
      }
      log(
        `prepare failed (${lastError}): ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      preparing = false;
      inFlight = null;
    }
    const s = state();
    opts.onChange(s);
    return s;
  };

  return {
    state,
    voice() {
      return record === null
        ? null
        : { voiceId: record.voiceId, host: record.host };
    },
    prepare(): Promise<MiniMaxVoiceState> {
      if (inFlight !== null) return inFlight;
      if (record !== null) return Promise.resolve(state());
      recloneUsed = false;
      inFlight = run();
      return inFlight;
    },
    async reset(): Promise<MiniMaxVoiceState> {
      if (inFlight !== null) await inFlight;
      await persist(null);
      lastError = null;
      const s = state();
      opts.onChange(s);
      return s;
    },
    markMissing(voiceId: string): void {
      if (record === null || record.voiceId !== voiceId) return;
      void persist(null).then(() => {
        opts.onChange(state());
        // One automatic re-clone per missing voice: the user chose the engine
        // and the key; a second failure in a row is theirs to look at.
        if (recloneUsed) return;
        recloneUsed = true;
        inFlight = run();
      });
    },
    stampUsed(): void {
      if (record === null) return;
      const t = Date.now();
      if (t - lastStamp < stampEvery) return;
      lastStamp = t;
      void persist({ ...record, lastUsedAt: now().toISOString() });
    },
  };
}
