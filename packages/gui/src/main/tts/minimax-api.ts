/**
 * The MiniMax speech API, as much of it as the cloud voice needs (ADR 0062):
 * find the platform a key belongs to, upload the reference, clone, and
 * synthesize one unit as raw PCM. Pure Node — `fetch` is injected (Electron's
 * proxy-aware `net.fetch` in the app, a fake in tests), the key is a plain
 * argument that is never logged.
 *
 * Two platforms answer the same API with the same key format: the
 * international host and the China host. A key belongs to exactly one; the
 * other answers 2049 "invalid api key". `probeHost` tries both with a cheap
 * authenticated call and remembers which one worked.
 */
export const MINIMAX_HOSTS: readonly string[] = [
  "https://api.minimax.io",
  "https://api.minimaxi.com",
];

export const MINIMAX_DEFAULT_MODEL = "speech-2.8-hd";

export type MiniMaxFailure =
  | "no_key"
  | "invalid_key"
  | "auth"
  | "rate"
  | "quota"
  | "sensitive"
  | "voice_missing"
  | "invalid"
  | "network"
  | "http"
  | "cancelled"
  | "other";

export class MiniMaxError extends Error {
  constructor(
    readonly reason: MiniMaxFailure,
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "MiniMaxError";
  }
}

export type FetchLike = (
  url: string,
  init: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string | FormData;
    readonly signal?: AbortSignal;
  },
) => Promise<Response>;

interface BaseResp {
  readonly status_code?: number;
  readonly status_msg?: string;
}

/** MiniMax's status codes, as far as the docs and one afternoon's calls go:
 *  2049 the key is not this platform's; 1004 authentication; 1002/1039 rate
 *  limits; 1008 balance; 2013 invalid params — which is also what a missing
 *  voice comes back as, told apart by its message. */
export function classifyStatus(
  code: number | undefined,
  msg: string | undefined,
): MiniMaxFailure {
  const m = (msg ?? "").toLowerCase();
  if (code === 2049) return "invalid_key";
  if (code === 1004) return "auth";
  if (code === 1002 || code === 1039) return "rate";
  if (code === 1008 || m.includes("balance") || m.includes("insufficient")) {
    return "quota";
  }
  if (m.includes("sensitive")) return "sensitive";
  if (m.includes("voice")) return "voice_missing";
  if (code === 2013) return "invalid";
  return "other";
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

async function call(
  fetch: FetchLike,
  url: string,
  init: Parameters<FetchLike>[1],
): Promise<{ readonly json: Record<string, unknown>; readonly text: string }> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new MiniMaxError(
      isAbort(err) || init.signal?.aborted === true ? "cancelled" : "network",
      err instanceof Error ? err.message : String(err),
    );
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new MiniMaxError(
      isAbort(err) ? "cancelled" : "network",
      err instanceof Error ? err.message : String(err),
    );
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new MiniMaxError("http", `HTTP ${res.status}: non-JSON body`);
  }
  const base = (json.base_resp ?? {}) as BaseResp;
  if (!res.ok) {
    throw new MiniMaxError(
      classifyStatus(base.status_code, base.status_msg),
      `HTTP ${res.status} ${base.status_msg ?? ""}`.trim(),
      base.status_code,
    );
  }
  if (base.status_code !== undefined && base.status_code !== 0) {
    throw new MiniMaxError(
      classifyStatus(base.status_code, base.status_msg),
      `${base.status_code} ${base.status_msg ?? ""}`.trim(),
      base.status_code,
    );
  }
  return { json, text };
}

