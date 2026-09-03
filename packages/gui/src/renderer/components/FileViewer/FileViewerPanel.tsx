import {
  lazy,
  type PointerEvent as ReactPointerEvent,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useSessionSelector } from "../../hooks/useSessionSelector.js";
import { useT } from "../../i18n/LocaleProvider.js";
import type {
  ReadWorkspaceBytesReply,
  ReadWorkspaceFileReply,
} from "../../ipc/bridge-types.js";
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
import { CodeView } from "./renderers/CodeView.js";
import { ImageView } from "./renderers/ImageView.js";
import { ViewerErrorBoundary } from "./renderers/ViewerErrorBoundary.js";
import {
  needsBytes,
  type ViewerKindInfo,
  viewerKindFor,
} from "./viewer-kind.js";

/**
 * The file-viewer panel (ADR 0050): read-only evidence beside the record.
 * Renders as the workspace grid's third track in docked mode (the rail
 * parked behind it) or as an absolute sheet in overlay mode — the
 * `.workspace-body` shell owns that distinction; this component is the
 * same DOM either way. v1.5: a bounded tab strip (open files), and line
 * anchors from finding cites (scroll + highlight band).
 *
 * ADR 0054: the file's KIND (by extension) picks the renderer — Markdown
 * as the page (with a source toggle), code with tokens, pictures, PDF,
 * Word, spreadsheets, decks. Rich kinds read bytes; each rich renderer is
 * its own lazy chunk behind an error boundary, so the base panel stays the
 * ADR 0050 text panel and a renderer failure is one honest notice.
 */

const MarkdownView = lazy(() =>
  import("./renderers/MarkdownView.js").then((m) => ({
    default: m.MarkdownView,
  })),
);
const CsvView = lazy(() =>
  import("./renderers/CsvView.js").then((m) => ({ default: m.CsvView })),
);
const PdfView = lazy(() =>
  import("./renderers/PdfView.js").then((m) => ({ default: m.PdfView })),
);
const DocxView = lazy(() =>
  import("./renderers/DocxView.js").then((m) => ({ default: m.DocxView })),
);
const SheetView = lazy(() =>
  import("./renderers/SheetView.js").then((m) => ({ default: m.SheetView })),
);
const SlidesView = lazy(() =>
  import("./renderers/SlidesView.js").then((m) => ({ default: m.SlidesView })),
);

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "text"; readonly reply: ReadWorkspaceFileReply }
  | { readonly kind: "bytes"; readonly reply: ReadWorkspaceBytesReply };

/** Markdown shows the page by default; a cite anchor forces the source
 *  (lines are a source concept). The header toggle overrides per tab. */
type ViewMode = "rendered" | "source";

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
  const target = v?.target ?? null;
  const path = target?.path ?? null;
  const anchor = target?.anchor;
  const kindInfo: ViewerKindInfo =
    path === null ? { kind: "text" } : viewerKindFor(path);
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [copied, setCopied] = useState(false);
  const [modes, setModes] = useState<Readonly<Record<string, ViewMode>>>({});
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setCopied(false);
    if (path === null || sessionId === null) return;
    let alive = true;
    setLoad({ kind: "loading" });
    const readText = bridge.readWorkspaceFile?.bind(bridge);
    const readBytes = bridge.readWorkspaceBytes?.bind(bridge);
    // A rich kind without the bytes read (an older bridge) takes the text
    // read and lands on its binary notice — the ADR 0050 behaviour.
    if (needsBytes(kindInfo.kind) && readBytes !== undefined) {
      readBytes(sessionId, path).then(
        (reply) => {
          if (alive) setLoad({ kind: "bytes", reply });
        },
        () => {
          if (alive)
            setLoad({
              kind: "bytes",
              reply: { ok: false, reason: "unreadable" },
            });
        },
      );
    } else if (readText === undefined) {
      setLoad({ kind: "text", reply: { ok: false, reason: "unreadable" } });
    } else {
      readText(sessionId, path).then(
        (reply) => {
          if (alive) setLoad({ kind: "text", reply });
        },
        () => {
          if (alive)
            setLoad({
              kind: "text",
              reply: { ok: false, reason: "unreadable" },
            });
        },
      );
    }
    return () => {
      alive = false;
    };
  }, [path, sessionId, bridge, kindInfo.kind]);

  // A new target for a path (a fresh cite) drops that path's toggle so the
  // anchor rule applies again.
  useEffect(() => {
    if (target === null) return;
    setModes((m) => {
      if (!(target.path in m)) return m;
      const next = { ...m };
      delete next[target.path];
      return next;
    });
  }, [target]);

  // Focus the panel on open so Escape works immediately; the opener (a
  // record row) keeps working for keyboard users because focus moves to a
  // labeled region, not into the void.
  useEffect(() => {
    if (path !== null) panelRef.current?.focus();
  }, [path]);

  const onDividerDown = useDividerDrag();

  if (v === null || path === null) return null;

  const relative =
    load.kind !== "loading" && load.reply.ok ? load.reply.relative : path;
  const activeName = tabName(v.tabs[v.active] ?? { path });
  const mode: ViewMode =
    modes[path] ?? (anchor !== undefined ? "source" : "rendered");
  const isMarkdown = kindInfo.kind === "markdown";

  return (
    <section
      ref={panelRef}
      className="file-viewer"
      data-testid="file-viewer"
      data-kind={kindInfo.kind}
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
          {isMarkdown && (
            <Tooltip
              label={
                mode === "rendered"
                  ? t("viewer.showSource")
                  : t("viewer.showRendered")
              }
              placement="bottom"
              align="center"
              portal
            >
              <button
                type="button"
                className={`file-viewer__action${mode === "source" ? " is-on" : ""}`}
                data-testid="viewer-toggle-source"
                aria-pressed={mode === "source"}
                aria-label={
                  mode === "rendered"
                    ? t("viewer.showSource")
                    : t("viewer.showRendered")
                }
                onClick={() =>
                  setModes((m) => ({
                    ...m,
                    [path]: mode === "rendered" ? "source" : "rendered",
                  }))
                }
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 13 13"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M4.5 3.5 1.5 6.5l3 3M8.5 3.5l3 3-3 3" />
                </svg>
              </button>
            </Tooltip>
          )}
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
      <FileViewerBody
        path={path}
        load={load}
        kindInfo={kindInfo}
        mode={mode}
        anchor={anchor}
      />
    </section>
  );
}

