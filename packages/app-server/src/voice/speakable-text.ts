import { stripDisplayUnsafe } from "@herta/core/text-sanitize";

/**
 * Speakable-text policy for Herta's synthesized voice (ADR 0042).
 *
 * Herta's speech blocks are prose with code in them — fenced blocks, inline
 * `identifiers`, shell lines, paths, `@板砖` dispatch tokens, markdown
 * emphasis, the odd `#E-207` — and the TTS frontend (sherpa-onnx's Kokoro
 * zh/en pipeline) will dutifully try to pronounce every one of them. This
 * module decides, deterministically and without a model, what she SAYS
 * versus what she merely SHOWS:
 *
 *   - Fenced ``` blocks and table rows are shown, never spoken (the wave
 *     engine's `scanSpeakable` already treats them as unspoken — same rule).
 *   - Inline code is spoken when it is a NAME (an identifier, a path, a
 *     filename — things she would say out loud: "read file", "parser",
 *     "src echo 点 mjs") and skipped when it is an EXPRESSION or a command
 *     (`PORT ?? 3000`, `node src/echo.mjs hello`) — she talks around code,
 *     she does not read it character by character.
 *   - Markdown scaffolding (emphasis, headers, list markers, links, quotes)
 *     is stripped; the words inside are kept.
 *   - `@板砖` / `@Brick` lose the `@`: the name is spoken, the dispatch
 *     sigil is not.
 *   - Symbols that carry no spoken form (→ = | ~ ^ emoji) become pauses or
 *     vanish; quotes and CJK brackets vanish around their contents.
 *
 * Nothing is ever ADDED in her voice: the transform only deletes, splits or
 * substitutes a pronunciation for a glyph (`.` → 点/dot inside a filename).
 * Putting words in Herta's mouth that she did not write would break D3 as
 * surely as reading `??` aloud breaks it.
 *
 * The companion `segmentSpeechUnits` cuts a GROWING buffer into the units
 * the voiced reveal synthesizes one at a time — sentence-sized, with an
 * eager first cut so the first audio lands early. Both are pure.
 */

export type SpeechLang = "zh" | "en";

/**
 * One synthesis unit: a span of the ORIGINAL text (code-point indices, end
 * exclusive — the reveal emits exactly these characters) plus the text the
 * synthesizer receives, or "" for a silent unit (code, table, nothing
 * pronounceable left).
 */
export interface SpeechUnit {
  readonly start: number;
  readonly end: number;
  readonly speak: string;
}

// ── Unit segmentation ───────────────────────────────────────────────────────

/** Sentence enders that close a unit. The CJK enders (。！？) close
 *  unconditionally; the ASCII ones (. ! ?) close only before whitespace or
 *  end of input, so `0.1.2`, `src/main.ts` and `node x.mjs` are not sentence
 *  breaks — that gate lives in `segmentSpeechUnits`. */
const HARD_END: ReadonlySet<string> = new Set([
  "。",
  "！",
  "？",
  ".",
  "!",
  "?",
]);
/** Clause punctuation a long run may be split at. */
const CLAUSE_END: ReadonlySet<string> = new Set([
  "，",
  "、",
  "；",
  "：",
  ",",
  ";",
  ":",
]);
/** Closers that belong to the unit whose ender they follow (`。”` `？）`). */
const TRAILING_CLOSER: ReadonlySet<string> = new Set([
  "”",
  "’",
  "」",
  "』",
  "）",
  ")",
  "]",
  "］",
  "》",
  '"',
  "'",
]);

/**
 * The FIRST unit of an utterance cuts at the first clause boundary past this
 * many code points, so the opening audio is ready in about a second instead
 * of waiting for a whole sentence: 嗯，/ 行。/ 先说清楚：— the way she
 * actually starts a line.
 */
export const FIRST_UNIT_MIN_CHARS = 6;
/** Past this length a sentence still open splits at its last clause mark. */
export const SOFT_MAX_UNIT_CHARS = 48;
/** Past this length a unit splits unconditionally (Kokoro's 510-token ceiling
 *  is far above it; this bounds per-unit synthesis latency on a slow CPU). */
export const HARD_MAX_UNIT_CHARS = 80;

