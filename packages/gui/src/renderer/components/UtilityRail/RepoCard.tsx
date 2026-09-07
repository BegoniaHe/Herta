import type {
  RepoContextDirtyFile,
  RepoContextSnapshot,
  RepoInProgressState,
} from "@herta/app-server";
import {
  repoPathInsideWorkspace,
  workspaceRelativeRepoPath,
} from "@herta/core/repo-path";
import { useRef } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import type { MessageKey } from "../../i18n/keys.js";
import { useT } from "../../i18n/LocaleProvider.js";
import { useFileViewerOpen } from "../FileViewer/file-viewer-context.js";
import { useScrollEdges } from "../Workspace/useScrollEdges.js";
import { useRepoCard } from "./useRepoCard.js";

/**
 * The workspace's repository as a rail card (ADR 0058), under the device:
 * the branch and where it stands against its upstream, an operation left
 * mid-flight (a merge, a rebase), the uncommitted files, and the last
 * commit. What the backend frame already knows at every dispatch (ADR
 * 0049 §2), now in the user's own column — read without asking.
 *
 * Rides the .plan-card chrome (glass, slide, fog, mark) so the rail keeps
 * one card family; the `repo-card` variant carries what differs. Facts
 * only, stated in FORM (the 2026-07-27 rule): nothing here moves. Paths
 * are spelled from the WORKSPACE (git spells them from the repository's
 * root; a workspace that is a subfolder sees `../` for what lies beside
 * it — ADR 0058 amendment) and open in the file viewer where the bridge
 * can read them (ADR 0050): inside the workspace only. The last commit
 * opens as a commit tab (ADR 0059).
 */
