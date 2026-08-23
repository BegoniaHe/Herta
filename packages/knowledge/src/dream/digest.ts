import type { SystemBlock, TerminalRecordBlock } from "@herta/core";

/**
 * Which system blocks belong in a dream episode's evidence spine — and
 * which are live-work chrome that would only hand the worthiness gate
 * noise it then has to reject (consumer audit 2026-07-23).
 *
 * Skipped, by digest kind:
 *  - "bg"   — background-command lifecycle rows: transient run state,
 *             not an outcome.
 *  - "todo" — the plan layout block: working state (same rationale as
 *             the live compaction's Planning/todo skip).
 *  - "skip" — patch previews, i.e. the FULL diff body. The Writing op
 *             row and the done-marker already carry the outcome; a
 *             dream prompt has no use for a hundred-line diff.
 *             Records persisted before the digest field exists are
 *             matched by body prefix instead.
 *
 * Everything else — op rows, test results, tool failures, markers,
 * plain text — returns its body verbatim: that is what actually
 * happened, which is exactly what the dream should ground in.
 *
 * Also used by `selectEpisodes` so the char-floor eligibility counts
 * only text the digest would actually contain.
 */
export function dreamRelevantSystemBody(b: SystemBlock): string | null {
  const kind = b.digest?.kind;
  if (kind === "bg" || kind === "todo" || kind === "skip") return null;
  if (b.digest === undefined && b.body.startsWith("patch preview")) return null;
  return b.body;
}

/**
 * Whether a block's `evidenceDetail` belongs in the episode alongside its body.
 *
 * The body/evidence split is NOT the same question as the block-level skip
 * above: a block can be worth dreaming while its detail is not. Attachments
 * (ADR 0033) are the case that forced this apart. Their `evidenceDetail` holds
 * the head of a document the 开拓者 uploaded — the one payload in the record
 * that never came from the repo, the backend, or Herta — and dreams distil into
 * a first-person autobiography that persists across sessions. She should
 * remember being handed a spec; the spec's contents are not hers to keep.
 *
 * So the citation in `body` stays (that is what happened) and the detail is
 * dropped. `show_excerpt` detail is deliberately NOT dropped here: repo
 * excerpts are bounded work evidence and have ridden into dreams since ADR
 * 0027 — changing that is a separate decision, not a side effect of this one.
 */
export function dreamRelevantEvidenceDetail(b: SystemBlock): string | null {
  if (b.digest?.kind === "attachment") return null;
  // A document digest's overview (ADR 0043) is the same document's contents
  // one step removed — a model's précis of what the user handed over — and
  // no more hers to keep than the head excerpt is. The row stays: she
  // remembers having 板砖 digest the file.
  if (b.digest?.kind === "digest") return null;
  return b.evidenceDetail ?? null;
}

export function buildEpisodeDigest(
  blocks: readonly TerminalRecordBlock[],
): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.kind === "user") {
      parts.push(`开拓者：${b.text}`);
    } else if (b.kind === "herta") {
      // A supervisor-vetoed-then-corrected speech block carries the veto
      // reason in `selfCorrection`; surface it as a labeled self-correction
      // beat (a strong no-overclaim / honesty voice signal) before the final
      // corrected line. Mirrors how the live actor keeps it (serialize.ts).
      if (
        b.surface === "speech" &&
        b.selfCorrection !== undefined &&
        b.selfCorrection.length > 0
      ) {
        parts.push(`〔黑塔的自我更正：${b.selfCorrection}〕`);
      }
      parts.push(
        `${b.surface === "thought" ? "我（内心独白）" : "我"}：${b.text}`,
      );
    } else {
      const body = dreamRelevantSystemBody(b);
      if (body === null) continue;
      // Verified backend/system evidence — the outcome spine. Keep it clearly
      // labeled so the model grounds the verdict in what actually happened.
      // The ↳ 待办 roll-up line is dropped: open work items are operational
      // residue, not part of what happened.
      const detail = dreamRelevantEvidenceDetail(b);
      const evidence =
        detail === null
          ? ""
          : detail
              .split("\n")
              .filter((l) => !l.startsWith("↳ 待办"))
              .join("\n");
      parts.push(
        `〔${b.label}（已核实）：${body}${evidence.length > 0 ? `\n${evidence}` : ""}〕`,
      );
    }
  }
  return parts.join("\n");
}
