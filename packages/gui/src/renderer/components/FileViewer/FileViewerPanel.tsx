import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useSessionSelector } from "../../hooks/useSessionSelector.js";
import { useT } from "../../i18n/LocaleProvider.js";
import type { ReadWorkspaceFileReply } from "../../ipc/bridge-types.js";
import { Tooltip } from "../Tooltip/Tooltip.js";
import {
  CONVERSATION_MIN_PX,
  clampViewerWidth,
  type FileViewerTarget,
  useFileViewerState,
  VIEWER_GAP_PX,
  VIEWER_MIN_PX,
  type ViewerAnchor,
} from "./file-viewer-context.js";

/**
 * The file-viewer panel (ADR 0050): read-only evidence beside the record.
 * Renders as the workspace grid's third track in docked mode (the rail
 * parked behind it) or as an absolute sheet in overlay mode — the
 * `.workspace-body` shell owns that distinction; this component is the
 * same DOM either way. v1.5: a bounded tab strip (open files), and line
 * anchors from finding cites (scroll + highlight band).
 */

/** Rendered-line cap: a 1.5MB log is ~30k lines and 30k gutter rows of DOM
 *  helps nobody — the panel shows the head and says the file continues. */
const MAX_RENDER_LINES = 8_000;

/** Fallback line height when the computed style is unreadable (jsdom) —
 *  the CSS pins 12px × 1.6. */
const FALLBACK_LINE_H = 19.2;

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly reply: ReadWorkspaceFileReply };

function tabName(tab: FileViewerTarget): string {
  if (tab.label !== undefined) return tab.label;
  const parts = tab.path.split("/").filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? tab.path;
}

