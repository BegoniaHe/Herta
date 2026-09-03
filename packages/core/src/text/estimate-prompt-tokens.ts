/**
 * CJK-aware prompt-token estimator. Every non-ASCII codepoint counts
 * ~1 token/char; ASCII runs count ÷4. Promoted from the actor's recap
 * subsystem (session-recap.ts, L4 non-ASCII floor fix) to core for
 * ADR 0025 slice 2 so the backend's context budget uses the same
 * arithmetic as the actor's compaction thresholds.
 *
 * History of the calibration (from the recap fix): originally only the
 * BMP CJK ranges got the 1-token treatment, and Hangul/Cyrillic/Arabic/
 * emoji/CJK-Ext-B fell into the ÷4 ASCII run — an up-to-4× UNDERcount,
 * the dangerous direction for a threshold that decides when trimming
 * must engage (the real prompt could blow past the model window while
 * the estimate still read under high-water). Charging every non-ASCII
 * codepoint 1 is slightly conservative for scripts DeepSeek tokenizes
 * multi-char (Latin-adjacent diacritics) and slightly generous for
 * scripts at >1 token/char (some emoji, Ext-B) — but the error is
 * bounded and mostly in the safe direction.
 *
 * An index loop over UTF-16 code units (2026-09-03), not `for…of`: the
 * string iterator allocated a one-character string per code point, and
 * the backend budget runs this over its whole transcript every tool
 * call. A surrogate PAIR is one code point and counts once, exactly as
 * the iterator form did.
 */
export function estimatePromptTokens(text: string): number {
  let tokens = 0;
  let asciiRun = 0;
  const n = text.length;
  for (let i = 0; i < n; i += 1) {
    const cu = text.charCodeAt(i);
    if (cu > 0x7f) {
      tokens += Math.ceil(asciiRun / 4);
      asciiRun = 0;
      tokens += 1;
      // A high surrogate's low half is the same code point — skip it.
      if (cu >= 0xd800 && cu <= 0xdbff && i + 1 < n) {
        const lo = text.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) i += 1;
      }
    } else {
      asciiRun += 1;
    }
  }
  return tokens + Math.ceil(asciiRun / 4);
}