function auth(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

/**
 * The platform this key belongs to. A cheap authenticated call per host; a
 * host that says "invalid api key" (2049) is the wrong one, and one that
 * says "login fail" (1004) did not authenticate the key at all — a key
 * that is nobody's gets 1004 from BOTH hosts (measured 2026-09-08; the
 * first cut counted that as accepted and stored the wrong key as 已连接).
 * Any other answer — success or a parameter complaint — proves the key
 * authenticated there. Throws `invalid_key` when neither accepts it.
 */
export async function probeHost(
  fetch: FetchLike,
  key: string,
  signal?: AbortSignal,
  hosts: readonly string[] = MINIMAX_HOSTS,
): Promise<string> {
  let lastNetwork: MiniMaxError | null = null;
  for (const host of hosts) {
    try {
      await call(fetch, `${host}/v1/get_voice`, {
        method: "POST",
        headers: { ...auth(key), "Content-Type": "application/json" },
        body: JSON.stringify({ voice_type: "voice_cloning" }),
        signal,
      });
      return host;
    } catch (err) {
      if (!(err instanceof MiniMaxError)) throw err;
      if (err.reason === "invalid_key" || err.reason === "auth") continue;
      if (err.reason === "cancelled") throw err;
      if (err.reason === "network" || err.reason === "http") {
        lastNetwork = err;
        continue;
      }
      // Authenticated, whatever else it disliked.
      return host;
    }
  }
  throw (
    lastNetwork ??
    new MiniMaxError("invalid_key", "no platform accepted the key")
  );
}

/** Upload the reference audio for cloning; resolves the file id as the
 *  exact digit string the server sent (int64 — never through a JS number). */
export async function uploadReference(
  fetch: FetchLike,
  host: string,
  key: string,
  bytes: Uint8Array,
  filename: string,
  signal?: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.set("purpose", "voice_clone");
  // A fresh buffer of exactly the bytes: the DOM's BlobPart wants an
  // ArrayBuffer-backed view, and a slice of a shared buffer is not one.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  form.set("file", new Blob([copy.buffer], { type: "audio/wav" }), filename);
  const { text } = await call(fetch, `${host}/v1/files/upload`, {
    method: "POST",
    headers: auth(key),
    body: form,
    signal,
  });
  const m = /"file_id"\s*:\s*"?(\d+)"?/.exec(text);
  if (m === null) throw new MiniMaxError("other", "upload: no file_id");
  return m[1] as string;
}

/** A voice id MiniMax accepts: 8–256 chars, a letter first, letters / digits
 *  / `-` / `_`, not ending in `-` or `_`, unique per account — so a fresh
 *  random tail per clone (a deleted id may or may not be reusable). */
export function makeVoiceId(random: () => string = defaultRandom): string {
  return `herta_${random()}`;
}

function defaultRandom(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 10; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/** Clone a voice from an uploaded reference. No preview text — a preview is
 *  billed like synthesis and the app has nothing to play it on. */
export async function cloneVoice(
  fetch: FetchLike,
  host: string,
  key: string,
  fileId: string,
  voiceId: string,
  signal?: AbortSignal,
): Promise<void> {
  // `file_id` is an int64 on the wire; splice the digits in as a JSON number
  // without ever rounding them through a double.
  const body = JSON.stringify({
    file_id: "__FILE_ID__",
    voice_id: voiceId,
    need_noise_reduction: false, // clean game audio
    need_volume_normalization: true,
    accuracy: 0.7,
  }).replace('"__FILE_ID__"', fileId);
  const { json } = await call(fetch, `${host}/v1/voice_clone`, {
    method: "POST",
    headers: { ...auth(key), "Content-Type": "application/json" },
    body,
    signal,
  });
  if (json.input_sensitive === true) {
    throw new MiniMaxError(
      "sensitive",
      "the reference failed the content check",
    );
  }
}

export interface SynthesizeOptions {
  readonly voiceId: string;
  readonly text: string;
  readonly model?: string;
  readonly sampleRate?: number;
  readonly signal?: AbortSignal;
}

export interface SynthesizedPcm {
  readonly samples: Int16Array;
  readonly sampleRate: number;
  /** MiniMax's billable count for this call (≈ 1.8× the characters). */
  readonly billedChars: number;
}

/** One unit as raw 24 kHz mono PCM — the shape Herta's voiced reveal plays. */
export async function synthesizePcm(
  fetch: FetchLike,
  host: string,
  key: string,
  opts: SynthesizeOptions,
): Promise<SynthesizedPcm> {
  const sampleRate = opts.sampleRate ?? 24000;
  const { json } = await call(fetch, `${host}/v1/t2a_v2`, {
    method: "POST",
    headers: { ...auth(key), "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model ?? MINIMAX_DEFAULT_MODEL,
      text: opts.text,
      voice_setting: { voice_id: opts.voiceId, speed: 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: sampleRate, format: "pcm", channel: 1 },
      language_boost: "Chinese",
      output_format: "hex",
    }),
    signal: opts.signal,
  });
  const data = (json.data ?? {}) as { audio?: unknown };
  if (typeof data.audio !== "string" || data.audio.length === 0) {
    throw new MiniMaxError("other", "no audio in the response");
  }
  const pcm = Buffer.from(data.audio, "hex");
  const samples = new Int16Array(pcm.length >> 1);
  for (let i = 0; i < samples.length; i += 1)
    samples[i] = pcm.readInt16LE(i * 2);
  const extra = (json.extra_info ?? {}) as { usage_characters?: unknown };
  return {
    samples,
    sampleRate,
    billedChars:
      typeof extra.usage_characters === "number" ? extra.usage_characters : 0,
  };
}
