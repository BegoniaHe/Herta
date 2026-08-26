import type { RepoSnapshot } from "@herta/core";
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