function isWhitespace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function isFenceLine(line: string): boolean {
  return /^\s*```/.test(line);
}

function isTableLine(line: string): boolean {
  return /^\s*\|/.test(line);
}

/**
 * Cut `chars` (the growing code-point buffer) into CLOSED units, in order.
 * Prefix-stable: once a unit has closed it never changes as more text
 * arrives, so an incremental caller can synthesize units as they close.
 * A unit closes when
 *   - a sentence ender is followed by a character that is not a closer
 *     (so `。”` stays whole) — or by end of input when `finished`;
 *   - a newline ends it (each line is its own unit; blank lines attach to
 *     the previous unit's tail);
 *   - a fenced block closes (the whole block is ONE silent unit), or a table
 *     row ends;
 *   - the run exceeds the soft/hard length bounds (split at a clause mark
 *     when there is one);
 *   - input finishes (the remainder, if any, is the last unit).
 * Trailing whitespace after an ender is absorbed into the unit that ended,
 * so the next unit starts on a real character.
 */
export function segmentSpeechUnits(
  chars: readonly string[],
  finished: boolean,
  lang: SpeechLang = "zh",
): SpeechUnit[] {
  const units: SpeechUnit[] = [];
  const n = chars.length;
  let i = 0;
  const push = (start: number, end: number, silent = false): void => {
    if (end <= start) return;
    const raw = chars.slice(start, end).join("");
    units.push({
      start,
      end,
      speak: silent ? "" : toSpeakableText(raw, lang),
    });
  };
  while (i < n) {
    // Skip leading whitespace between units (it belongs to nobody; the
    // reveal emits it with the unit that follows, via `start`).
    const unitStart = i;
    // Line-shaped units: a fence block or a table row, judged at line start.
    if (i === 0 || chars[i - 1] === "\n") {
      const lineEnd = indexOfLineEnd(chars, i);
      const line = chars.slice(i, lineEnd).join("");
      if (isFenceLine(line)) {
        // Find the closing fence line. Unclosed → closes only when input
        // finishes (the reveal holds, as the fence rule already does).
        let j = lineEnd;
        let closed = false;
        while (j < n) {
          if (chars[j] !== "\n") {
            j += 1;
            continue;
          }
          const nextEnd = indexOfLineEnd(chars, j + 1);
          const next = chars.slice(j + 1, nextEnd).join("");
          if (/^\s*```\s*$/.test(next)) {
            j = nextEnd < n ? nextEnd + 1 : nextEnd; // through its newline
            closed = true;
            break;
          }
          j += 1;
        }
        if (!closed) {
          if (!finished) break;
          j = n;
        }
        push(unitStart, j, true);
        i = j;
        continue;
      }
      if (isTableLine(line)) {
        if (lineEnd >= n && !finished) break;
        const end = lineEnd < n ? lineEnd + 1 : n;
        push(unitStart, end, true);
        i = end;
        continue;
      }
    }
    // Prose: walk to a boundary.
    let j = i;
    let lastClause = -1;
    /** Last word boundary seen — the hard cap's fallback cut point. */
    let lastSpace = -1;
    let cut = -1; // exclusive end of the unit, or -1 while open
    const isFirst = units.length === 0;
    /**
     * Inside an inline `code` span. Punctuation there is CODE, not prose:
     * splitting on it breaks the backtick pair across two units, and each
     * half then reads as literal text — `PORT ?? 3000` became "不过 `PORT?"
     * and "3000` 那个…", which the synthesizer would happily pronounce
     * (voice lab, first run). A span still open at the end of the buffer
     * behaves like an unclosed fence: the unit waits for more input.
     */
    let inCode = false;
    while (j < n) {
      const ch = chars[j] as string;
      if (ch === "`") {
        inCode = !inCode;
        j += 1;
        continue;
      }
      if (ch === "\n") {
        // A newline ends the unit AND any inline span — an unterminated
        // backtick never swallows the rest of the reply.
        inCode = false;
        cut = j + 1;
        break;
      }
      if (inCode) {
        // Still bound by the hard cap, so a pathological unclosed span
        // cannot grow a unit without limit.
        if (j + 1 - i >= HARD_MAX_UNIT_CHARS) {
          cut = lastClause > i ? lastClause : j + 1;
          break;
        }
        j += 1;
        continue;
      }
      if (HARD_END.has(ch)) {
        // EN enders need a following space/newline/end (3.5, v0.1.2 —
        // decimals and versions are not sentence ends). CJK enders never do.
        const cjkEnder = ch === "。" || ch === "！" || ch === "？";
        const after = chars[j + 1];
        const endsHere =
          cjkEnder || isWhitespace(after) || (after === undefined && finished);
        if (endsHere) {
          // Absorb closers, then a look-ahead: we need to SEE the next real
          // character (or end of input) before the unit can close.
          let k = j + 1;
          while (k < n && TRAILING_CLOSER.has(chars[k] as string)) k += 1;
          if (k >= n && !finished) {
            cut = -1;
            j = n; // open — wait for more input
            break;
          }
          cut = k;
          break;
        }
      }
      if (CLAUSE_END.has(ch)) {
        lastClause = j + 1;
        const len = j + 1 - i;
        if (isFirst && len >= FIRST_UNIT_MIN_CHARS) {
          cut = j + 1;
          break;
        }
        if (len >= SOFT_MAX_UNIT_CHARS) {
          cut = j + 1;
          break;
        }
      }
      if (isWhitespace(ch)) lastSpace = j + 1;
      if (j + 1 - i >= HARD_MAX_UNIT_CHARS) {
        // Prefer a clause mark, then a WORD boundary, and only then cut where
        // we stand. The word boundary matters for English, where a long
        // sentence can carry no clause mark at all: cutting at the raw cap
        // split "war room" into "…war" / "room …" and "news?" into "ews?",
        // and each half was synthesized as its own utterance (voice lab).
        cut = lastClause > i ? lastClause : lastSpace > i ? lastSpace : j + 1;
        break;
      }
      j += 1;
    }
    if (cut === -1) {
      if (!finished) break; // unit still open
      cut = n;
    }
    // Absorb trailing whitespace so the next unit starts on a character —
    // but only what is already KNOWN; an open tail waits for input.
    let end = cut;
    while (end < n && isWhitespace(chars[end])) end += 1;
    if (end >= n && !finished && cut < n) {
      // Trailing whitespace reaches the open end: hold until we know what
      // follows (a newline may still be coming).
      break;
    }
    push(unitStart, end);
    i = end;
  }
  return units;
}

