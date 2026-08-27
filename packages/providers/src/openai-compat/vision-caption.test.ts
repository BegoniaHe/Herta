import { describe, expect, it } from "vitest";
import { ProviderError } from "../errors.js";
import { visionCaptioner } from "./vision-caption.js";

const DATA_URI = "data:image/png;base64,iVBORw0KGgo=";

function stubFetch(payload: unknown, status = 200) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const ok = (content: string, finish = "stop") => ({
  choices: [{ message: { role: "assistant", content }, finish_reason: finish }],
});

const captioner = (fetchImpl: typeof fetch, maxTokens?: number) =>
  visionCaptioner({
    baseUrl: "https://api.example.com",
    apiKey: "k",
    model: "vision-model",
    fetchImpl,
    maxRetries: 0,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  });

const req = {
  system: "describe",
  user: "Describe this image.",
  imageDataUri: DATA_URI,
};

describe("visionCaptioner", () => {
  it("sends the image as a content part on a USER message", async () => {
    // The API accepts images in user messages only; a caption request that
    // put the picture anywhere else would 400 at runtime, not at build.
    const { fetchImpl, calls } = stubFetch(ok("A red square."));
    const text = await captioner(fetchImpl)(req, AbortSignal.timeout(5000));

    expect(text).toBe("A red square.");
    expect(calls[0]?.url).toBe("https://api.example.com/chat/completions");
    expect(calls[0]?.body).toMatchObject({
      model: "vision-model",
      messages: [
        { role: "system", content: "describe" },
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image." },
            { type: "image_url", image_url: { url: DATA_URI } },
          ],
        },
      ],
    });
  });

  it("does not stream — one request, one JSON answer", async () => {
    const { fetchImpl, calls } = stubFetch(ok("x"));
    await captioner(fetchImpl)(req, AbortSignal.timeout(5000));
    expect(calls[0]?.body).not.toHaveProperty("stream", true);
    expect(calls).toHaveLength(1);
  });

  it("defaults to a budget large enough to survive the reasoning chain", async () => {
    // The vision model reasons before answering (probe 2026-08-27): a small
    // budget is consumed entirely by reasoning and comes back with EMPTY
    // content and finish_reason "length" — a silent empty caption. The
    // default exists to keep that from being the normal case.
    const { fetchImpl, calls } = stubFetch(ok("x"));
    await captioner(fetchImpl)(req, AbortSignal.timeout(5000));
    expect(calls[0]?.body.max_tokens).toBe(1024);
  });

  it("treats an empty completion as a failure, never as a caption", async () => {
    const { fetchImpl } = stubFetch(ok("", "length"));
    await expect(
      captioner(fetchImpl)(req, AbortSignal.timeout(5000)),
    ).rejects.toThrow(ProviderError);
  });

  it("names the reasoning-starved case in its message", async () => {
    const { fetchImpl } = stubFetch(ok("   ", "length"));
    await expect(
      captioner(fetchImpl, 32)(req, AbortSignal.timeout(5000)),
    ).rejects.toThrow(/budget consumed by reasoning/);
  });

  it("rejects a whitespace-only caption", async () => {
    const { fetchImpl } = stubFetch(ok("  \n  "));
    await expect(
      captioner(fetchImpl)(req, AbortSignal.timeout(5000)),
    ).rejects.toThrow(ProviderError);
  });

  it("rejects a malformed body rather than returning junk", async () => {
    const { fetchImpl } = stubFetch({ choices: [{ message: {} }] });
    await expect(
      captioner(fetchImpl)(req, AbortSignal.timeout(5000)),
    ).rejects.toThrow(ProviderError);
  });

  it("surfaces an HTTP failure as a ProviderError", async () => {
    // "This model does not support image" is a 400 the caller must degrade
    // on, not a caption.
    const { fetchImpl } = stubFetch(
      { error: { message: "This model does not support image" } },
      400,
    );
    await expect(
      captioner(fetchImpl)(req, AbortSignal.timeout(5000)),
    ).rejects.toThrow(ProviderError);
  });

  it("trims the caption it returns", async () => {
    const { fetchImpl } = stubFetch(ok("  A cat.\n"));
    await expect(
      captioner(fetchImpl)(req, AbortSignal.timeout(5000)),
    ).resolves.toBe("A cat.");
  });
});