function Notice({ text }: { readonly text: string }): JSX.Element {
  return (
    <div className="file-viewer__body">
      <p className="file-viewer__notice">{text}</p>
    </div>
  );
}

function FileViewerBody({
  path,
  load,
  kindInfo,
  mode,
  anchor,
}: {
  readonly path: string;
  readonly load: LoadState;
  readonly kindInfo: ViewerKindInfo;
  readonly mode: ViewMode;
  readonly anchor?: ViewerAnchor | undefined;
}): JSX.Element {
  const t = useT();
  if (load.kind === "loading") {
    // A local read answers in single-digit milliseconds; a spinner would
    // only flash. Hold the empty body for the beat.
    return <div className="file-viewer__body" />;
  }
  const { reply } = load;
  if (!reply.ok) {
    const key =
      reply.reason === "not_found" || reply.reason === "not_a_file"
        ? "viewer.notFound"
        : reply.reason === "binary"
          ? "viewer.binary"
          : reply.reason === "outside_workspace"
            ? "viewer.outside"
            : reply.reason === "too_large"
              ? "viewer.tooLarge"
              : "viewer.unreadable";
    return <Notice text={t(key)} />;
  }
  const failed = <Notice text={t("viewer.renderFailed")} />;
  const pending = <div className="file-viewer__body" />;
  let body: JSX.Element;
  if (load.kind === "text") {
    const { content, truncated } = load.reply as Extract<
      ReadWorkspaceFileReply,
      { ok: true }
    >;
    switch (kindInfo.kind) {
      case "markdown":
        body =
          mode === "rendered" ? (
            <MarkdownView content={content} truncated={truncated} />
          ) : (
            <CodeView
              content={content}
              truncated={truncated}
              language="markdown"
              anchor={anchor}
            />
          );
        break;
      case "csv":
        body = <CsvView content={content} truncated={truncated} />;
        break;
      default:
        body = (
          <CodeView
            content={content}
            truncated={truncated}
            language={kindInfo.language}
            anchor={anchor}
          />
        );
        break;
    }
  } else {
    const { bytes } = load.reply as Extract<
      ReadWorkspaceBytesReply,
      { ok: true }
    >;
    switch (kindInfo.kind) {
      case "image":
        body = <ImageView bytes={bytes} path={path} />;
        break;
      case "pdf":
        body = <PdfView bytes={bytes} />;
        break;
      case "docx":
        body = <DocxView bytes={bytes} />;
        break;
      case "xlsx":
        body = <SheetView bytes={bytes} />;
        break;
      case "pptx":
        body = <SlidesView bytes={bytes} />;
        break;
      default:
        // A bytes reply for a text kind cannot happen (the read is chosen
        // by kind); the honest answer if it ever does is the notice.
        body = failed;
        break;
    }
  }
  return (
    <ViewerErrorBoundary key={`${path}:${mode}`} fallback={failed}>
      <Suspense fallback={pending}>{body}</Suspense>
    </ViewerErrorBoundary>
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
