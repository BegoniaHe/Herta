/**
 * One definition of "this file is not text".
 *
 * Extracted from `show_excerpt` (ADR 0027) so the attachment ingest (ADR 0033)
 * decides it the same way rather than growing a second, subtly different rule.
 * That matters more than the six lines suggest: the tools reject a binary and
 * the ingest reports one, so if the two disagreed a file could be accepted at
 * the door and then refused by every tool that tried to read it — the user
 * would see an attachment in the record that Herta could never open.
 *
 * A NUL byte in the first 4KB. Crude, and deliberately so: it is the same
 * heuristic git uses, it never false-positives on UTF-8 text (NUL is not a
 * legal UTF-8 continuation byte), and the cost of a false negative is a
 * garbled excerpt.
 *
 * What it is NOT is a guarantee that the bytes are UTF-8 — a GBK / Big5 /
 * Shift-JIS source file sails through it. See `decodeUtf8` below for why that
 * distinction turned out to be load-bearing.
 */
export const SNIFF_BYTES = 4096;

export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, Math.min(SNIFF_BYTES, buf.length)).includes(0);
}

/**
 * Decode file bytes as UTF-8, and say whether that was FAITHFUL.
 *
 * `buf.toString("utf-8")` never fails: every byte it cannot interpret becomes
 * U+FFFD. For a reader that only ever costs a garbled excerpt. For an editor
 * it is data loss, because the write-back path re-encodes the decoded STRING
 * over the whole file — so a hunk touching one ASCII line in a GBK-encoded
 * source silently replaced every Chinese byte in the file, including regions
 * the patch never went near, with replacement characters. Unrecoverable, in
 * the user's own repository, and invisible until someone opened the file
 * (codex study 2026-08-24; reproduced before this guard was written).
 *
 * `lossy` is exact rather than heuristic: a strict decoder either accepts the
 * bytes or it does not. Callers that only READ may use the text and say so;
 * callers that WRITE must refuse.
 */
export function decodeUtf8(buf: Buffer): { text: string; lossy: boolean } {
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(buf),
      lossy: false,
    };
  } catch {
    return { text: buf.toString("utf-8"), lossy: true };
  }
}
