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
