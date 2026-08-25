export interface Hunk {
  search: string;
  replace: string;
}

export type ParsePatchResult =
  | { ok: true; hunks: Hunk[] }
  | { ok: false; code: "parse_failed"; message: string };

export type ValidateResult =
  | { ok: true }
  | {
      ok: false;
      code: "hunk_not_found" | "hunk_ambiguous" | "hunk_overlap";
      message: string;
    };

export function parsePatch(input: unknown): ParsePatchResult {
  if (!Array.isArray(input)) {
    return {
      ok: false,
      code: "parse_failed",
      message: "hunks must be an array",
    };
  }
  if (input.length === 0) {
    return {
      ok: false,
      code: "parse_failed",
      message: "hunks must be non-empty",
    };
  }
  const hunks: Hunk[] = [];
  for (let i = 0; i < input.length; i++) {
    const h = input[i] as unknown;
    if (typeof h !== "object" || h === null) {
      return {
        ok: false,
        code: "parse_failed",
        message: `hunk[${i}] must be an object`,
      };
    }
    const rec = h as Record<string, unknown>;
    if (typeof rec.search !== "string") {
      return {
        ok: false,
        code: "parse_failed",
        message: `hunk[${i}].search must be a string`,
      };
    }
    if (typeof rec.replace !== "string") {
      return {
        ok: false,
        code: "parse_failed",
        message: `hunk[${i}].replace must be a string`,
      };
    }
    if (rec.search.length === 0) {
      return {
        ok: false,
        code: "parse_failed",
        message: `hunk[${i}].search must be non-empty`,
      };
    }
    hunks.push({ search: rec.search, replace: rec.replace });
  }
  return { ok: true, hunks };
}

interface ApplyTrace {
  hunkIndex: number;
  postStart: number;
  postEnd: number;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const found = haystack.indexOf(needle, idx);
    if (found < 0) return count;
    count += 1;
    idx = found + needle.length;
  }
}

export function validateHunks(
  content: string,
  hunks: ReadonlyArray<Hunk>,
): ValidateResult {
  let current = content;
  const replacementRanges: ApplyTrace[] = [];
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i] as Hunk;
    const occurrences = countOccurrences(current, h.search);
    if (occurrences === 0) {
      return {
        ok: false,
        code: "hunk_not_found",
        message: `hunk[${i}] search not found`,
      };
    }
    if (occurrences > 1) {
      return {
        ok: false,
        code: "hunk_ambiguous",
        message: `hunk[${i}] search matches ${occurrences} places; need 1`,
      };
    }
    const matchStart = current.indexOf(h.search);
    const matchEnd = matchStart + h.search.length;
    for (const r of replacementRanges) {
      const overlaps = !(matchEnd <= r.postStart || matchStart >= r.postEnd);
      if (overlaps) {
        return {
          ok: false,
          code: "hunk_overlap",
          message: `hunk[${i}] match overlaps hunk[${r.hunkIndex}] replacement region`,
        };
      }
    }
    const newPostStart = matchStart;
    const newPostEnd = matchStart + h.replace.length;
    const delta = h.replace.length - h.search.length;
    for (const r of replacementRanges) {
      if (r.postStart >= matchEnd) {
        r.postStart += delta;
        r.postEnd += delta;
      }
    }
    replacementRanges.push({
      hunkIndex: i,
      postStart: newPostStart,
      postEnd: newPostEnd,
    });
    current =
      current.slice(0, matchStart) + h.replace + current.slice(matchEnd);
  }
  return { ok: true };
}

export function applyHunks(
  content: string,
  hunks: ReadonlyArray<Hunk>,
): string {
  let current = content;
  for (const h of hunks) {
    const idx = current.indexOf(h.search);
    if (idx < 0) {
      throw new Error(
        "applyHunks invariant violated: hunk search missing — call validateHunks first",
      );
    }
    current =
      current.slice(0, idx) + h.replace + current.slice(idx + h.search.length);
  }
  return current;
}

export function computeUnifiedDiff(
  before: string,
  after: string,
  label: string,
): string {
  if (before === after) return "";
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const beforeNoTrail = before.endsWith("\n")
    ? beforeLines.slice(0, -1)
    : beforeLines;
  const afterNoTrail = after.endsWith("\n")
    ? afterLines.slice(0, -1)
    : afterLines;
  const body = diffBody(beforeNoTrail, afterNoTrail);
  const noNewlineBefore =
    before.length === 0 || before.endsWith("\n")
      ? ""
      : "\n\\ No newline at end of file";
  const noNewlineAfter = after.endsWith("\n")
    ? ""
    : "\n\\ No newline at end of file";
  const sourceHeader = before.length === 0 ? "--- /dev/null" : `--- a/${label}`;
  return [
    sourceHeader,
    `+++ b/${label}`,
    body + noNewlineBefore + noNewlineAfter,
  ].join("\n");
}

