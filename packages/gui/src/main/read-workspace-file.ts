import { promises as fs } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

/**
 * The file-viewer read (ADR 0050 §2): one bounded, workspace-jailed read
 * for the renderer's viewer panel. User-only display chrome — the content
 * never reaches a model or the record, so the jail here is about the
 * RENDERER not being handed an arbitrary-filesystem read primitive, not
 * about model containment (that is `@herta/tools`' path-safety, which the
 * GUI main process deliberately does not import).
 */
export interface ReadWorkspaceFileOk {
  readonly ok: true;
  /** UTF-8 text, cut at MAX_VIEWER_BYTES when `truncated`. */
  readonly content: string;
  readonly truncated: boolean;
  /** Total file size in bytes (the honest number when truncated). */
  readonly size: number;
  /** Workspace-relative path, normalized to forward slashes. */
  readonly relative: string;
}
export interface ReadWorkspaceFileErr {
  readonly ok: false;
  readonly reason:
    | "not_found"
    | "not_a_file"
    | "outside_workspace"
    | "binary"
    | "unreadable";
}
export type ReadWorkspaceFileResult =
  | ReadWorkspaceFileOk
  | ReadWorkspaceFileErr;

/** Viewer read cap. Big enough for any file a person would read in a side
 *  panel; the panel says the file continues and offers 打开 for the rest. */
export const MAX_VIEWER_BYTES = 1_500_000;

/** NUL inside the head is the classic text/binary sniff — git's own. */
const BINARY_SNIFF_BYTES = 8_000;

function caseNorm(s: string): string {
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/**
 * Resolve `inputPath` (workspace-relative or absolute) against the
 * workspace, realpath it (symlink hops collapse before the jail check),
 * and judge where it LANDS. Three answers, kept apart on purpose: an
 * in-workspace name that doesn't exist ("missing") must read as a missing
 * file, while a name that resolves outside — including an innocent-named
 * symlink whose target escapes — must read as refused ("outside").
 */
export async function resolveInsideWorkspace(
  workspaceRoot: string,
  inputPath: string,
): Promise<
  | { readonly kind: "ok"; readonly abs: string; readonly relative: string }
  | { readonly kind: "outside" }
  | { readonly kind: "missing" }
> {
  if (typeof inputPath !== "string" || inputPath.trim().length === 0)
    return { kind: "missing" };
  const candidate = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(workspaceRoot, inputPath);
  let realRoot: string;
  try {
    realRoot = await fs.realpath(workspaceRoot);
  } catch {
    return { kind: "missing" };
  }
  const isInside = (p: string): boolean =>
    caseNorm(p) === caseNorm(realRoot) ||
    caseNorm(p).startsWith(caseNorm(realRoot) + sep);
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch {
    // No inode to judge — fall back to the unresolved spelling: an
    // in-workspace name is a missing file, an outside one is refused.
    return isInside(candidate) ? { kind: "missing" } : { kind: "outside" };
  }
  if (!isInside(real)) return { kind: "outside" };
  const relative = real
    .slice(realRoot.length)
    .replace(/^[\\/]/, "")
    .split(sep)
    .join("/");
  return { kind: "ok", abs: real, relative };
}

export async function readWorkspaceFileBounded(
  workspaceRoot: string,
  inputPath: string,
): Promise<ReadWorkspaceFileResult> {
  const resolved = await resolveInsideWorkspace(workspaceRoot, inputPath);
  if (resolved.kind === "outside")
    return { ok: false, reason: "outside_workspace" };
  if (resolved.kind === "missing") return { ok: false, reason: "not_found" };
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(resolved.abs);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (!stat.isFile()) return { ok: false, reason: "not_a_file" };
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    fh = await fs.open(resolved.abs, "r");
    const cap = Math.min(stat.size, MAX_VIEWER_BYTES);
    const buf = Buffer.alloc(cap);
    const { bytesRead } = await fh.read(buf, 0, cap, 0);
    const head = buf.subarray(0, Math.min(bytesRead, BINARY_SNIFF_BYTES));
    if (head.includes(0)) return { ok: false, reason: "binary" };
    // A UTF-8 BOM decodes to ﻿ and paints as a ghost glyph on line 1
    // of the panel (seen live on a PowerShell-written attachment) — the
    // viewer is presentation, so shed it.
    const text = buf.subarray(0, bytesRead).toString("utf8");
    return {
      ok: true,
      content: text.startsWith("\uFEFF") ? text.slice(1) : text,
      truncated: stat.size > MAX_VIEWER_BYTES,
      size: stat.size,
      relative: resolved.relative,
    };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await fh?.close().catch(() => undefined);
  }
}