export function FileViewerPanel(): JSX.Element | null {
  const t = useT();
  const v = useFileViewerState();
  const { bridge } = useHertaBridge();
  const sessionId = useSessionSelector((s) => s.sessionId);
  const path = v?.target?.path ?? null;
  const anchor = v?.target?.anchor;
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [copied, setCopied] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setCopied(false);
    if (path === null || sessionId === null) return;
    let alive = true;
    setLoad({ kind: "loading" });
    const read = bridge.readWorkspaceFile?.bind(bridge);
    if (read === undefined) {
      setLoad({
        kind: "loaded",
        reply: { ok: false, reason: "unreadable" },
      });
      return;
    }
    read(sessionId, path).then(
      (reply) => {
        if (alive) setLoad({ kind: "loaded", reply });
      },
      () => {
        if (alive)
          setLoad({
            kind: "loaded",
            reply: { ok: false, reason: "unreadable" },
          });
      },
    );
    return () => {
      alive = false;
    };
  }, [path, sessionId, bridge]);

  // Focus the panel on open so Escape works immediately; the opener (a
  // record row) keeps working for keyboard users because focus moves to a
  // labeled region, not into the void.
  useEffect(() => {
    if (path !== null) panelRef.current?.focus();
  }, [path]);

  const onDividerDown = useDividerDrag();

  if (v === null || path === null) return null;

  const reply = load.kind === "loaded" ? load.reply : null;
  const relative = reply?.ok === true ? reply.relative : path;
  const activeName = tabName(v.tabs[v.active] ?? { path });

  return (
    <section
      ref={panelRef}
      className="file-viewer"
      data-testid="file-viewer"
      aria-label={activeName}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") v.close();
      }}
    >
      {/* Pointer-only resize affordance; the width also self-clamps on
          every resize, so no keyboard path is required to keep the layout
          sane. Hidden from the tree — it narrates nothing useful, and the
          col-resize cursor + hover line ARE the hint (no native title:
          the OS-beige tooltip mismatch, owner 2026-08-10/31). */}
      <div
        className="file-viewer__divider"
        aria-hidden="true"
        onPointerDown={onDividerDown}
      />
      <div className="file-viewer__head">
        {/* Open files as a bounded tab strip (ADR 0050 v1.5). Each chip's
            own × closes THAT file; the header × closes the whole panel. */}
        <div className="file-viewer__tabs" role="tablist">
          {v.tabs.map((tab, i) => (
            <span
              key={tab.path}
              className={`file-viewer__tab${i === v.active ? " is-active" : ""}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={i === v.active}
                className="file-viewer__tab-name"
                onClick={() => v.activateTab(i)}
              >
                {tabName(tab)}
              </button>
              <button
                type="button"
                className="file-viewer__tab-x"
                aria-label={`${t("viewer.closeTab")} ${tabName(tab)}`}
                onClick={() => v.closeTab(i)}
              >
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 9 9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M1.5 1.5l6 6M7.5 1.5l-6 6" />
                </svg>
              </button>
            </span>
          ))}
        </div>
        {/* The app's styled pill, not native `title` (owner 2026-08-31 — the
          same OS-beige mismatch the attachment ✕ had), and PORTALED so the
          panel's overflow clip can't cut it. */}
        <span className="file-viewer__actions">
          <Tooltip
            label={copied ? t("viewer.copied") : t("viewer.copyPath")}
            placement="bottom"
            align="center"
            portal
          >
            <button
              type="button"
              className="file-viewer__action"
              aria-label={t("viewer.copyPath")}
              onClick={() => {
                navigator.clipboard?.writeText(relative).then(
                  () => setCopied(true),
                  () => undefined,
                );
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 13 13"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                aria-hidden="true"
              >
                <rect x="4" y="4" width="7" height="7" rx="1.5" />
                <path d="M9 4V3a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 3v4.5A1.5 1.5 0 0 0 3 9h1" />
              </svg>
            </button>
          </Tooltip>
          <Tooltip
            label={t("viewer.openExternal")}
            placement="bottom"
            align="center"
            portal
          >
            <button
              type="button"
              className="file-viewer__action"
              aria-label={t("viewer.openExternal")}
              onClick={() => {
                if (sessionId !== null)
                  void bridge.openWorkspaceFile?.(sessionId, path);
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 13 13"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M5.5 2.5H3A1.5 1.5 0 0 0 1.5 4v6A1.5 1.5 0 0 0 3 11.5h6A1.5 1.5 0 0 0 10.5 10V7.5" />
                <path d="M7.5 1.5h4v4M11.2 1.8 6.5 6.5" />
              </svg>
            </button>
          </Tooltip>
          <Tooltip
            label={t("viewer.close")}
            placement="bottom"
            align="center"
            portal
          >
            <button
              type="button"
              className="file-viewer__action"
              aria-label={t("viewer.close")}
              onClick={v.close}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
              </svg>
            </button>
          </Tooltip>
        </span>
      </div>
      <FileViewerBody reply={reply} anchor={anchor} />
    </section>
  );
}

function FileViewerBody({
  reply,
  anchor,
}: {
  readonly reply: ReadWorkspaceFileReply | null;
  readonly anchor?: ViewerAnchor | undefined;
}): JSX.Element {
  const t = useT();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLPreElement | null>(null);
  const [band, setBand] = useState<{
    readonly top: number;
    readonly height: number;
  } | null>(null);

  const lineCount =
    reply?.ok === true
      ? Math.min(reply.content.split("\n").length, MAX_RENDER_LINES)
      : 0;

  // Cite anchor (ADR 0050 v1.5): a highlight band positioned by line
  // metrics, and a scroll that puts the cited lines a third of the way
  // down. Layout effect so the first paint already shows the band.
  useLayoutEffect(() => {
    if (reply?.ok !== true || anchor === undefined || anchor.from > lineCount) {
      setBand(null);
      return;
    }
    const scroller = scrollerRef.current;
    const text = textRef.current;
    if (scroller === null || text === null) return;
    const cs = getComputedStyle(text);
    const lh = Number.parseFloat(cs.lineHeight) || FALLBACK_LINE_H;
    const padTop = Number.parseFloat(cs.paddingTop) || 0;
    const from = Math.max(1, anchor.from);
    const to = Math.min(Math.max(anchor.to, from), lineCount);
    const top = padTop + (from - 1) * lh;
    setBand({ top, height: (to - from + 1) * lh });
    scroller.scrollTop = Math.max(0, top - scroller.clientHeight * 0.3);
  }, [reply, anchor, lineCount]);

  if (reply === null) {
    // A local read answers in single-digit milliseconds; a spinner would
    // only flash. Hold the empty body for the beat.
    return <div className="file-viewer__body" />;
  }
  if (!reply.ok) {
    const key =
      reply.reason === "not_found" || reply.reason === "not_a_file"
        ? "viewer.notFound"
        : reply.reason === "binary"
          ? "viewer.binary"
          : reply.reason === "outside_workspace"
            ? "viewer.outside"
            : "viewer.unreadable";
    return (
      <div className="file-viewer__body">
        <p className="file-viewer__notice">{t(key)}</p>
      </div>
    );
  }
  const allLines = reply.content.split("\n");
  const lines = allLines.slice(0, MAX_RENDER_LINES);
  const elided = allLines.length - lines.length;
  const gutter = lines.map((_, i) => i + 1).join("\n");
  return (
    <div className="file-viewer__body">
      <div ref={scrollerRef} className="file-viewer__code">
        <div className="file-viewer__code-inner">
          {band !== null && (
            <div
              className="file-viewer__anchor"
              style={{ top: band.top, height: band.height }}
              aria-hidden="true"
            />
          )}
          <pre className="file-viewer__gutter" aria-hidden="true">
            {gutter}
          </pre>
          <pre ref={textRef} className="file-viewer__text">
            {lines.join("\n")}
          </pre>
        </div>
      </div>
      {(reply.truncated || elided > 0) && (
        <p className="file-viewer__notice">{t("viewer.truncatedNote")}</p>
      )}
    </div>
  );
}

/** Divider drag: pointer-captured, transition-suppressed via the
 *  `is-resizing` class on the workspace-body, clamped so neither pane can
 *  break the layout (ADR 0050 — conversation ≥560px, panel ≥320px). */
function useDividerDrag(): (e: ReactPointerEvent<HTMLDivElement>) => void {
  const v = useFileViewerState();
  return useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (v === null) return;
      const divider = e.currentTarget;
      const body = divider.closest(".workspace-body");
      const startX = e.clientX;
      const startW = v.widthPx;
      // Capture is an enhancement (keeps the drag alive off the strip); a
      // capture failure must not abort the drag half-armed — pre-fix it
      // threw before the listeners attached and left `is-resizing` stuck
      // on the grid (caught live via a synthetic pointer, 2026-08-31).
      try {
        divider.setPointerCapture(e.pointerId);
      } catch {
        // fall through — window-level listeners below still track the drag
      }
      body?.classList.add("is-resizing");
      const onMove = (ev: PointerEvent): void => {
        const w = clampViewerWidth(startW + (startX - ev.clientX), v.bodyWidth);
        v.setWidthPx(w);
      };
      const onUp = (): void => {
        body?.classList.remove("is-resizing");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      // Window-level on purpose: a real drag leaves the 9px strip on its
      // first frame, and the capture above is best-effort.
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [v],
  );
}

// Re-exported so the shell (App) and tests share one source of the
// layout constants without importing the context module twice.
export { CONVERSATION_MIN_PX, VIEWER_GAP_PX, VIEWER_MIN_PX };
