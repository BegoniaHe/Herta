import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { PageMarkerLang, SystemBlock } from "@herta/core";
import { ensureHertaGitignore, pageMarkerShape } from "@herta/core";
import { sanitizeSystemBlock } from "@herta/herta";
import {
  isCredentialBasename,
  isSensitiveSegment,
  looksBinary,
  MAX_EXCERPT_CHARS,
  MAX_EXCERPT_LINES,
  redactSecrets,
} from "@herta/tools";
import {
  type DocumentFormat,
  extractDocumentText,
  type OutlineEntry,
  sniffDocumentFormat,
} from "./document-text.js";

/**
 * Ingest a document the 开拓者 handed over (ADR 0033).
 *
 * The whole job is: get the bytes inside the workspace where the ordinary file
 * tools can already reach them, and emit ONE record block saying what arrived.
 * There is deliberately no new reading capability here — `read_file`,
 * `search_text`, `glob` and `show_excerpt` handle documents of any size
 * already, and ADR 0025 slice 2's persistence layer survived a 347K-char read.
 * A 200-page document is a file.
 *
 * PDF and Word (ADR 0038) keep that shape by being decoded ONCE, here: what
 * lands on disk is the extracted text (`report-<hash>.pdf.txt`), so the tools
 * still only ever read text. See `document-text.ts`.
 *
 * All I/O is async: this runs on the Electron MAIN process, and a synchronous
 * multi-megabyte copy there freezes the whole window for its duration.
 */

/** Per-file excerpt cap. Above this the file may still be STORED (searching a
 *  5MB log is a real use) but no head excerpt is taken and the block says so. */
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

/** Storage ceiling (ADR 0033, amended after review). Files above this are
 *  REFUSED without being read: the first implementation read every source
 *  into memory before deciding anything, so a mis-dropped 20GB ISO meant a
 *  multi-gigabyte buffer (or ERR_FS_FILE_TOO_LARGE dressed up as a read
 *  error) and a workspace copy nobody asked for. The stat runs first and a
 *  too-big file costs nothing. */
export const MAX_ATTACHMENT_STORE_BYTES = 64 * 1024 * 1024;

/** Decoded-character cap, applied after the byte cap because a UTF-8 file can
 *  be far smaller in bytes than in the chars a prompt pays for. */
export const MAX_ATTACHMENT_CHARS = 200_000;

/** Files per attach action. */
export const MAX_ATTACHMENTS_PER_ACTION = 10;

/** How much of a document's outline rides the record block's detail
 *  (2026-08-23) — the presentation bound for Herta's view of the table of
 *  contents, the way the head excerpt is bounded for the body. The sidecar
 *  holds the whole thing; the detail says how many entries it shows of how
 *  many. */
export const OUTLINE_PREVIEW_ENTRIES = 40;
export const OUTLINE_PREVIEW_CHARS = 2000;

/** Where a session's attachments live, relative to the backend workspace.
 *  Session-scoped so deleting or rewinding a session takes its documents with
 *  it, and so the path class in `resolveSafePath` can be a fixed prefix. */
export function attachmentDirFor(sessionId: string): string {
  return `.herta/attachments/${sessionId}`;
}

/**
 * Move a session's attachments when the backend workspace changes
 * (owner question, 2026-08-10).
 *
 * Attachment blocks cite a workspace-RELATIVE path, and 板砖 resolves it
 * against whatever root is current at dispatch time. So without this, changing
 * the coprocessor's working directory silently broke every document already
 * handed over: the citation still read `.herta/attachments/<sid>/spec.md`, and
 * that path no longer pointed at anything. `removeAttachment` had the mirror
 * bug — it unlinked from the CURRENT root with `force: true`, reporting success
 * while the real file sat orphaned under the old one.
 *
 * A MOVE, not a copy: exactly one copy of a user's document should exist, and
 * switching back and forth should not scatter duplicates across every workspace
 * they have ever pointed at.
 *
 * Best-effort and non-throwing, because a workspace change must not fail over
 * file housekeeping — but deliberately NOT silent about the order of
 * operations: the old directory is removed only after the copy lands, so a
 * failure mid-way leaves the originals where they are rather than losing them.
 * Returns whether anything moved, for the caller's log/test.
 */
