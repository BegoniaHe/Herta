import { hardenedGitArgs, spawnGit } from "./spawn-git.js";

/**
 * A page of the repository's history for the viewer's log tab (ADR 0059
 * §6): HEAD's first-parent-inclusive `git log`, newest first, with each
 * commit marked UNPUSHED when it is not yet on the branch's upstream —
 * the set `rev-list @{upstream}..HEAD` names, not a guess from the ahead
 * count and the list's order (a merge can interleave them).
 *
 * `skip` / `limit` page it; one extra row is asked for so `hasMore` is a
 * fact, not an inference from a full page. Same null-never-throw contract
 * as the other readers.
 */
export interface LogEntry {
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly author: string;
  /** ISO 8601 author date. */
  readonly authoredAt: string;
  /** Not on the tracked upstream yet (false when there is no upstream). */
  readonly unpushed: boolean;
}

export interface LogPage {
  readonly entries: readonly LogEntry[];
  readonly skip: number;
  /** More history lies past this page. */
  readonly hasMore: boolean;
  /** The upstream the marks are measured against, or null when unset. */
  readonly upstream: string | null;
}

export const LOG_PAGE_SIZE = 50;
export const MAX_LOG_LIMIT = 200;
/** Unpushed marks are bounded: a branch thousands of commits ahead of a
 *  stale upstream is not what the mark is for. */
const MAX_UNPUSHED = 5_000;
const FIELD = "\x1f";

export async function describeLog(
  workspaceRoot: string,
  opts: { readonly skip: number; readonly limit: number },
  signal?: AbortSignal,
): Promise<LogPage | null> {
  try {
    return await describe(workspaceRoot, opts, signal);
  } catch {
    return null;
  }
}

/** The set of commits not on the upstream, or empty when there is none.
 *  Exported for the probe, which marks the card's own ten with it. */
export async function unpushedShas(
  workspaceRoot: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{
  readonly shas: ReadonlySet<string>;
  readonly upstream: string | null;
}> {
  // `@{upstream}` on a branch without one exits 128 — an answer (nothing
  // to measure against), not a failure.
  const [list, name] = await Promise.all([
    spawnGit(
      workspaceRoot,
      hardenedGitArgs([
        "rev-list",
        "--max-count",
        String(MAX_UNPUSHED),
        "@{upstream}..HEAD",
      ]),
      signal,
      { timeoutMs, allowExitCodes: [128] },
    ),
    spawnGit(
      workspaceRoot,
      hardenedGitArgs([
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ]),
      signal,
      { timeoutMs, allowExitCodes: [128] },
    ),
  ]);
  if (!list.ok || !name.ok || list.exitCode !== 0 || name.exitCode !== 0) {
    return { shas: new Set(), upstream: null };
  }
  const upstream = name.stdout.trim();
  return {
    shas: new Set(
      list.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
    upstream: upstream.length > 0 ? upstream : null,
  };
}

async function describe(
  workspaceRoot: string,
  opts: { readonly skip: number; readonly limit: number },
  signal?: AbortSignal,
): Promise<LogPage | null> {
  const skip = Number.isInteger(opts.skip) && opts.skip >= 0 ? opts.skip : -1;
  const limit =
    Number.isInteger(opts.limit) && opts.limit > 0
      ? Math.min(opts.limit, MAX_LOG_LIMIT)
      : -1;
  if (skip < 0 || limit < 0) return null;
  const sig = signal ?? new AbortController().signal;
  const timeoutMs = 5_000;

  // `log` exits 128 both outside a repository and on an unborn HEAD; the
  // `--verify --quiet` probe tells them apart (128 = no repository, which
  // stays a failure; 1 = no commits yet, which is an empty history).
  const [head, log, marks] = await Promise.all([
    spawnGit(
      workspaceRoot,
      hardenedGitArgs(["rev-parse", "--verify", "--quiet", "HEAD"]),
      sig,
      { timeoutMs, allowExitCodes: [1] },
    ),
    spawnGit(
      workspaceRoot,
      hardenedGitArgs([
        "log",
        "-z",
        `--format=%H${FIELD}%h${FIELD}%an${FIELD}%aI${FIELD}%s`,
        "--skip",
        String(skip),
        "-n",
        String(limit + 1),
        "HEAD",
        "--",
      ]),
      sig,
      { timeoutMs, allowExitCodes: [128] },
    ),
    unpushedShas(workspaceRoot, sig, timeoutMs),
  ]);
  if (!head.ok || !log.ok) return null;
  const records =
    head.exitCode === 0 && log.exitCode === 0
      ? log.stdout.split("\0").filter((r) => r.length > 0)
      : [];
  const entries: LogEntry[] = [];
  for (const rec of records.slice(0, limit)) {
    const [sha = "", shortSha = "", author = "", authoredAt = "", ...rest] =
      rec.split(FIELD);
    if (sha.length === 0) continue;
    entries.push({
      sha,
      shortSha,
      author,
      authoredAt,
      subject: rest.join(FIELD),
      unpushed: marks.shas.has(sha),
    });
  }
  return {
    entries,
    skip,
    hasMore: records.length > limit,
    upstream: marks.upstream,
  };
}
