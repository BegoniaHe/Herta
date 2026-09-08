import { describe, expect, it } from "vitest";
import type { FetchLike } from "./minimax-api.js";
import {
  createMiniMaxVoiceService,
  type MiniMaxVoiceRecord,
  type MiniMaxVoiceState,
} from "./minimax-voice.js";

const ok = { base_resp: { status_code: 0, status_msg: "success" } };

/** A fake platform pair: the first host rejects the key, the second takes
 *  the upload and the clone. */
function platform(opts: { sensitive?: boolean; uploadFails?: boolean } = {}) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const reply = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status });
    if (url.startsWith("https://api.minimax.io/")) {
      return reply({
        base_resp: { status_code: 2049, status_msg: "invalid api key" },
      });
    }
    if (url.endsWith("/v1/get_voice")) {
      return reply({
        base_resp: { status_code: 2013, status_msg: "invalid params" },
      });
    }
    if (url.endsWith("/v1/files/upload")) {
      if (opts.uploadFails === true) {
        return reply({
          base_resp: { status_code: 1000, status_msg: "unknown error" },
        });
      }
      return reply({ file: { file_id: 439506357502365, bytes: 5 }, ...ok });
    }
    if (url.endsWith("/v1/voice_clone")) {
      return reply({ ...ok, input_sensitive: opts.sensitive === true });
    }
    return reply({}, 404);
  };
  return { fetch, calls };
}

function service(
  fetch: FetchLike,
  over: {
    key?: string | null;
    reference?: Uint8Array | null;
    initial?: MiniMaxVoiceRecord | null;
  } = {},
) {
  const saved: (MiniMaxVoiceRecord | null)[] = [];
  const changes: MiniMaxVoiceState[] = [];
  const svc = createMiniMaxVoiceService({
    fetch,
    key: () => (over.key === undefined ? "k" : over.key),
    readReference: async () =>
      over.reference === undefined
        ? new Uint8Array([1, 2, 3, 4, 5])
        : over.reference,
    initial: over.initial ?? null,
    save: async (r) => {
      saved.push(r);
    },
    onChange: (s) => changes.push(s),
    log: () => undefined,
    now: () => new Date("2026-09-08T10:00:00.000Z"),
    random: () => "abc123def4",
    usedStampEveryMs: 0,
  });
  return { svc, saved, changes };
}

describe("createMiniMaxVoiceService", () => {
  it("prepare: probes the platform, uploads, clones, persists — absent → preparing → ready", async () => {
    const p = platform();
    const { svc, saved, changes } = service(p.fetch);
    expect(svc.state()).toEqual({ phase: "absent" });
    expect(svc.voice()).toBeNull();
    const end = await svc.prepare();
    expect(end).toEqual({
      phase: "ready",
      voiceId: "herta_abc123def4",
      host: "https://api.minimaxi.com",
      clonedAt: "2026-09-08T10:00:00.000Z",
    });
    expect(changes.map((c) => c.phase)).toEqual(["preparing", "ready"]);
    expect(saved).toEqual([
      {
        voiceId: "herta_abc123def4",
        host: "https://api.minimaxi.com",
        clonedAt: "2026-09-08T10:00:00.000Z",
      },
    ]);
    expect(svc.voice()).toEqual({
      voiceId: "herta_abc123def4",
      host: "https://api.minimaxi.com",
    });
    // The wrong platform was tried first and skipped.
    expect(p.calls[0]).toBe("https://api.minimax.io/v1/get_voice");
    expect(p.calls[1]).toBe("https://api.minimaxi.com/v1/get_voice");
    // A second prepare on a ready voice does nothing.
    const again = await svc.prepare();
    expect(again.phase).toBe("ready");
    expect(p.calls).toHaveLength(4);
  });

  it("names the failure: no key, no reference, a rejected reference, an upload error", async () => {
    const noKey = service(platform().fetch, { key: null });
    expect((await noKey.svc.prepare()).error).toBe("no_key");
    const noRef = service(platform().fetch, { reference: null });
    expect((await noRef.svc.prepare()).error).toBe("reference");
    const sensitive = service(platform({ sensitive: true }).fetch);
    expect((await sensitive.svc.prepare()).error).toBe("sensitive");
    const upload = service(platform({ uploadFails: true }).fetch);
    const s = await upload.svc.prepare();
    expect(s.phase).toBe("failed");
    expect(s.error).toBe("other");
    expect(upload.svc.state().phase).toBe("failed");
  });

  it("starts ready from a persisted record; reset forgets it", async () => {
    const initial = {
      voiceId: "herta_old",
      host: "https://api.minimaxi.com",
      clonedAt: "2026-09-01T00:00:00.000Z",
    };
    const { svc, saved } = service(platform().fetch, { initial });
    expect(svc.state().phase).toBe("ready");
    const s = await svc.reset();
    expect(s).toEqual({ phase: "absent" });
    expect(saved).toEqual([null]);
    expect(svc.voice()).toBeNull();
  });

  it("markMissing forgets the voice and re-clones once, automatically", async () => {
    const p = platform();
    const initial = {
      voiceId: "herta_old",
      host: "https://api.minimaxi.com",
      clonedAt: "2026-09-01T00:00:00.000Z",
    };
    const { svc, changes } = service(p.fetch, { initial });
    svc.markMissing("someone-else"); // not ours: ignored
    expect(svc.state().phase).toBe("ready");
    svc.markMissing("herta_old");
    // Let the persist + re-clone run.
    for (let i = 0; i < 20 && svc.state().phase !== "ready"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(svc.state()).toMatchObject({
      phase: "ready",
      voiceId: "herta_abc123def4",
    });
    expect(changes.map((c) => c.phase)).toEqual([
      "absent",
      "preparing",
      "ready",
    ]);
  });

  it("stampUsed persists lastUsedAt, throttled", async () => {
    const initial = {
      voiceId: "herta_old",
      host: "https://api.minimaxi.com",
      clonedAt: "2026-09-01T00:00:00.000Z",
    };
    const { svc, saved } = service(platform().fetch, { initial });
    svc.stampUsed();
    await new Promise((r) => setTimeout(r, 0));
    expect(saved).toEqual([
      { ...initial, lastUsedAt: "2026-09-08T10:00:00.000Z" },
    ]);
  });

  it("concurrent prepare calls share one run", async () => {
    const p = platform();
    const { svc } = service(p.fetch);
    const [a, b] = await Promise.all([svc.prepare(), svc.prepare()]);
    expect(a.phase).toBe("ready");
    expect(b.phase).toBe("ready");
    expect(p.calls.filter((u) => u.endsWith("/v1/voice_clone"))).toHaveLength(
      1,
    );
  });
});
