// Punctuation → placeholder ideographs for sherpa's Kokoro frontend
// (ADR 0042 §4b.2). sherpa splits text into "Chinese" and "non-Chinese"
// runs by the CJK range [一-鿿] and renders every run as its own model
// sequence, so a sentence with two commas becomes three short renders,
// each with a short-sequence style row — the bright, noisy sound the owner
// heard, and the largest deviation from the misaki reference (the model
// was trained on whole sentences with "," "." "?" INSIDE the sequence,
// each followed by a space token). Ten ideographs from the end of the CJK
// range, absent from every real text and from the lexicon, stand in for
// the marks; the lexicon (regenerated in the voice repo) maps each one to
// the punctuation TOKEN — plus the space token, through the "␣" alias its
// tokens.txt carries for id 16 — so the run stays Chinese, the sequence
// stays whole, and the tokens are the ones misaki would have produced.
//
// Plain CJS: required by tts-worker.cjs as a sibling (emitted beside it by
// electron.vite.config.ts) and by scripts/voice-lab.mjs.
"use strict";

/** placeholder ideograph → the token symbols its lexicon row carries */
const PLACEHOLDERS = Object.freeze({
  鿠: ", ␣",
  鿡: ". ␣",
  鿢: "? ␣",
  鿣: "! ␣",
  鿤: "; ␣",
  鿥: ": ␣",
  鿦: "…",
  // sentence enders at the very END of a unit: no trailing space (misaki
  // strips it), so the sequence ends on the mark as in training
  鿧: ".",
  鿨: "?",
  鿩: "!",
});

/** full-width marks: always Chinese prose, always substituted */
const FULLWIDTH = Object.freeze({
  "，": "鿠",
  "、": "鿠",
  "。": "鿡",
  "？": "鿢",
  "！": "鿣",
  "；": "鿤",
  "：": "鿥",
  "…": "鿦",
});

/** ASCII marks: substituted only directly after a CJK character, so
 *  `v1.2`, `src.ts` and English clauses keep theirs. */
const ASCII = Object.freeze({
  ",": "鿠",
  ".": "鿡",
  "?": "鿢",
  "!": "鿣",
  ";": "鿤",
  ":": "鿥",
});

/** mid-text ender → its end-of-unit form */
const FINAL = Object.freeze({ 鿡: "鿧", 鿢: "鿨", 鿣: "鿩" });

const FULLWIDTH_RE = /[，、。？！；：…]/g;
const ASCII_AFTER_CJK_RE = /([一-鿿])([,.?!;:])/g;

/** The text sherpa should see for a Chinese unit. */
function toSherpaText(text) {
  let s = String(text)
    .replace(FULLWIDTH_RE, (m) => FULLWIDTH[m])
    .replace(ASCII_AFTER_CJK_RE, (_, c, p) => c + ASCII[p])
    .trimEnd();
  const last = s.slice(-1);
  if (FINAL[last] !== undefined) s = s.slice(0, -1) + FINAL[last];
  return s;
}

/** True when a lexicon-zh.txt carries the placeholder rows (they must be
 *  the FIRST rows: sherpa keeps the first pronunciation of a word). */
function lexiconHasPlaceholders(lexiconText) {
  const head = String(lexiconText).slice(0, 4096);
  return Object.entries(PLACEHOLDERS).every(([ch, syms]) =>
    head.includes(`${ch} ${syms}`),
  );
}

module.exports = { PLACEHOLDERS, toSherpaText, lexiconHasPlaceholders };