interface DiffOp {
  kind: "ctx" | "del" | "add";
  line: string;
}

/**
 * Cells of the LCS table this is willing to allocate.
 *
 * The table is `(n+1) x (m+1)` numbers, so the cost is QUADRATIC in file
 * length, and this runs inside the permission RULE — on the Electron main
 * process, while the user waits for the approval card the call was supposed to
 * produce. Measured on 2026-08-25: 4,000 lines is 123 MB and 383 ms; 20,000 is
 * ~3 GB and 30,000 is ~6.7 GB, i.e. the app is gone, and the last thing the
 * user sees is it dying instead of the diff they were about to judge.
 *
 * 2M cells is ~16 MB and a couple of hundred milliseconds — the point where a
 * preview stops being worth a main-process stall.
 */
const MAX_LCS_CELLS = 2_000_000;
/** Unchanged lines kept either side of the changed span once trimming starts. */
const TRIM_CONTEXT = 3;

/**
 * The diff body, computed within a bounded budget.
 *
 * Under the budget this is exactly the whole-file walk it has always been, so
 * ordinary edits are byte-identical to before. Over it, the identical head and
 * tail are peeled first — a one-line replacement in a 30,000-line file has a
 * tiny middle, which is the case that used to be fatal — and only the middle is
 * walked. If even the middle is too large, the span is emitted as one complete
 * replacement.
 *
 * The coarse form is deliberately NOT truncated: `countDiffLines` derives the
 * report's `+N -M` from this text, so dropping lines here would fabricate the
 * counts. Its size is linear in the file, which is survivable; the quadratic
 * allocation was the failure.
 */
function diffBody(a: string[], b: string[]): string {
  if (a.length * b.length <= MAX_LCS_CELLS) {
    return render(diffOps(a, b, longestCommonSubsequence(a, b)));
  }

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const headKeep = Math.min(TRIM_CONTEXT, prefix);
  const tailKeep = Math.min(TRIM_CONTEXT, suffix);

  const parts: string[] = [];
  // A `\ ` line is already part of this format ("\ No newline at end of file"),
  // so consumers tolerate it and `countDiffLines` ignores it.
  if (prefix - headKeep > 0) {
    parts.push(`\\ ${prefix - headKeep} unchanged lines omitted`);
  }
  for (const line of a.slice(prefix - headKeep, prefix)) parts.push(` ${line}`);

  if (midA.length * midB.length <= MAX_LCS_CELLS) {
    parts.push(
      render(diffOps(midA, midB, longestCommonSubsequence(midA, midB))),
    );
  } else {
    parts.push(
      "\\ changed span too large to align line by line — shown as one replacement",
    );
    for (const line of midA) parts.push(`-${line}`);
    for (const line of midB) parts.push(`+${line}`);
  }

  for (const line of a.slice(a.length - suffix, a.length - suffix + tailKeep)) {
    parts.push(` ${line}`);
  }
  if (suffix - tailKeep > 0) {
    parts.push(`\\ ${suffix - tailKeep} unchanged lines omitted`);
  }
  return parts.filter((s) => s.length > 0).join("\n");
}

function render(ops: readonly DiffOp[]): string {
  return ops
    .map((op) => {
      if (op.kind === "ctx") return ` ${op.line}`;
      if (op.kind === "del") return `-${op.line}`;
      return `+${op.line}`;
    })
    .join("\n");
}

function longestCommonSubsequence(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const dpRow = dp[i] as number[];
      const dpPrev = dp[i - 1] as number[];
      if (a[i - 1] === b[j - 1]) {
        dpRow[j] = (dpPrev[j - 1] as number) + 1;
      } else {
        const up = dpPrev[j] as number;
        const left = dpRow[j - 1] as number;
        dpRow[j] = up >= left ? up : left;
      }
    }
  }
  return dp;
}

function diffOps(a: string[], b: string[], dp: number[][]): DiffOp[] {
  const ops: DiffOp[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ kind: "ctx", line: a[i - 1] as string });
      i -= 1;
      j -= 1;
      continue;
    }
    const up = ((dp[i - 1] as number[])[j] as number) ?? 0;
    const left = ((dp[i] as number[])[j - 1] as number) ?? 0;
    if (up >= left) {
      ops.push({ kind: "del", line: a[i - 1] as string });
      i -= 1;
    } else {
      ops.push({ kind: "add", line: b[j - 1] as string });
      j -= 1;
    }
  }
  while (i > 0) {
    ops.push({ kind: "del", line: a[i - 1] as string });
    i -= 1;
  }
  while (j > 0) {
    ops.push({ kind: "add", line: b[j - 1] as string });
    j -= 1;
  }
  return ops.reverse();
}
