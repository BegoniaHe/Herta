import type { LogEntry } from "@herta/app-server";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHertaBridge } from "../../../context/HertaBridgeContext.js";
import { useReducedMotion } from "../../../hooks/useReducedMotion.js";
import { useSessionSelector } from "../../../hooks/useSessionSelector.js";
import { useLocale, useT } from "../../../i18n/LocaleProvider.js";
import { useFileViewerOpen } from "../file-viewer-context.js";
import { formatCommitDate } from "./commit-patch.js";

/** Rows per page — the reader's own default (`LOG_PAGE_SIZE` in tools). */
export const LOG_PAGE = 50;

type Load =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly skip: number }
  | { readonly kind: "failed" };

/**
 * The repository's history beside the record (ADR 0059 §6): newest first,
 * a page at a time, each row the commit tab's opener, the commits not on
 * the upstream marked. The first page reloads when HEAD moves (a commit
 * lands while the tab is open), so the tab is as live as the card; later
 * pages append, and the appended rows ease in one after another.
 */
export function LogView(): JSX.Element {
  const t = useT();
  const { locale } = useLocale();
  const { bridge } = useHertaBridge();
  const reduced = useReducedMotion();
  const openFile = useFileViewerOpen();
  const sessionId = useSessionSelector((s) => s.sessionId);
  const repo = useSessionSelector((s) => s.repo);
  const head = repo?.headShort ?? null;

  const [entries, setEntries] = useState<readonly LogEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [upstream, setUpstream] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ kind: "idle" });
  /** Index from which rows are "new" this render — they stagger in. */
  const [freshFrom, setFreshFrom] = useState(0);
  const seq = useRef(0);

  const fetchPage = useCallback(
    (skip: number) => {
      const read = bridge.readWorkspaceLog?.bind(bridge);
      if (read === undefined || sessionId === null) {
        setLoad({ kind: "failed" });
        return;
      }
      seq.current += 1;
      const mine = seq.current;
      setLoad({ kind: "loading", skip });
      read(sessionId, skip, LOG_PAGE).then(
        (reply) => {
          if (mine !== seq.current) return;
          if (!reply.ok) {
            setLoad({ kind: "failed" });
            return;
          }
          setEntries((cur) =>
            skip === 0 ? reply.page.entries : [...cur, ...reply.page.entries],
          );
          setFreshFrom(skip);
          setHasMore(reply.page.hasMore);
          setUpstream(reply.page.upstream);
          setLoad({ kind: "idle" });
        },
        () => {
          if (mine === seq.current) setLoad({ kind: "failed" });
        },
      );
    },
    [bridge, sessionId],
  );

  // The first page — again whenever HEAD moves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `head` is the reload trigger, not a value the fetch reads.
  useEffect(() => {
    fetchPage(0);
  }, [fetchPage, head]);

  const branch =
    repo === null
      ? null
      : repo.branch !== null
        ? repo.branch
        : repo.detached
          ? t("repo.card.detached")
          : t("repo.card.unborn");

  return (
    <div className="file-viewer__body">
      <div
        className="file-viewer__scroll commit-view log-view"
        data-testid="log-view"
      >
        <header className="commit-view__head log-view__head">
          <p className="commit-view__meta">
            {branch !== null && (
              <span className="log-view__branch">{branch}</span>
            )}
            {upstream !== null && (
              <>
                <span className="commit-view__sep" aria-hidden="true">
                  ·
                </span>
                <span>{t("repo.card.upstream", { name: upstream })}</span>
              </>
            )}
          </p>
        </header>
        {entries.length === 0 && load.kind === "idle" && (
          <p className="file-viewer__notice">{t("repo.card.unborn")}</p>
        )}
        {load.kind === "failed" && entries.length === 0 && (
          <p className="file-viewer__notice">{t("viewer.log.notFound")}</p>
        )}
        <ol className="log-view__list">
          {entries.map((e, i) => {
            const fresh = !reduced && i >= freshFrom;
            return (
              <li
                key={e.sha}
                className={`log-view__row${e.unpushed ? " is-unpushed" : ""}${
                  fresh ? " is-entering" : ""
                }`}
                style={
                  fresh
                    ? {
                        animationDelay: `${Math.min(i - freshFrom, 24) * 18}ms`,
                      }
                    : undefined
                }
              >
                <button
                  type="button"
                  className="log-view__commit"
                  aria-label={`${t("activity.commit.openAria")} ${e.shortSha}`}
                  onClick={() =>
                    openFile?.(e.shortSha, {
                      kind: "commit",
                      label: e.shortSha,
                    })
                  }
                >
                  <span className="log-view__sha">{e.shortSha}</span>
                  <span className="log-view__subject" title={e.subject}>
                    {e.subject}
                  </span>
                  {e.unpushed && (
                    <span
                      className="log-view__unpushed"
                      title={t("repo.card.unpushed")}
                    >
                      ↑
                    </span>
                  )}
                  <span className="log-view__who">
                    {e.author}
                    <span className="commit-view__sep" aria-hidden="true">
                      ·
                    </span>
                    {formatCommitDate(e.authoredAt, locale)}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        {hasMore && (
          <button
            type="button"
            className="log-view__more"
            disabled={load.kind === "loading"}
            onClick={() => fetchPage(entries.length)}
          >
            {t("viewer.log.more")}
          </button>
        )}
        {!hasMore && entries.length > 0 && load.kind === "idle" && (
          <p className="file-viewer__notice log-view__end">
            {t("viewer.log.end")}
          </p>
        )}
      </div>
    </div>
  );
}