export function RepoCard(): JSX.Element | null {
  const t = useT();
  const { repo, open } = useRepoCard();
  const openFile = useFileViewerOpen();
  const { bridge } = useHertaBridge();
  // A dirty row opens its DIFF where the bridge can read one (ADR 0059
  // §5), the file where it cannot (an older bridge, the demo).
  const diffs = bridge.readWorkspaceDiff !== undefined;
  const listRef = useRef<HTMLOListElement>(null);
  const edges = useScrollEdges(listRef, repo);
  const logRef = useRef<HTMLOListElement>(null);
  const logEdges = useScrollEdges(logRef, repo);

  if (repo === null) return null;

  const branchLabel =
    repo.branch !== null
      ? repo.branch
      : repo.detached
        ? t("repo.card.detached")
        : t("repo.card.unborn");
  const branchTitle =
    repo.headShort !== null
      ? `${branchLabel} · ${repo.headShort}`
      : branchLabel;
  const deltaParts: string[] = [];
  if (repo.ahead > 0) deltaParts.push(`↑${repo.ahead}`);
  if (repo.behind > 0) deltaParts.push(`↓${repo.behind}`);
  const deltaTitle = [
    repo.ahead > 0 ? t("repo.card.ahead", { n: String(repo.ahead) }) : null,
    repo.behind > 0 ? t("repo.card.behind", { n: String(repo.behind) }) : null,
  ]
    .filter((s) => s !== null)
    .join(" · ");
  const count =
    repo.dirtyTotal === 0
      ? t("repo.card.clean")
      : t("repo.card.dirty", { n: String(repo.dirtyTotal) });
  const hidden = repo.dirtyTotal - repo.dirty.length;
  const prefix = repo.prefix;
  const recent = repo.recentSubjects.map(parseSubject);

  return (
    <section
      className={`plan-card repo-card${open ? " is-open" : ""}`}
      data-testid="repo-card"
      aria-label={t("repo.card.title")}
      aria-hidden={!open}
    >
      <header className="plan-card__head">
        <span className="plan-card__title">{t("repo.card.title")}</span>
        <span className="plan-card__count">{count}</span>
      </header>
      <div className="repo-card__branch">
        <span className="repo-card__branch-name" title={branchTitle}>
          {branchLabel}
        </span>
        {repo.upstream !== null && (
          <span
            className="repo-card__upstream"
            title={t("repo.card.upstream", { name: repo.upstream })}
          >
            {repo.upstream}
          </span>
        )}
        {deltaParts.length > 0 && (
          <span className="repo-card__delta" title={deltaTitle}>
            {deltaParts.join(" ")}
          </span>
        )}
      </div>
      {prefix.length > 0 && (
        <p className="repo-card__scope" title={repo.root}>
          {t("repo.card.scope", { prefix })}
        </p>
      )}
      {repo.inProgress !== null && (
        <p className="repo-card__flag">
          {t(IN_PROGRESS_KEY[repo.inProgress])}
          {repo.conflicted.length > 0 &&
            ` · ${t("repo.card.conflicts", { n: String(repo.conflicted.length) })}`}
        </p>
      )}
      {repo.dirty.length > 0 && (
        <ol
          ref={listRef}
          className={`plan-card__list repo-card__list${
            edges.top ? " has-fog-top" : ""
          }${edges.bottom ? " has-fog-bottom" : ""}`}
        >
          {repo.dirty.map((file) => {
            const mark = dirtyMark(file);
            const shown = workspaceRelativeRepoPath(file.path, prefix);
            const inside = repoPathInsideWorkspace(file.path, prefix);
            return (
              <li
                key={file.path}
                className={`plan-card__row repo-card__row is-${mark.kind}${
                  inside ? "" : " is-outside"
                }`}
              >
                <span
                  className="plan-card__mark"
                  title={t(STATUS_KEY[mark.kind])}
                >
                  {mark.glyph}
                </span>
                {openFile !== null && inside ? (
                  <button
                    type="button"
                    className="repo-card__path"
                    title={file.path}
                    aria-label={`${
                      diffs && mark.kind !== "conflict"
                        ? t("activity.diff.openAria")
                        : t("activity.file.openAria")
                    } ${shown}`}
                    onClick={() =>
                      // A conflict's markers live in the file itself; every
                      // other change reads best as its diff against HEAD.
                      diffs && mark.kind !== "conflict"
                        ? openFile(shown, { kind: "diff" })
                        : openFile(shown)
                    }
                  >
                    {shown}
                  </button>
                ) : (
                  <span
                    className="repo-card__path"
                    title={
                      inside
                        ? file.path
                        : `${file.path} · ${t("viewer.outside")}`
                    }
                  >
                    {shown}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {hidden > 0 && (
        <p className="repo-card__more">
          {t("repo.card.more", { n: String(hidden) })}
        </p>
      )}
      {recent.length > 0 && (
        <>
          <p className="repo-card__section">{t("repo.card.recent")}</p>
          <ol
            ref={logRef}
            className={`plan-card__list repo-card__log${
              logEdges.top ? " has-fog-top" : ""
            }${logEdges.bottom ? " has-fog-bottom" : ""}`}
          >
            {recent.map((c) => {
              const sha = c.sha;
              return (
                <li
                  key={c.line}
                  className="plan-card__row repo-card__row repo-card__log-row"
                >
                  {sha !== null && (
                    <span className="plan-card__mark repo-card__sha">
                      {sha}
                    </span>
                  )}
                  {openFile !== null && sha !== null ? (
                    <button
                      type="button"
                      className="repo-card__path repo-card__subject"
                      title={c.line}
                      aria-label={`${t("activity.commit.openAria")} ${sha}`}
                      onClick={() =>
                        openFile(sha, { kind: "commit", label: sha })
                      }
                    >
                      {c.subject}
                    </button>
                  ) : (
                    <span
                      className="repo-card__path repo-card__subject"
                      title={c.line}
                    >
                      {c.subject}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}

/**
 * A `git log --oneline --no-decorate` line as the card draws it (ADR 0058
 * §5.4): the abbreviated id, then the subject. A line that does not start
 * with a hex id (it cannot, with `--no-decorate` — but the probe is the
 * only writer and this is the reader's guard) renders whole and plain.
 * Exported for tests.
 */
export function parseSubject(line: string): {
  readonly line: string;
  readonly sha: string | null;
  readonly subject: string;
} {
  const m = /^([0-9a-f]{4,40}) (.*)$/.exec(line);
  if (m === null || m[1] === undefined || m[2] === undefined)
    return { line, sha: null, subject: line };
  return { line, sha: m[1], subject: m[2] };
}

export type DirtyMarkKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict"
  | "other";

/**
 * One glyph per porcelain status pair — the worktree column when it says
 * something, the index column otherwise: what `git status --short` shows,
 * read the way a person reads it. Conflicts and untracked files are their
 * own kinds because they mean something different from an edit.
 */
export function dirtyMark(file: RepoContextDirtyFile): {
  readonly kind: DirtyMarkKind;
  readonly glyph: string;
} {
  const { x, y } = file;
  if (x === "?") return { kind: "untracked", glyph: "?" };
  if (
    x === "U" ||
    y === "U" ||
    (x === "A" && y === "A") ||
    (x === "D" && y === "D")
  ) {
    return { kind: "conflict", glyph: "!" };
  }
  const code = y !== " " && y !== "" ? y : x;
  switch (code) {
    case "M":
    case "T":
      return { kind: "modified", glyph: "M" };
    case "A":
      return { kind: "added", glyph: "A" };
    case "D":
      return { kind: "deleted", glyph: "D" };
    case "R":
    case "C":
      return { kind: "renamed", glyph: "R" };
    default:
      return { kind: "other", glyph: code.length > 0 ? code : "·" };
  }
}

const STATUS_KEY: Record<DirtyMarkKind, MessageKey> = {
  modified: "repo.card.status.modified",
  added: "repo.card.status.added",
  deleted: "repo.card.status.deleted",
  renamed: "repo.card.status.renamed",
  untracked: "repo.card.status.untracked",
  conflict: "repo.card.status.conflict",
  other: "repo.card.status.other",
};

const IN_PROGRESS_KEY: Record<RepoInProgressState, MessageKey> = {
  merge: "repo.card.inProgress.merge",
  rebase: "repo.card.inProgress.rebase",
  "cherry-pick": "repo.card.inProgress.cherryPick",
  revert: "repo.card.inProgress.revert",
  bisect: "repo.card.inProgress.bisect",
};

/** Exported for tests and the ADR's example. */
export type { RepoContextSnapshot };
