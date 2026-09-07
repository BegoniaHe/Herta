import type { RepoContextSnapshot } from "@herta/app-server";
import { useEffect } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import {
  useSessionScoped,
  useSessionScopedTimer,
} from "../../hooks/useSessionScoped.js";
import { useSessionSelector } from "../../hooks/useSessionSelector.js";
import { PLAN_SLIDE_MS } from "./usePlanCard.js";

/** Focus refreshes are throttled: a window that flickers focus (a dialog,
 *  an alt-tab and back) must not spawn a `git status` per flicker. */
export const REPO_FOCUS_REFRESH_MIN_MS = 2000;

/** Slack past the slide before the retracted card is dropped — the plan
 *  card's own reasoning (usePlanCard.ts). */
const REPO_UNMOUNT_SLACK_MS = 120;

export interface RepoCardState {
  /** The repository to draw, or null when the card should not be mounted. */
  readonly repo: RepoContextSnapshot | null;
  /** Whether the card should be slid OUT. */
  readonly open: boolean;
}

/**
 * The rail repository card's state (ADR 0058), derived from the active
 * session: the store's last repository answer, kept through the slide-out
 * so the card retracts with its content and is dropped only after the
 * slide (the plan card's two phases). A window focus asks the session to
 * probe again — the user came back from a terminal or an editor, and that
 * is when a commit made outside the app should already be on the card.
 */
export function useRepoCard(): RepoCardState {
  const repo = useSessionSelector((s) => s.repo);
  const sessionId = useSessionSelector((s) => s.sessionId);
  const { bridge } = useHertaBridge();
  const [shown, setShown] = useSessionScoped<RepoContextSnapshot | null>(null);
  const unmount = useSessionScopedTimer();

  useEffect(() => {
    if (repo !== null) {
      unmount.clear();
      setShown(repo);
      return;
    }
    unmount.arm(() => setShown(null), PLAN_SLIDE_MS + REPO_UNMOUNT_SLACK_MS);
  }, [repo, unmount, setShown]);

  useEffect(() => {
    const refresh = bridge.refreshRepo;
    if (refresh === undefined || sessionId === null) return;
    let last = 0;
    const onFocus = (): void => {
      const now = Date.now();
      if (now - last < REPO_FOCUS_REFRESH_MIN_MS) return;
      last = now;
      void refresh.call(bridge).catch(() => undefined);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [bridge, sessionId]);

  return { repo: shown, open: repo !== null };
}
