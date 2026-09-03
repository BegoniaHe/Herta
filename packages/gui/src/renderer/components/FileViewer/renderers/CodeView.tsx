import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../../i18n/LocaleProvider.js";
import type { ViewerAnchor } from "../file-viewer-context.js";
import { setSanitizedHtml } from "./dom-html.js";

/**
 * The ADR 0050 text layout — gutter + `<pre>` over one relative box with
 * the cite-anchor band — now with highlight.js tokens when the kind names
 * a language (ADR 0054 §4). The highlighter is a lazy chunk: a plain text
 * file paints synchronously as before, and a code file paints plain first
 * and colors in when the chunk lands (a local read answers in single-digit
 * milliseconds; the chunk once).
 */

/** Rendered-line cap: a 1.5MB log is ~30k lines and 30k gutter rows of DOM
 *  helps nobody — the panel shows the head and says the file continues. */
export const MAX_RENDER_LINES = 8_000;

/** Fallback line height when the computed style is unreadable (jsdom) —
 *  the CSS pins 12px × 1.6. */
const FALLBACK_LINE_H = 19.2;

type Highlighter = typeof import("./highlight.js");
let highlighterPromise: Promise<Highlighter> | null = null;
function loadHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= import("./highlight.js");
  return highlighterPromise;
}

export function CodeView({
  content,
  truncated,
  language,
  anchor,
}: {
  readonly content: string;
  readonly truncated: boolean;
  /** highlight.js language id; undefined = plain text. */
  readonly language?: string | undefined;
  readonly anchor?: ViewerAnchor | undefined;
}): JSX.Element {
  const t = useT();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLPreElement | null>(null);
  const [band, setBand] = useState<{
    readonly top: number;
    readonly height: number;
  } | null>(null);

  const allLines = content.split("\n");
  const lines = allLines.slice(0, MAX_RENDER_LINES);
  const elided = allLines.length - lines.length;
  const lineCount = lines.length;
  const shown = lines.join("\n");
  const gutter = lines.map((_, i) => i + 1).join("\n");

  // Plain text first (synchronous, so the first paint and the anchor
  // metrics never wait on a chunk); tokens replace it when the highlighter
  // answers for THIS content — a stale answer for a previous file is
  // dropped.
  useLayoutEffect(() => {
    const pre = textRef.current;
    if (pre !== null) pre.textContent = shown;
  }, [shown]);
  useEffect(() => {
    if (language === undefined) return;
    let alive = true;
    void loadHighlighter().then(
      (h) => {
        if (!alive) return;
        const html = h.highlightToHtml(shown, language);
        const pre = textRef.current;
        if (html !== null && pre !== null) setSanitizedHtml(pre, html);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [shown, language]);

  // Cite anchor (ADR 0050 v1.5): a highlight band positioned by line
  // metrics, and a scroll that puts the cited lines a third of the way
  // down. Layout effect so the first paint already shows the band.
  useLayoutEffect(() => {
    if (anchor === undefined || anchor.from > lineCount) {
      setBand(null);
      return;
    }
    const scroller = scrollerRef.current;
    const text = textRef.current;
    if (scroller === null || text === null) return;
    const cs = getComputedStyle(text);
    const lh = Number.parseFloat(cs.lineHeight) || FALLBACK_LINE_H;
    const padTop = Number.parseFloat(cs.paddingTop) || 0;
    const from = Math.max(1, anchor.from);
    const to = Math.min(Math.max(anchor.to, from), lineCount);
    const top = padTop + (from - 1) * lh;
    setBand({ top, height: (to - from + 1) * lh });
    scroller.scrollTop = Math.max(0, top - scroller.clientHeight * 0.3);
  }, [anchor, lineCount]);

  return (
    <div className="file-viewer__body">
      <div ref={scrollerRef} className="file-viewer__code">
        <div className="file-viewer__code-inner">
          {band !== null && (
            <div
              className="file-viewer__anchor"
              style={{ top: band.top, height: band.height }}
              aria-hidden="true"
            />
          )}
          <pre className="file-viewer__gutter" aria-hidden="true">
            {gutter}
          </pre>
          <pre ref={textRef} className="file-viewer__text" />
        </div>
      </div>
      {(truncated || elided > 0) && (
        <p className="file-viewer__notice">{t("viewer.truncatedNote")}</p>
      )}
    </div>
  );
}
