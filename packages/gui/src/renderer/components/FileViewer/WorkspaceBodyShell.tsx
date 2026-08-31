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
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === "number") setBodyWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
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
