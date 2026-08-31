import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  RepoContextDirtyFile,
  RepoContextSnapshot,
  RepoInProgressState,
  RepoSnapshot,
} from "@herta/core";
import { parseStatusPorcelainZ } from "./parse-status.js";
import { hardenedGitArgs, spawnGit } from "./spawn-git.js";

/**
 * The workspace's VCS state at one instant — HEAD plus every path that differs
 * from it.
 *
 * Feeds `CodingAgentRuntime`'s dispatch baseline (taken at brief start and
 * again at brief end). It lives here, not in core, because it needs git and
 * `@herta/tools` already depends on core — importing the other way would close
 * a cycle. The runtime takes it as an injected callback.
 *
 * Returns null rather than throwing for every "cannot tell" case — no repo, no
 * git, a timeout, an unreadable tree, a cancelled dispatch. Attribution is a
 * nicety; it must never be able to fail a brief. A null at either end simply
 * leaves the report with the editors' own harvest, exactly as before this
 * existed.
 *
 * The guard is HERE and not only at the caller, because `spawnGit` REJECTS on
 * abort — correctly, since an interrupt is not a tool failure — so a user's
 * Stop landing mid-probe threw straight through this function's stated
 * contract. One caller happened to wrap it; the invariant should not depend on
 * that.
 */
export async function probeRepoState(
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<RepoSnapshot | null> {
  try {
    return await probe(workspaceRoot, signal);
  } catch {
    return null;
  }
}

/** One file a committed range touched. Mirrors core's `RepoRangeFile`. */
export interface RangeChangedFile {
  readonly path: string;
  readonly kind: "created" | "modified" | "deleted";
}

/** Both ends come from OUR OWN `rev-parse HEAD`, but the guard costs nothing
 *  and keeps this function safe to call with anything: a non-hex "head"
 *  never reaches a git argv. */
const COMMIT_ID = /^[0-9a-f]{4,64}$/;

/**
 * The files the committed range `fromHead..toHead` touched — the dispatch
 * baseline's second half (2026-08-26). Answers ONLY when `toHead` DESCENDS
 * from `fromHead` (this dispatch committed or merged forward, so the range
 * is its own work); a rebase/amend/reset — where the old head is no longer
 * an ancestor — returns null and the runtime keeps its honest refusal note.
 *
 * `--no-renames` on purpose: a rename reports as delete + create, which is
 * exactly what happened to the tree, and spares the parser the Rxxx
 * old\0new shape. Same null-not-throw contract as `probeRepoState`.
 */
export async function diffCommittedRange(
  workspaceRoot: string,
  fromHead: string,
  toHead: string,
  signal?: AbortSignal,
): Promise<readonly RangeChangedFile[] | null> {
  try {
    return await rangeDiff(workspaceRoot, fromHead, toHead, signal);
  } catch {
    return null;
  }
}

async function rangeDiff(
  workspaceRoot: string,
  fromHead: string,
  toHead: string,
  signal?: AbortSignal,
): Promise<readonly RangeChangedFile[] | null> {
  if (!COMMIT_ID.test(fromHead) || !COMMIT_ID.test(toHead)) return null;
  const sig = signal ?? new AbortController().signal;
  const opts = { timeoutMs: 5_000 } as const;

  // Exit 1 is an ANSWER (not an ancestor → not attributable), not a failure.
  const ancestor = await spawnGit(
    workspaceRoot,
    hardenedGitArgs(["merge-base", "--is-ancestor", fromHead, toHead]),
    sig,
    { ...opts, allowExitCodes: [1] },
  );
  if (!ancestor.ok || ancestor.exitCode !== 0) return null;

  const diff = await spawnGit(
    workspaceRoot,
    hardenedGitArgs([
      "diff",
      "--name-status",
      "-z",
      "--no-renames",
      fromHead,
      toHead,
      "--",
    ]),
    sig,
    opts,
  );
  if (!diff.ok) return null;

  const fields = diff.stdout.split("\0");
  const out: RangeChangedFile[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i] ?? "";
    const path = fields[i + 1] ?? "";
    if (status.length === 0 || path.length === 0) continue;
    out.push({
      path,
      kind:
        status[0] === "A"
          ? "created"
          : status[0] === "D"
            ? "deleted"
            : "modified",
    });
  }
  return out;
}

