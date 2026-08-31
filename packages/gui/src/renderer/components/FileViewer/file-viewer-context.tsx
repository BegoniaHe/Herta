import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useSessionScoped } from "../../hooks/useSessionScoped.js";

/**
 * The file-viewer panel's state (ADR 0050). Two contexts on purpose:
 *
 * - `FileViewerOpenContext` carries ONLY a stable opener (or null when the
 *   bridge cannot read files — the website demo). Record rows read this
 *   one, and its identity never changes, so the load-bearing
 *   record-identity memo chain (Conversation → ActivityBlock) is never
 *   invalidated by the panel opening — the same contract as
 *   `LightboxContext`.
 * - `FileViewerStateContext` carries the live state (target, width,
 *   docked/overlay) for the FEW consumers that must re-render with it:
 *   the panel, the workspace-body shell, and the rail's WebGL gates.
 */
export interface FileViewerState {
  /** The open file's record-spelled path, or null when closed. */
  readonly target: string | null;
  /** Panel width in px (docked track / overlay sheet alike). */
  readonly widthPx: number;
  /** Measured workspace-body content width; 0 before first measure. */
  readonly bodyWidth: number;
  /** Open in COLUMN mode — the rail is parked (mode A). False while the
   *  threshold fallback has degraded the panel to an overlay sheet. */
  readonly docked: boolean;
  /** Open in any mode. */
  readonly open: boolean;
  readonly close: () => void;
  readonly setWidthPx: (w: number) => void;
  readonly setBodyWidth: (w: number) => void;
}

const OpenContext = createContext<((path: string) => void) | null>(null);
const StateContext = createContext<FileViewerState | null>(null);

/** The stable opener, or null when file reads are unavailable (no bridge
 *  method — the demo) or no provider is mounted (bare component tests).
 *  Rows render a plain, non-clickable name on null. */
export function useFileViewerOpen(): ((path: string) => void) | null {
  return useContext(OpenContext);
}

/** Live panel state; null without a provider (bare tests). */
export function useFileViewerState(): FileViewerState | null {
  return useContext(StateContext);
}

/** True while the utility rail is parked behind the docked panel — the
 *  WebGL loops gate on this exactly as they gate on `disconnected`
 *  (ADR 0050 §4). */
export function useRailParked(): boolean {
  return useContext(StateContext)?.docked ?? false;
}

/** Conversation column minimum — MUST match the grid's minmax() in
 *  reference-ux.css. Exported for the clamp tests. */
export const CONVERSATION_MIN_PX = 560;
/** The conv|panel gap (the conversation's margin-right). */
export const VIEWER_GAP_PX = 24;
/** Panel minimum — below this the content is unreadable and the divider
 *  stops; the owner's "user must not be able to break the layout". */
export const VIEWER_MIN_PX = 320;
/** First-open default: the owner's picked 40% of the workspace. */
export const VIEWER_DEFAULT_FRACTION = 0.4;

const WIDTH_STORE_KEY = "herta.fileViewer.widthPx";

/** Clamp a requested panel width so the conversation keeps its minimum.
 *  When even the panel minimum cannot fit beside it, the caller degrades
 *  to overlay mode — this function only answers with a usable number. */
export function clampViewerWidth(requested: number, bodyWidth: number): number {
  const max = bodyWidth - CONVERSATION_MIN_PX - VIEWER_GAP_PX;
  return Math.round(
    Math.min(Math.max(requested, VIEWER_MIN_PX), Math.max(max, VIEWER_MIN_PX)),
  );
}

/** Column mode fits only when the panel minimum leaves the conversation
 *  its minimum; otherwise the panel overlays (ADR 0050 thresholds). */
export function viewerFitsDocked(widthPx: number, bodyWidth: number): boolean {
  return (
    bodyWidth > 0 && bodyWidth - widthPx - VIEWER_GAP_PX >= CONVERSATION_MIN_PX
  );
}

function readStoredWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(WIDTH_STORE_KEY);
    const n = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function FileViewerProvider({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  // Session-scoped, deliberately (the transient-state audit class): a file
  // belongs to the session whose record named it — a switch, delete, or
  // disconnect closes the panel rather than pointing it at another
  // session's workspace.
  const [target, setTarget] = useSessionScoped<string | null>(null);
  const [widthPx, setWidthState] = useState<number>(
    () => readStoredWidth() ?? 0,
  );
  const [bodyWidth, setBodyWidth] = useState(0);

  // Availability rides the CONTEXT bridge — the same object the demo and
  // the test mock inject — never window.herta directly. Without the
  // optional method (the website demo today), file names simply render as
  // plain text.
  const { bridge } = useHertaBridge();
  const available = bridge.readWorkspaceFile !== undefined;

  const openRef = useCallback((path: string) => setTarget(path), [setTarget]);
  const close = useCallback(() => setTarget(null), [setTarget]);
  const setWidthPx = useCallback((w: number) => {
    setWidthState(w);
    try {
      window.localStorage.setItem(WIDTH_STORE_KEY, String(Math.round(w)));
    } catch {
      // storage can be unavailable; the width just won't persist
    }
  }, []);

  const open = target !== null;
  // Width resolves lazily against the measured body: stored value if sane,
  // else the 40% default — re-clamped every render so a window resize or
  // sidebar toggle can never leave a stale overwide panel.
  const effectiveWidth =
    bodyWidth > 0
      ? clampViewerWidth(
          widthPx > 0 ? widthPx : bodyWidth * VIEWER_DEFAULT_FRACTION,
          bodyWidth,
        )
      : Math.max(widthPx, VIEWER_MIN_PX);
  const docked = open && viewerFitsDocked(effectiveWidth, bodyWidth);

  const state = useMemo<FileViewerState>(
    () => ({
      target,
      widthPx: effectiveWidth,
      bodyWidth,
      docked,
      open,
      close,
      setWidthPx,
      setBodyWidth,
    }),
    [target, effectiveWidth, bodyWidth, docked, open, close, setWidthPx],
  );

  return (
    <OpenContext.Provider value={available ? openRef : null}>
      <StateContext.Provider value={state}>{children}</StateContext.Provider>
    </OpenContext.Provider>
  );
}
