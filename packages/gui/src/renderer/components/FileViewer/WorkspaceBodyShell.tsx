import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { FileViewerPanel } from "./FileViewerPanel.js";
import { useFileViewerState } from "./file-viewer-context.js";

/**
 * The `.workspace-body` grid, viewer-aware (ADR 0050 §3). Owns the one
 * measurement (a ResizeObserver on its own content box — window resizes,
 * sidebar toggles and maximize all land here) and the class/var pair the
 * CSS keys on: `viewer-docked` (mode A — third track opens, rail parks)
 * or `viewer-overlay` (threshold fallback — absolute sheet, nothing
 * reflows), with `--viewer-w` carrying the panel width either way.
 */
export function WorkspaceBodyShell({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const v = useFileViewerState();
  const ref = useRef<HTMLDivElement | null>(null);
  const setBodyWidth = v?.setBodyWidth;

  useEffect(() => {
    const el = ref.current;
    if (el === null || setBodyWidth === undefined) return;
    // Content-box width (the grid's own sizing base — padding excluded),
    // one source for both signals below.
    const measure = (): void => {
      const cs = getComputedStyle(el);
      const w =
        el.getBoundingClientRect().width -
        (Number.parseFloat(cs.paddingLeft) || 0) -
        (Number.parseFloat(cs.paddingRight) || 0);
      if (w > 0) setBodyWidth(w);
    };
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === "number" && w > 0) setBodyWidth(w);
    });
    ro.observe(el);
    // Belt-and-braces beside the observer (owner 2026-08-31: a
    // maximize→restore left the width un-reclamped): a window resize
    // re-measures directly, so the clamp can never depend on a single
    // delivery path. The CSS min() cap in the grid template is the hard
    // floor either way.
    window.addEventListener("resize", measure);
    measure();
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [setBodyWidth]);

  const cls =
    v?.open === true ? (v.docked ? " viewer-docked" : " viewer-overlay") : "";
  const style = {
    "--viewer-w": `${v?.widthPx ?? 0}px`,
  } as CSSProperties;
  return (
    <div ref={ref} className={`workspace-body${cls}`} style={style}>
      {children}
      <FileViewerPanel />
    </div>
  );
}
