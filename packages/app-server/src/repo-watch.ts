import { existsSync, type FSWatcher, readFileSync, watch } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Follow a repository's own state so the rail's repository card (ADR 0058)
 * learns of a commit, a checkout, a fetch, a merge or a `git add` made in a
 * terminal WHILE the app is visible — the case the focus refresh cannot
 * cover (two monitors, the terminal beside the app). ADR 0058 amendment,
 * 2026-09-07.
 *
 * Watched: the git dir's top level (HEAD, the index, ORIG_HEAD, MERGE_HEAD
 * and the other in-progress markers), the common dir's top level when the
 * workspace is a linked worktree (packed-refs lives there), and `refs/`
 * recursively (branches, remotes, tags). NEVER the working tree: a worktree
 * watcher would fire on every editor keystroke and on the harness's own
 * log writes under `.herta/`, and on Linux it costs an inotify handle per
 * directory. Two or three handles, non-persistent, no recursion below
 * `refs/`.
 *
 * The caller debounces: one git operation touches several of these files
 * inside a few milliseconds (`index.lock` → `index`, `HEAD.lock` → `HEAD`,
 * the ref, the reflog). The probe itself runs with `GIT_OPTIONAL_LOCKS=0`,
 * so its `git status` never writes the index and never wakes this watcher
 * — the loop that would otherwise close.
 *
 * Every failure is silent by design (a vanished dir, a platform without
 * recursive watch): the card keeps its other triggers.
 */
export type RepoWatcher = (gitDir: string, onChange: () => void) => () => void;

export const watchGitDir: RepoWatcher = (gitDir, onChange) => {
  const watchers: FSWatcher[] = [];
  const add = (dir: string, recursive: boolean): void => {
    try {
      const w = watch(dir, { persistent: false, recursive }, () => onChange());
      w.on("error", () => {
        try {
          w.close();
        } catch {
          // already closed
        }
      });
      watchers.push(w);
    } catch {
      // not watchable — the focus / turn-end / workspace-change triggers
      // still refresh the card
    }
  };
  add(gitDir, false);
  const common = commonDirOf(gitDir);
  if (common !== gitDir) add(common, false);
  add(join(common, "refs"), true);
  return () => {
    for (const w of watchers.splice(0)) {
      try {
        w.close();
      } catch {
        // already closed
      }
    }
  };
};

/** A linked worktree's git dir names the shared one in `commondir`
 *  (relative to itself); a main worktree's git dir IS the common dir. */
function commonDirOf(gitDir: string): string {
  try {
    const pointer = join(gitDir, "commondir");
    if (!existsSync(pointer)) return gitDir;
    const target = readFileSync(pointer, "utf8").trim();
    if (target.length === 0) return gitDir;
    return isAbsolute(target) ? target : resolve(gitDir, target);
  } catch {
    return gitDir;
  }
}

/** Trailing debounce for the watcher's bursts (see above). */
export const REPO_WATCH_DEBOUNCE_MS = 500;