export async function migrateAttachments(opts: {
  readonly fromRoot: string;
  readonly toRoot: string;
  readonly sessionId: string;
}): Promise<boolean> {
  if (opts.fromRoot === opts.toRoot) return false;
  const rel = attachmentDirFor(opts.sessionId).split("/");
  const from = join(opts.fromRoot, ...rel);
  const to = join(opts.toRoot, ...rel);
  try {
    if (!existsSync(from)) return false;
    await mkdir(dirname(to), { recursive: true });
    // Merge rather than replace: switching away and back should find the
    // directory as it was left. Content-hashed names make same-name collisions
    // same-content, so overwriting is a no-op on identical files.
    await cp(from, to, { recursive: true, force: true });
    await rm(from, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export type AttachmentUnreadable =
  | "binary"
  | "too_large"
  | "empty"
  | "read_error"
  | "denied"
  | "encrypted"
  | "unsupported";

export interface IngestedAttachment {
  /** The record block to append. Already sanitized. */
  readonly block: SystemBlock;
  /** Workspace-relative path the file was stored at. Empty when nothing was
   *  stored (read_error, denied, over the storage ceiling, and every
   *  document-extraction failure — there is no text to store). */
  readonly relPath: string;
  /** Set when no excerpt was taken. */
  readonly unreadable?: AttachmentUnreadable;
}

/**
 * Credential guard on the SOURCE path (ADR 0033 review finding).
 *
 * Two reasons this must run at the door rather than relying on the stored
 * side. First, `safeStoredName` appends a content hash, so `id_rsa` stores as
 * `id_rsa-ab12cd34` — a name the credential-basename denylist no longer
 * matches. The store-side guard is structurally bypassed for exactly the
 * files it exists to protect. Second, the attach IPC accepts arbitrary paths
 * from the renderer, and the renderer is sandboxed away from the filesystem
 * on purpose: without this check, attach is a read-any-file primitive whose
 * output (the head excerpt) streams straight back to the renderer through the
 * record. The same shared denylist every tool uses (D4 — one definition of
 * "credential-shaped", or none).
 */
function isCredentialShapedSource(sourcePath: string): boolean {
  const segments = sourcePath.split(/[\\/]/).filter((s) => s.length > 0);
  const base = segments[segments.length - 1] ?? "";
  if (isCredentialBasename(base)) return true;
  return segments.some((s) => isSensitiveSegment(s));
}

/**
 * Make a user-supplied filename safe to join onto a path.
 *
 * The name comes from outside the workspace entirely, so it is the one string
 * here that an attacker (or an ordinary user with an odd filename) fully
 * controls. Everything outside a conservative allowlist becomes `_`, path
 * separators and dots included, so `../../.ssh/id_rsa` cannot survive as
 * anything but a flat basename — belt to `resolveSafePath`'s braces, since the
 * write itself does not go through the tool path guard.
 *
 * The DISPLAY name keeps the original spelling; only the on-disk name is
 * flattened. A user who attaches `报告 (最终).md` should see that in the
 * record, not `___________.md`.
 */
export function safeStoredName(originalName: string, bytes: Buffer): string {
  const base = basename(originalName);
  const ext = extname(base)
    .slice(0, 16)
    .replace(/[^A-Za-z0-9.]/g, "");
  const stem = base
    .slice(0, base.length - extname(base).length)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 60);
  // A content hash disambiguates same-named files and makes re-attaching the
  // identical document idempotent rather than accumulating copies.
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const safeStem = stem.length > 0 ? stem : "file";
  return `${safeStem}-${hash}${ext}`;
}

/**
 * Cut the head of a document for `evidenceDetail`. Presentation bounds, shared
 * with `show_excerpt` — this exists to be read, and it lands in Herta's prompt
 * for exactly one turn (the per-block fold drops it once she has spoken).
 *
 * REDACTED (2026-08-10, found in an owner screenshot). The filename guard
 * cannot carry this on its own: it refuses credential-SHAPED names, and a file
 * called `openrouter_key.txt` matches none of them — so the ingest stored it,
 * cut its head, and put two live API keys into the record, the GUI, and the
 * prompt sent to DeepSeek. `run_command` output and `search_text` results have
 * always run through `redactSecrets`; the ingest was the one producer of
 * untrusted text that did not, and a hand-uploaded file is the likeliest place
 * of all for a key to appear.
 *
 * The STORED file is left verbatim. It is the user's document, redacting it
 * would corrupt their data, and the tools that read it are the ones they
 * pointed at it deliberately. This redacts the copy that travels — record,
 * screen, prompt — which is the copy nobody asked to publish.
 */
export function headExcerpt(text: string): { text: string; clipped: boolean } {
  // Redact BEFORE slicing (review #4 — the first version sliced first, with a
  // comment confidently justifying the wrong order). Slice-then-redact leaves
  // a key cut by the char boundary as a fragment the patterns may no longer
  // match — `sk-or-v1-a6a9` — a partial leak. Redact-then-slice turns the
  // whole key into a marker before any cut; the worst a cut can then do is
  // truncate the MARKER, which discloses nothing. The full-text redact is a
  // bounded regex pass over at most MAX_ATTACHMENT_CHARS.
  const redacted = redactSecrets(text);
  const lines = redacted.split("\n");
  let out = lines.slice(0, MAX_EXCERPT_LINES).join("\n");
  let clipped = lines.length > MAX_EXCERPT_LINES;
  if (out.length > MAX_EXCERPT_CHARS) {
    out = out.slice(0, MAX_EXCERPT_CHARS);
    clipped = true;
  }
  return { text: out, clipped };
}

/** The bounded slice of outline lines the record block shows: entry- and
 *  char-capped, whole lines only, so a long title never gets cut mid-word.
 *  Redacted like the head (§6f): the sidecar on disk stays verbatim, the copy
 *  that travels does not. */
function outlinePreview(lines: readonly string[]): string[] {
  const out: string[] = [];
  let chars = 0;
  for (const raw of lines.slice(0, OUTLINE_PREVIEW_ENTRIES)) {
    const line = redactSecrets(raw);
    if (chars + line.length + 1 > OUTLINE_PREVIEW_CHARS && out.length > 0) {
      break;
    }
    out.push(line);
    chars += line.length + 1;
  }
  return out;
}

function formatCount(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n);
}

/**
 * The reason phrase for an unreadable state. Two states read differently for
 * an extracted document than for a text file, and the difference is the
 * point: `too_large` on a stored text file means "no head, still searchable",
 * on a PDF over the page cap it means "refused, nothing on disk"; `empty` on
 * a PDF is almost always a scan, which the user can act on (OCR it, find the
 * source) — "未提取到文本" alone would send them checking the file.
 */
function reasonFor(
  unreadable: AttachmentUnreadable,
  ctx: { readonly format?: DocumentFormat; readonly relPath: string | null },
): string {
  switch (unreadable) {
    case "binary":
      return "非文本文件，未取正文";
    case "too_large":
      if (ctx.format === undefined) return "文件过大，未取正文";
      return ctx.relPath === null ? "页数过多，未提取" : "正文过长，未取正文";
    case "empty":
      return ctx.format === "pdf"
        ? "未提取到文本，可能是扫描件"
        : "未提取到文本";
    case "read_error":
      return ctx.format === undefined ? "读取失败" : "解析失败";
    case "denied":
      return "涉及密钥或凭据，已拒收";
    case "encrypted":
      return "文档已加密，未取正文";
    case "unsupported":
      return "暂不支持的文档格式，未取正文";
  }
}

/** The not-stored result shapes share one constructor so `relPath: ""` and
 *  the block's empty digest path can never drift apart. `format`/`pages`
 *  ride along for a document that failed extraction, so the block can still
 *  say "this was a 40-page PDF" about a file it did not keep. */
function notStored(
  displayName: string,
  unreadable: AttachmentUnreadable,
  doc: { readonly format?: DocumentFormat; readonly pages?: number } = {},
): IngestedAttachment {
  return {
    block: buildBlock({
      displayName,
      relPath: null,
      lines: 0,
      chars: 0,
      unreadable,
      ...doc,
    }),
    relPath: "",
    unreadable,
  };
}

/** Write the (possibly extracted) bytes under the session's attachment
 *  directory. Returns the workspace-relative path, or null when the write
 *  failed — the caller maps that to `read_error` (not on disk, do not cite a
 *  location). Shared by the text path and the document path so the .herta
 *  gitignore reflex (audit BL6) lives in one place. */
async function storeBytes(opts: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly storedName: string;
  readonly bytes: Uint8Array;
}): Promise<string | null> {
  const dir = attachmentDirFor(opts.sessionId);
  try {
    const absDir = join(opts.workspaceRoot, ...dir.split("/"));
    await mkdir(absDir, { recursive: true });
    await writeFile(join(absDir, opts.storedName), opts.bytes);
    // Same reason as every other `.herta` writer (audit BL6): in a real repo,
    // the first `git add -A` after an attach would otherwise sweep the user's
    // own documents into a commit. Best-effort by its own contract.
    ensureHertaGitignore(opts.workspaceRoot);
  } catch {
    return null;
  }
  return `${dir}/${opts.storedName}`;
}

