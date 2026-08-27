import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Content-Security-Policy for the renderer (audit 2026-08-05, BL2).
 *
 * The renderer shipped with no CSP at all. Not exploitable today — there is no
 * `innerHTML`, `eval`, `fetch`, `XHR` or `Worker` anywhere in it, and the only
 * network-shaped API is `new Audio("herta-voice://…")` — but this is the
 * window that holds the IPC bridge, and it renders model-generated text.
 *
 * Injected from the MAIN process via `onHeadersReceived` rather than a `<meta>`
 * tag, for two reasons: dev and packaged need different policies (Vite needs
 * its HMR websocket and eval), and a meta tag lives in the very file an
 * attacker who could replace the renderer would control.
 *
 * NOTE it would not have bounded S2 (the ELECTRON_RENDERER_URL load): that
 * navigates the window to a different origin entirely, which carries its own
 * policy. Different defence, different hole.
 */

/** The inline `<script>` in index.html stamps the theme before first paint, so
 *  a dark launch does not flash the light splash. It cannot become an external
 *  file without reintroducing that flash risk, and it cannot be dropped.
 *
 *  Its hash is computed from the FILE at runtime rather than pasted here: a
 *  hardcoded hash silently stops matching the moment someone edits the script,
 *  and the symptom would be the theme flash coming back — a regression nobody
 *  would connect to a CSP constant. Derived, it self-maintains. */
function inlineScriptHashes(indexHtmlPath: string): string[] {
  let html: string;
  try {
    html = readFileSync(indexHtmlPath, "utf8");
  } catch {
    return [];
  }
  const hashes: string[] = [];
  // Only tags with no src= are inline sources CSP needs a hash for.
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null = re.exec(html);
  while (m !== null) {
    const body = m[1] ?? "";
    if (body.trim().length > 0) {
      hashes.push(
        `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`,
      );
    }
    m = re.exec(html);
  }
  return hashes;
}

export interface CspOptions {
  readonly isPackaged: boolean;
  /** Absolute path to the packaged renderer's index.html (hash source). */
  readonly indexHtmlPath: string;
  /** The dev server origin, when running unpackaged. */
  readonly devOrigin?: string;
}

/**
 * The policy string. Packaged is the strict one; dev relaxes exactly what Vite
 * needs and nothing else.
 */
export function buildCsp(opts: CspOptions): string {
  const scriptSrc = opts.isPackaged
    ? ["'self'", ...inlineScriptHashes(opts.indexHtmlPath)]
    : // Vite injects its client and uses eval for HMR; the dev origin serves
      // the module graph over http.
      ["'self'", "'unsafe-inline'", "'unsafe-eval'", opts.devOrigin ?? ""];

  const connectSrc = opts.isPackaged
    ? // The renderer talks to the main process over IPC, never over the
      // network. The DeepSeek call lives in the MAIN process, so nothing here
      // needs an outbound origin — this is the directive that would stop an
      // injected script exfiltrating a transcript.
      ["'none'"]
    : ["'self'", opts.devOrigin ?? "", "ws:", "wss:"];

  return [
    "default-src 'none'",
    `script-src ${scriptSrc.filter(Boolean).join(" ")}`,
    // React writes inline style ATTRIBUTES (style={{…}}) all over the
    // renderer, and index.html carries an inline <style> for the boot splash.
    // 'unsafe-inline' for styles is therefore load-bearing; it is also the
    // least dangerous of the inline allowances, since style injection here has
    // no sink to reach.
    "style-src 'self' 'unsafe-inline'",
    // Bundled art plus the small assets Vite inlines as data: URIs, and the
    // custom scheme attachment images are served over (ADR 0048) — stored
    // pictures stay on disk instead of riding the record as data: URIs.
    "img-src 'self' data: blob: herta-attachment:",
    // The custom scheme the voice clips are served over.
    "media-src 'self' herta-voice: data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSrc.filter(Boolean).join(" ")}`,
    // No plugins, no framing, no framing OF us, and no <base> rewrite.
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}
