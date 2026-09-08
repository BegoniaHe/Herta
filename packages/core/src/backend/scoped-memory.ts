import type { MemoryItem } from "../memory-manager.js";

/**
 * Project memory → the backend frame's `scopedMemory` slot (ADR 0060).
 *
 * `memory_save` had written operational facts to `.herta/memory/project.jsonl`
 * since 2026-05 and nothing ever read them back: the slot was declared,
 * token-counted and emitted on the wire, and the ONE production dispatch
 * passed nothing, so every brief saw `""` (Codex study 2026-08-24 #43,
 * long-run study 2026-08-25 L9). This renders what the store holds as one
 * compact list the runtime recalls at brief start.
 *
 * Shape rules:
 * - Newest LAST, so the freshest fact sits nearest the task text that
 *   follows it in the frame.
 * - Bounded twice — by count and by characters — so a full store (the
 *   manager caps at 200 items × 500 chars) can never cost more than a few
 *   thousand tokens of the P2 band. Older items give way first; the header
 *   says how many were left out.
 * - `kind` rides each line in brackets: the model can tell a test command
 *   from a flaky-test note without a second lookup, and the vocabulary is
 *   the neutral machine one (D2), never Herta's.
 */
export const SCOPED_MEMORY_MAX_ITEMS = 40;
export const SCOPED_MEMORY_MAX_CHARS = 4000;

const HEADER_ZH =
  "项目记忆（此前会话保存的操作性事实，最新在最后；仅供参考，以仓库当前状态为准）：";
const HEADER_EN =
  "Project memory (operational facts saved in earlier sessions, newest last; hints only — the workspace as it is now is authoritative):";

function elisionNote(lang: "zh" | "en", omitted: number): string {
  return lang === "en"
    ? `(${omitted} older item(s) not shown)`
    : `（另有 ${omitted} 条更早的记忆未列出）`;
}

/** One item as one list entry; a multi-line text keeps its lines, indented
 *  under the bullet so the list shape survives. */
function renderItem(item: MemoryItem): string {
  const text = item.text.split(/\r?\n/).join("\n  ");
  return `- [${item.kind}] ${text}`;
}

/** Oldest first by `createdAt`; ties keep store order (a stable sort). */
function byCreatedAt(a: MemoryItem, b: MemoryItem): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

export interface RenderScopedMemoryOptions {
  readonly maxItems?: number;
  readonly maxChars?: number;
}

/**
 * The frame text for a store's items, or `""` when there is nothing to say
 * (the translate layer omits an empty slot, so an empty store leaves the
 * wire byte-identical to before the recall existed).
 */
export function renderScopedMemory(
  items: readonly MemoryItem[],
  lang: "zh" | "en",
  opts: RenderScopedMemoryOptions = {},
): string {
  if (items.length === 0) return "";
  const maxItems = opts.maxItems ?? SCOPED_MEMORY_MAX_ITEMS;
  const maxChars = opts.maxChars ?? SCOPED_MEMORY_MAX_CHARS;
  const ordered = [...items].sort(byCreatedAt);
  let kept = ordered.slice(Math.max(0, ordered.length - maxItems));
  const header = lang === "en" ? HEADER_EN : HEADER_ZH;

  const render = (): string => {
    const omitted = ordered.length - kept.length;
    const lines = [header];
    if (omitted > 0) lines.push(elisionNote(lang, omitted));
    for (const item of kept) lines.push(renderItem(item));
    return lines.join("\n");
  };

  let text = render();
  // Drop the OLDEST until the text fits; the newest item always stays even
  // if it alone overruns (a single 500-char item never does).
  while (text.length > maxChars && kept.length > 1) {
    kept = kept.slice(1);
    text = render();
  }
  return text;
}