/**
 * The PDF / Word path (ADR 0038): decode once, store the TEXT. The stored
 * name keeps the source extension visible (`report-<hash>.pdf.txt`), hashed
 * over the ORIGINAL bytes so re-attaching the same document is idempotent.
 * Every failure is a not-stored block that says which failure — there is no
 * text to store, and storing the binary would cite a file no tool can read.
 */
async function ingestDocument(opts: {
  readonly format: DocumentFormat;
  readonly displayName: string;
  readonly bytes: Buffer;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly lang: PageMarkerLang;
}): Promise<IngestedAttachment> {
  const { format, displayName } = opts;
  const extracted = await extractDocumentText(format, opts.bytes, {
    lang: opts.lang,
  });
  if (!extracted.ok) {
    const doc = {
      format,
      ...(extracted.pages !== undefined ? { pages: extracted.pages } : {}),
    };
    switch (extracted.reason) {
      case "empty":
        return notStored(displayName, "empty", doc);
      case "encrypted":
        return notStored(displayName, "encrypted", doc);
      case "too_many_pages":
        return notStored(displayName, "too_large", doc);
      case "unsupported":
        return notStored(displayName, "unsupported", doc);
      case "parse_error":
        return notStored(displayName, "read_error", doc);
    }
  }
  const text = extracted.text;
  const doc = {
    format,
    ...(extracted.pages !== undefined ? { pages: extracted.pages } : {}),
    // A PDF's text is opened per page with the marker line (2026-08-23);
    // the digest records the exact shape the file carries.
    ...(format === "pdf" ? { pageMarker: pageMarkerShape(opts.lang) } : {}),
  };
  const baseName = safeStoredName(displayName, opts.bytes);
  const storedName = `${baseName}.txt`;
  const relPath = await storeBytes({
    workspaceRoot: opts.workspaceRoot,
    sessionId: opts.sessionId,
    storedName,
    bytes: Buffer.from(text, "utf8"),
  });
  if (relPath === null) return notStored(displayName, "read_error", doc);

  // The outline sidecar (2026-08-23) — written beside the text, best-effort:
  // the text is the attachment, and a failed sidecar write must not turn a
  // stored document into a read_error. Absent when the document has none.
  const outline =
    extracted.outline !== undefined && extracted.outline.length > 0
      ? await storeOutline({
          workspaceRoot: opts.workspaceRoot,
          sessionId: opts.sessionId,
          storedName: `${baseName}.outline.txt`,
          entries: extracted.outline,
        })
      : undefined;

  const lines = text.split("\n").length;
  // The char cap applies to the EXTRACTED text — the source-byte excerpt cap
  // does not, because a PDF's bytes are mostly fonts and images (ADR 0038 §4).
  // Same rule as a 5 MB log: stored and searchable, no head excerpt — but
  // the outline preview still rides the detail, so an over-cap document is
  // no longer a blank citation in front of Herta.
  if (text.length > MAX_ATTACHMENT_CHARS) {
    return {
      block: buildBlock({
        displayName,
        relPath,
        lines,
        chars: text.length,
        unreadable: "too_large",
        ...doc,
        ...(outline !== undefined ? { outline } : {}),
      }),
      relPath,
      unreadable: "too_large",
    };
  }
  return {
    block: buildBlock({
      displayName,
      relPath,
      lines,
      chars: text.length,
      head: headExcerpt(text),
      ...doc,
      ...(outline !== undefined ? { outline } : {}),
    }),
    relPath,
  };
}