function indexOfLineEnd(chars: readonly string[], from: number): number {
  let k = from;
  while (k < chars.length && chars[k] !== "\n") k += 1;
  return k;
}

// ── Speakable transform ─────────────────────────────────────────────────────

/** Leading/whole `〔…〕` hint scaffolding and every stray narrative tag:
 *  never her voice (see @herta/herta block-shape / strip-stray-open-tags). */
const SCAFFOLDING_RE = /〔[^〕]*〕/gu;
const STRAY_TAG_RE = /（\/?(?:我 说|我 想|开拓者 说)）/gu;

/** An inline-code body she would SAY: one name-like token — identifier,
 *  filename, path, dotted or hyphenated, or the `@板砖` dispatch name — no
 *  spaces, no operators. */
const NAME_LIKE_RE = /^@?[\p{L}\p{N}_$.\-/\\:]{1,48}$/u;
/** A bare path/filename outside backticks (`scripts/merge_sort.py`,
 *  `parser.ts`, `src/main.ts`). Requires a separator or a known-looking
 *  extension so ordinary words never match. */
const BARE_PATH_RE =
  /(?<![\p{L}\p{N}_./\\-])(?:[\w.-]+(?:[/\\][\w.-]+)+|[\w-]+\.(?:[a-z]{1,5}))(?![\p{L}\p{N}_./\\-])/gu;
const URL_RE = /\bhttps?:\/\/\S+/giu;
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/gu;
const LINK_RE = /\[([^\]]+)\]\([^)]*\)/gu;
/** Emoji and other symbols, with any trailing variation selector. Written as
 *  an ALTERNATION rather than a character class: U+FE0F is a combining
 *  character, and inside a class it would pair with the preceding member to
 *  form a new character (biome noMisleadingCharacterClass). */
const PICTOGRAPH_RE = /(?:[\p{Extended_Pictographic}\p{So}]️?|️)/gu;

/** Pronounce a name-like token: separators become spaces, the dot before an
 *  extension is read (点 / dot), camelCase splits so espeak gets words. */
