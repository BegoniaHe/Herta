import { stripDisplayUnsafe } from "@herta/core/text-sanitize";
import { memo, type RefObject } from "react";
import { useT } from "../../i18n/LocaleProvider.js";
import { renderBanzhuanText } from "../../lib/banzhuan-text.js";
import { type Segment, segmentSpeech } from "../../lib/segment-speech.js";
import { BubbleTime } from "./BubbleTime.js";

export interface HertaBubbleProps {
  readonly text: string;
  /** ISO send time (the block's stamped `at`); the adaptive label is derived
   *  in the BubbleTime leaf, off the shared coarse clock. Omitted for
   *  pre-timestamp blocks → the line is hidden rather than showing a
   *  fabricated time. */
  readonly at?: string;
  /** Conversation language for the 板砖→Brick display alias (default "zh"). */
  readonly lang?: "zh" | "en";
}

/**
 * One segment's body, shared by the committed stack (below) and the live
 * StreamingReply stack. Prose renders inside the speech bubble through the
 * mention/inline-code tokenizer. A fenced-code segment renders OUTSIDE the
 * bubble chrome (user feedback 2026-07-06: code is not speech) — a bare
 * monospace card in the flow, deliberately plain beyond that (no
 * highlighting, no copy affordance: the record is the prompt, and rewarding
 * pasted code would raise its frequency; heavy content belongs in the 板砖
 * evidence lane). Slice 5 Q1.
 *
 * `innerRef` attaches to the outer element of either variant (the rise
 * clone measures it); `caret` renders the composing caret inside the body.
 *
 * memo: the live stack re-renders once per reveal frame, and the
 * incremental segmenter keeps FROZEN segments identity-stable across
 * frames (perf 2026-08-25) — so completed rows bail here and only the
 * growing tail re-tokenizes. Props are otherwise primitives + stable refs.
 */
export const SegmentBody = memo(function SegmentBody(props: {
  readonly seg: Segment | null;
  readonly innerRef?: RefObject<HTMLDivElement>;
  readonly caret?: boolean;
  /** Conversation language, threaded for the 板砖→Brick display alias. Default
   *  "zh" keeps bubbles rendered in isolation (tests) byte-identical. */
  readonly lang?: "zh" | "en";
}): JSX.Element {
  const t = useT();
  const lang = props.lang ?? "zh";
  if (props.seg?.kind === "code") {
    return (
      <div ref={props.innerRef} className="code-standalone">
        {/* Slim header with the fence's lang tag as a slate chip (falls back
            to a localized "code" — the tag itself is canonical fence text,
            the fallback is chrome) — lifts the card from "bare pre" to the
            app's evidence-card language without rewarding the content itself
            (still no highlighting, no copy affordance). */}
        <div className="code-card__head">
          <span className="code-card__lang">
            {props.seg.lang ?? t("workspace.codeChip")}
          </span>
        </div>
        <pre className="code-block">{props.seg.text}</pre>
        {props.caret === true && (
          <span className="streaming-caret" aria-hidden="true" />
        )}
      </div>
    );
  }
  return (
    <div ref={props.innerRef} className="message-bubble herta-bubble">
      <div className="message-text">
        {props.seg !== null &&
          renderBanzhuanText(props.seg.text, "bubble", lang)}
        {props.caret === true && (
          <span className="streaming-caret" aria-hidden="true" />
        )}
      </div>
    </div>
  );
});

/**
 * Herta's finalized reply, rendered as a BUBBLE STACK (slice 5 Q2): the one
 * committed `herta` record block splits on blank-line paragraphs and ```
 * fences into stacked rows — pure presentation over an UNCHANGED record
 * (D7). One utterance keeps ONE action row: the timestamp renders once,
 * under the last row of the stack. A single-paragraph reply produces
 * byte-identical DOM to the pre-stack renderer.
 *
 * memo: props are primitives, and Conversation re-renders per streaming
 * delta — without the bail-out every historical bubble re-segments and
 * re-tokenizes on every delta of an unrelated reply.
 */
export const HertaBubble = memo(function HertaBubble(
  props: HertaBubbleProps,
): JSX.Element | null {
  // stripDisplayUnsafe: render-side scrub for bidi/control chars — covers
  // disk-loaded legacy blocks the commit-side sanitizer (slice 2) never saw.
  // Identity for normal text.
  const segments = segmentSpeech(stripDisplayUnsafe(props.text));
  if (segments.length === 0) return null;
  return (
    <>
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: stable positional split of one immutable string
            key={i}
            className={`message-row herta-row${isLast ? "" : " is-stack-mid"}`}
          >
            <SegmentBody seg={seg} lang={props.lang} />
            {/* Hover-revealed action row below the bubble — once per
                utterance, on the stack tail (Herta turns carry only the
                timestamp; rewind is a user-turn affordance). */}
            {isLast && props.at !== undefined && (
              <div className="message-actions">
                <BubbleTime at={props.at} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
});