/** What the block carries about a stored outline: the sidecar's path, the
 *  formatted lines (all of them — buildBlock bounds the preview), the count. */
interface StoredOutline {
  readonly path: string;
  readonly lines: readonly string[];
  readonly total: number;
}

/**
 * Format one outline entry as the sidecar line — indentation by depth, then
 * the title, then where it is: `(p.12 · L345)` for a PDF (page, marker line),
 * `(L345)` for Word. Terse and language-neutral on purpose: it is read by
 * 板砖 through `cat`, quoted by `show_excerpt`, and previewed in the record
 * in both languages; the task line explains the columns.
 */
export function formatOutlineEntry(e: OutlineEntry): string {
  const indent = "  ".repeat(Math.max(0, e.level - 1));
  const where =
    e.page !== undefined ? `p.${e.page} · L${e.line}` : `L${e.line}`;
  return `${indent}${e.title} (${where})`;
}

async function storeOutline(opts: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly storedName: string;
  readonly entries: readonly OutlineEntry[];
}): Promise<StoredOutline | undefined> {
  const lines = opts.entries.map(formatOutlineEntry);
  const path = await storeBytes({
    workspaceRoot: opts.workspaceRoot,
    sessionId: opts.sessionId,
    storedName: opts.storedName,
    bytes: Buffer.from(`${lines.join("\n")}\n`, "utf8"),
  });
  if (path === null) return undefined;
  return { path, lines, total: opts.entries.length };
}
/**
 * Copy one file into the session's attachment directory and build its record
 * block.
 *
 * `workspaceRoot` must be the BACKEND's effective workspace, not the session's
 * record anchor: the block's path is what 板砖 will later resolve, and it
 * resolves against the backend root. If the user changes workspace afterwards
 * the stored path goes stale — the same way every other relative path already
 * in the record does, so this introduces no new class of staleness.
 *
 * Never throws: every failure becomes a block that says what happened. The
 * caller appends whatever comes back, so a throw here would be a file that
 * vanished without a trace — the one outcome worse than any failure state.
 */