function pronounceName(token: string, lang: SpeechLang): string {
  const dot = lang === "zh" ? " 点 " : " dot ";
  // Leading `@` (the `@板砖` dispatch name), `$`, `.` carry no spoken form.
  let t = token.replace(/^[@$.]+/, "");
  // Leading `./` `../` carry no spoken form.
  t = t.replace(/^(?:\.{1,2}[/\\])+/, "");
  t = t.replace(/[/\\:]+/g, " ");
  t = t.replace(/_+/g, " ");
  t = t.replace(/-+/g, " ");
  // `a.b` between word characters → a 点 b; a lone trailing dot vanishes.
  t = t.replace(/(?<=[\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu, dot);
  t = t.replace(/\.+/g, " ");
  // camelCase / PascalCase → camel Case (ASCII only — CJK has no case).
  t = t.replace(/([a-z\d])([A-Z])/g, "$1 $2");
  return t.replace(/\s+/g, " ").trim();
}

/** True when an inline-code body should be spoken (a name) rather than
 *  skipped (an expression / command). */
export function isSpeakableCode(body: string): boolean {
  const b = body.trim();
  if (b.length === 0) return false;
  return NAME_LIKE_RE.test(b);
}

/**
 * The text the synthesizer receives for one unit of Herta's prose, or ""
 * when nothing pronounceable remains. Pure; idempotent on plain prose
 * (ordinary Chinese / English sentences come back unchanged apart from
 * whitespace collapse).
 */
export function toSpeakableText(raw: string, lang: SpeechLang = "zh"): string {
  let t = stripDisplayUnsafe(raw).replace(/\r\n?/g, "\n");
  // Whole-unit non-speech shapes first.
  if (/^\s*```/.test(t) || /^\s*\|/.test(t)) return "";
  t = t.replace(SCAFFOLDING_RE, " ").replace(STRAY_TAG_RE, " ");
  // Images vanish; links keep their text; URLs vanish.
  t = t.replace(IMAGE_RE, " ").replace(LINK_RE, "$1").replace(URL_RE, " ");
  // Inline code: a name is pronounced, an expression is skipped.
  t = t.replace(/`([^`\n]*)`/g, (_m, body: string) =>
    isSpeakableCode(body) ? ` ${pronounceName(body.trim(), lang)} ` : " ",
  );
  // The dispatch sigil is not spoken; the name is.
  t = t.replace(/@(板砖|Brick)/g, "$1");
  // Markdown scaffolding, line by line.
  t = t
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*>\s?/, "")
        .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, ""),
    )
    .join("\n");
  t = t.replace(/\*\*|__|~~/g, "").replace(/\*/g, "");
  // Bare paths / filenames in prose read like names.
  t = t.replace(BARE_PATH_RE, (m) => ` ${pronounceName(m, lang)} `);
  // `#E-207` → E-207 (the hash is layout); lone hashes vanish.
  t = t.replace(/#(?=[\p{L}\p{N}])/gu, "").replace(/#/g, " ");
  // Pauses for arrows; nothing for the rest of the operator set.
  t = t.replace(/[→⇒➜↦]/g, lang === "zh" ? "，" : ", ");
  t = t.replace(/[←⇐]/g, " ");
  t = t.replace(/[=<>|~^&+*$]/g, " ");
  t = t.replace(/\//g, " ");
  // Any backtick that survived the inline-code pass is UNPAIRED (a span the
  // model never closed). Defensive: the segmenter keeps pairs whole, but a
  // stray one must never be pronounced.
  t = t.replace(/`/g, " ");
  // Quotes and CJK brackets vanish around their contents — EXCEPT an
  // apostrophe between letters, which is a contraction and part of the word.
  // Stripping it turned "didn't" into "didnt" and, worse, "I'll" into "Ill"
  // (voice lab, EN transcripts): espeak reads that as the adjective.
  // An apostrophe is kept only BETWEEN two letters; either alternative below
  // matches everywhere else (an opening or closing single quote, a trailing
  // possessive), so those still vanish.
  t = t.replace(/(?<![\p{L}])['’]|['’](?![\p{L}])/gu, "");
  t = t.replace(/[“”‘"「」『』【】《》〈〉]/g, "");
  t = t.replace(PICTOGRAPH_RE, "");
  // Repeated marks collapse; the model reads one pause, not a stutter.
  t = t
    .replace(/…{2,}/g, "…")
    .replace(/\.{3,}/g, "…")
    .replace(/([。！？!?])\1+/g, "$1")
    .replace(/——+/g, "——");
  // Whitespace: newlines become a pause-carrying space; runs collapse.
  t = t.replace(/\s+/g, " ").trim();
  // A unit that lost its opening content keeps no dangling clause mark.
  t = t
    .replace(/^[，、；：,;:\s]+/, "")
    .replace(/\s+([，。！？；：、,.!?;:])/g, "$1");
  // A CJK punctuation mark needs no following space (a substitution — inline
  // code, an arrow → ，— may have introduced one). ASCII punctuation keeps
  // its space so English words stay separated. Cosmetic for the synthesizer,
  // deterministic for the record.
  //
  // The em dash is deliberately NOT in this set: it is used in BOTH scripts,
  // and collapsing after it welded English words together ("room — Did" →
  // "room —Did", voice lab). Chinese writes ——  without spaces anyway, so
  // leaving it alone costs nothing there.
  t = t.replace(/([，。！？；：、…])\s+/g, "$1");
  // Nothing pronounceable → silent (a "……" line, a bracket-only line).
  if (!/[\p{L}\p{N}]/u.test(t)) return "";
  return t;
}