/**
 * Locate the git dir governing `startDir` without spawning git: walk up
 * looking for `.git` — a directory IS the git dir; a file (worktree,
 * submodule) points at it via `gitdir: <path>`. Null when no repo, on any
 * fs error, or on a malformed `.git` file. Sync and cheap on purpose: the
 * shell classifier calls this at ask time (ADR 0049 §5), where a spawn
 * per ask is not acceptable.
 */
export function resolveGitDir(startDir: string): string | null {
  try {
    let dir = resolve(startDir);
    for (;;) {
      const dotGit = join(dir, ".git");
      if (existsSync(dotGit)) {
        const st = statSync(dotGit);
        if (st.isDirectory()) return dotGit;
        if (st.isFile()) {
          const text = readFileSync(dotGit, "utf8");
          const m = /^gitdir:\s*(.+)\s*$/m.exec(text);
          if (m?.[1] === undefined) return null;
          const target = m[1].trim();
          return isAbsolute(target) ? target : resolve(dir, target);
        }
      }
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

/**
 * Which operation the repo at `gitDir` is in the middle of, from the
 * transient files git itself keys on — existence checks only, no spawn
 * (per-worktree state lives in the resolved git dir, so a linked worktree
 * answers for itself). Rebase is checked first: a conflicted rebase stop
 * can also leave e.g. CHERRY_PICK_HEAD around, and "rebase" is the answer
 * a person would give. Null when nothing is mid-flight or on fs errors.
 */
export function detectInProgressState(
  gitDir: string,
): RepoInProgressState | null {
  try {
    if (
      existsSync(join(gitDir, "rebase-merge")) ||
      existsSync(join(gitDir, "rebase-apply"))
    )
      return "rebase";
    if (existsSync(join(gitDir, "MERGE_HEAD"))) return "merge";
    if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
    if (existsSync(join(gitDir, "REVERT_HEAD"))) return "revert";
    if (existsSync(join(gitDir, "BISECT_LOG"))) return "bisect";
    return null;
  } catch {
    return null;
  }
}

/** Unmerged porcelain XY pairs — the conflict set for the snapshot. */
function isUnmerged(x: string, y: string): boolean {
  return (
    x === "U" ||
    y === "U" ||
    (x === "A" && y === "A") ||
    (x === "D" && y === "D")
  );
}

/** Bounds for the snapshot's lists — the prompt section must stay small;
 *  `dirtyTotal` keeps the honest count for the truncation line. */
const MAX_CONTEXT_DIRTY = 40;
const MAX_CONTEXT_CONFLICTED = 20;
const MAX_SUBJECT_CHARS = 120;

/**
 * The richer repo description the backend frame renders as its repo-snapshot
 * section (ADR 0049 §§1–2): branch, upstream ±counts, default branch,
 * in-progress state, conflict set, bounded dirty list, recent subjects.
 *
 * Same contract as {@link probeRepoState}: null (never a throw) for every
 * "cannot tell" case — prompt context is a nicety and must not fail a brief.
 * Runs once per dispatch at brief start, beside the baseline probe.
 */
export async function describeRepoContext(
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<RepoContextSnapshot | null> {
  try {
    return await describe(workspaceRoot, signal);
  } catch {
    return null;
  }
}

async function describe(
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<RepoContextSnapshot | null> {
  const sig = signal ?? new AbortController().signal;
  const opts = { timeoutMs: 5_000 } as const;

  // All four queries are independent; `log` on an unborn HEAD exits 128,
  // which is an answer (no commits → no subjects), not a failure — so the
  // whole set can run concurrently.
  const [head, status, log, originHead] = await Promise.all([
    spawnGit(
      workspaceRoot,
      hardenedGitArgs(["rev-parse", "--short", "HEAD"]),
      sig,
      { ...opts, allowExitCodes: [128] },
    ),
    spawnGit(
      workspaceRoot,
      hardenedGitArgs([
        "status",
        "--porcelain=v1",
        "-z",
        "--branch",
        "--untracked-files=all",
      ]),
      sig,
      opts,
    ),
    spawnGit(
      workspaceRoot,
      hardenedGitArgs(["log", "--oneline", "-n", "5"]),
      sig,
      { ...opts, allowExitCodes: [128] },
    ),
    // Exit 1 = origin/HEAD is simply unset (fresh remote, no clone default).
    spawnGit(
      workspaceRoot,
      hardenedGitArgs([
        "symbolic-ref",
        "--quiet",
        "--short",
        "refs/remotes/origin/HEAD",
      ]),
      sig,
      { ...opts, allowExitCodes: [1] },
    ),
  ]);
  if (!head.ok || !status.ok) return null;

  const parsed = parseStatusPorcelainZ(status.stdout);
  const shortSha = head.stdout.trim();
  const headShort =
    head.exitCode === 0 && shortSha.length > 0 ? shortSha : null;

  const dirty: RepoContextDirtyFile[] = [];
  const conflicted: string[] = [];
  for (const f of parsed.files) {
    if (dirty.length < MAX_CONTEXT_DIRTY) {
      dirty.push({ x: f.indexStatus, y: f.worktreeStatus, path: f.path });
    }
    if (
      conflicted.length < MAX_CONTEXT_CONFLICTED &&
      isUnmerged(f.indexStatus, f.worktreeStatus)
    ) {
      conflicted.push(f.path);
    }
  }

  const recentSubjects =
    log.ok && log.exitCode === 0
      ? log.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
          .slice(0, 5)
          .map((l) =>
            l.length > MAX_SUBJECT_CHARS
              ? `${l.slice(0, MAX_SUBJECT_CHARS)}…`
              : l,
          )
      : [];

  // `--short` yields "origin/main"; the branch name is what the model wants.
  let defaultBranch: string | null = null;
  if (originHead.ok && originHead.exitCode === 0) {
    const ref = originHead.stdout.trim();
    const slash = ref.indexOf("/");
    if (slash > 0 && slash < ref.length - 1)
      defaultBranch = ref.slice(slash + 1);
  }

  const gitDir = resolveGitDir(workspaceRoot);
  const inProgress = gitDir !== null ? detectInProgressState(gitDir) : null;

  return {
    branch: parsed.branch,
    detached: parsed.branch === null && headShort !== null,
    headShort,
    upstream: parsed.upstream ?? null,
    ahead: parsed.ahead,
    behind: parsed.behind,
    defaultBranch,
    inProgress,
    conflicted,
    dirty,
    dirtyTotal: parsed.files.length,
    recentSubjects,
  };
}

async function probe(
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<RepoSnapshot | null> {
  const sig = signal ?? new AbortController().signal;
  // A short budget on purpose: this runs twice per dispatch, and a slow answer
  // is worth less than a fast brief.
  const opts = { timeoutMs: 5_000 } as const;

  const head = await spawnGit(
    workspaceRoot,
    hardenedGitArgs(["rev-parse", "HEAD"]),
    sig,
    // An unborn branch exits 128 with "unknown revision"; that is an ANSWER
    // (no commits yet), not a failure.
    { ...opts, allowExitCodes: [128] },
  );
  if (!head.ok) return null;

  const status = await spawnGit(
    workspaceRoot,
    hardenedGitArgs([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]),
    sig,
    opts,
  );
  if (!status.ok) return null;

  const parsed = parseStatusPorcelainZ(status.stdout);
  const dirty: string[] = [];
  for (const f of parsed.files) {
    dirty.push(f.path);
    // A rename shows the NEW path; the OLD one is gone from the tree and is
    // just as much a change.
    if (f.origPath !== undefined) dirty.push(f.origPath);
  }
  const sha = head.stdout.trim();
  return {
    head: head.exitCode === 0 && sha.length > 0 ? sha : null,
    dirty,
  };
}