export async function ingestAttachment(opts: {
  readonly sourcePath: string;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  /** Overrides the on-disk source's basename for DISPLAY (the renderer knows
   *  the name the user saw; the main process only has a temp path in some
   *  drag-and-drop flows). */
  readonly displayName?: string;
  /** Session interaction language — decides the page-marker lines a PDF's
   *  text is opened with (2026-08-23). Default zh. */
  readonly lang?: PageMarkerLang;
}): Promise<IngestedAttachment> {
  const displayName = opts.displayName ?? basename(opts.sourcePath);

  // Credential guard first — before any read, and on BOTH names (they are the
  // same in today's flows, but the display override must not become the hole).
  if (
    isCredentialShapedSource(opts.sourcePath) ||
    isCredentialShapedSource(displayName)
  ) {
    return notStored(displayName, "denied");
  }

  // Stat before read: the storage ceiling must not cost a read of the very
  // bytes it exists to refuse.
  let size: number;
  try {
    size = (await stat(opts.sourcePath)).size;
  } catch {
    return notStored(displayName, "read_error");
  }
  if (size > MAX_ATTACHMENT_STORE_BYTES) {
    return notStored(displayName, "too_large");
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(opts.sourcePath);
  } catch {
    return notStored(displayName, "read_error");
  }

  // PDF / Word go through extraction (ADR 0038); a recognized-but-undecodable
  // document format gets its own answer; everything else is the text path.
  const sniff = sniffDocumentFormat(displayName, bytes);
  if (sniff.kind === "unsupported") {
    return notStored(displayName, "unsupported");
  }
  if (sniff.kind !== "none") {
    return ingestDocument({
      format: sniff.kind,
      displayName,
      bytes,
      workspaceRoot: opts.workspaceRoot,
      sessionId: opts.sessionId,
      lang: opts.lang ?? "zh",
    });
  }

  const relPath = await storeBytes({
    workspaceRoot: opts.workspaceRoot,
    sessionId: opts.sessionId,
    storedName: safeStoredName(displayName, bytes),
    bytes,
  });
  if (relPath === null) {
    // The write failed, so nothing is at the path — same truth as read_error:
    // not on disk, do not cite a location.
    return notStored(displayName, "read_error");
  }

  // Stored, but larger than the excerpt cap — searchable, not excerpted.
  if (size > MAX_ATTACHMENT_BYTES) {
    return {
      block: buildBlock({
        displayName,
        relPath,
        lines: 0,
        chars: 0,
        unreadable: "too_large",
      }),
      relPath,
      unreadable: "too_large",
    };
  }
  if (looksBinary(bytes)) {
    return {
      block: buildBlock({
        displayName,
        relPath,
        lines: 0,
        chars: 0,
        unreadable: "binary",
      }),
      relPath,
      unreadable: "binary",
    };
  }

  const text = bytes.toString("utf8");
  if (text.trim().length === 0) {
    return {
      block: buildBlock({
        displayName,
        relPath,
        lines: 0,
        chars: 0,
        unreadable: "empty",
      }),
      relPath,
      unreadable: "empty",
    };
  }
  if (text.length > MAX_ATTACHMENT_CHARS) {
    return {
      block: buildBlock({
        displayName,
        relPath,
        lines: text.split("\n").length,
        chars: text.length,
        unreadable: "too_large",
      }),
      relPath,
      unreadable: "too_large",
    };
  }

  const head = headExcerpt(text);
  return {
    block: buildBlock({
      displayName,
      relPath,
      lines: text.split("\n").length,
      chars: text.length,
      head,
    }),
    relPath,
  };
}

/**
 * Compose the block. The canonical body is Chinese, like the bridge's marker
 * bodies and unlike the bus-projected op rows — this block is harness-authored
 * prose, not an echo of a tool argument. Renderers localize from the digest
 * (ADR 0018), so the body is never parsed.
 */
function buildBlock(a: {
  displayName: string;
  relPath: string | null;
  lines: number;
  chars: number;
  unreadable?: AttachmentUnreadable;
  head?: { text: string; clipped: boolean };
  format?: DocumentFormat;
  pages?: number;
  pageMarker?: string;
  outline?: StoredOutline;
}): SystemBlock {
  const parts = [`附件 ${a.displayName}`];
  // A document is named as such up front, so the `.pdf.txt` path further
  // along never reads as a text file the user typed (ADR 0038 §1). The page
  // count sits with it: "a 40-page PDF" is what the user knows the file as.
  if (a.format !== undefined) {
    parts.push(a.format === "pdf" ? "PDF" : "Word 文档");
    if (a.pages !== undefined) parts.push(`${formatCount(a.pages)} 页`);
  }
  if (a.unreadable !== undefined) {
    parts.push(
      reasonFor(a.unreadable, { format: a.format, relPath: a.relPath }),
    );
  } else {
    if (a.format !== undefined) parts.push("已提取文本");
    parts.push(`${formatCount(a.lines)} 行`, `${formatCount(a.chars)} 字`);
  }
  // The outline count sits before the path in both states: for an over-cap
  // document it is the one thing the row can say about what is inside.
  if (a.outline !== undefined && a.relPath !== null) {
    parts.push(`目录 ${a.outline.total} 条`);
  }
  if (a.relPath !== null) parts.push(a.relPath);

  // Detail: the head (when one was taken) then the outline preview (when the
  // document has one) — both prompt-visible while the attachment is fresh,
  // both dropped when the block folds (ADR 0033 §1 / §6g). An over-cap
  // document has no head and still gets the outline.
  const sections: string[] = [];
  const evidence: NonNullable<SystemBlock["evidence"]>[number][] = [];
  if (a.head !== undefined && a.relPath !== null) {
    sections.push(
      `↳ 附件 ${a.displayName}\n${a.head.text}${
        a.head.clipped ? "\n（仅开头部分，正文更长）" : ""
      }`,
    );
    evidence.push({
      kind: "attachment",
      name: a.displayName,
      path: a.relPath,
      text: a.head.text,
      clipped: a.head.clipped,
    });
  }
  if (a.outline !== undefined && a.relPath !== null) {
    const preview = outlinePreview(a.outline.lines);
    const shown =
      preview.length < a.outline.total ? `（前 ${preview.length} 条）` : "";
    sections.push(
      `↳ 目录 ${a.outline.total} 条${shown}\n${preview.join("\n")}`,
    );
    evidence.push({
      kind: "outline",
      name: a.displayName,
      path: a.outline.path,
      items: preview,
      total: a.outline.total,
    });
  }

  const block: SystemBlock = {
    kind: "system",
    label: "系统",
    body: parts.join(" · "),
    ...(sections.length > 0
      ? { evidenceDetail: sections.join("\n"), evidence }
      : {}),
    digest: {
      kind: "attachment",
      name: a.displayName,
      path: a.relPath ?? "",
      lines: a.lines,
      chars: a.chars,
      ...(a.format !== undefined ? { format: a.format } : {}),
      ...(a.pages !== undefined ? { pages: a.pages } : {}),
      ...(a.unreadable !== undefined ? { unreadable: a.unreadable } : {}),
      ...(a.pageMarker !== undefined && a.relPath !== null
        ? { pageMarker: a.pageMarker }
        : {}),
      ...(a.outline !== undefined && a.relPath !== null
        ? { outline: { path: a.outline.path, entries: a.outline.total } }
        : {}),
    },
  };

  // The trust boundary. An attachment's name and text are the only strings
  // reaching a prompt that never passed through the repo or the backend — the
  // user picked them — and the serializer does not sanitize system bodies at
  // read, so construction is the only gate. A planted （我 说） in an uploaded
  // file must not forge an actor block.
  return sanitizeSystemBlock(block);
}
