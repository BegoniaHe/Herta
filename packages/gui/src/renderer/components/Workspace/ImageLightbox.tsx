import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { attachmentImageUrl } from "../../../shared/attachment-image.js";
import { useSessionScoped } from "../../hooks/useSessionScoped.js";
import { useT } from "../../i18n/LocaleProvider.js";
import { OVERLAY_Z, useModalOverlay } from "../../lib/overlay-stack.js";

/**
 * Click-to-enlarge for attached pictures (ADR 0048 §4a, owner's Codex
 * reference 2026-08-27): a thumbnail — sent row or composer strip — opens
 * the full image in an in-app overlay with a −/percent/+ zoom pill.
 *
 * The pixels come through the same `herta-attachment://` scheme the thumbs
 * use; nothing new crosses the sandbox. Presentation only — the record is
 * untouched (D7).
 */
export interface LightboxImage {
  readonly path: string;
  readonly name: string;
  readonly caption?: string;
  /** Sniffed pixel dimensions when the digest knows them — the fit scale
   *  computes immediately instead of waiting for the bytes. */
  readonly width?: number;
  readonly height?: number;
}

const noop = (): void => {};
const LightboxContext = createContext<(img: LightboxImage) => void>(noop);

/** Stable opener — safe to read inside memoized rows (the value never
 *  changes identity, so it cannot invalidate them). */
export function useLightbox(): (img: LightboxImage) => void {
  return useContext(LightboxContext);
}

export function LightboxProvider({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  // Session-scoped, deliberately: an enlarged picture belongs to the session
  // it was opened in (the transient-state audit class) — its path would not
  // even resolve against another session's store. A switch closes it.
  const [image, setImage] = useSessionScoped<LightboxImage | null>(null);
  const open = useCallback((img: LightboxImage) => setImage(img), [setImage]);
  return (
    <LightboxContext.Provider value={open}>
      {children}
      {image !== null && (
        // Keyed by path: opening another picture while one is up remounts
        // the viewer, resetting zoom/fit for the new image.
        <ImageLightbox
          key={image.path}
          image={image}
          onClose={() => setImage(null)}
        />
      )}
    </LightboxContext.Provider>
  );
}

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 5;
const ZOOM_STEP = 1.25;
/** The viewport's CSS padding (keep in sync with .lightbox-viewport). The
 *  fit must subtract it: padding sits INSIDE clientWidth/Height, so a fit
 *  computed against the raw client box overflows by exactly the padding
 *  and shows scrollbars on a "fitted" image (seen live 2026-08-27). */
const VIEWPORT_PAD = 44;

function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

function ImageLightbox({
  image,
  onClose,
}: {
  readonly image: LightboxImage;
  readonly onClose: () => void;
}): JSX.Element {
  const t = useT();
  // Topmost-overlay coordination (the H1/H2 lesson): Escape here must not
  // reach — or be eaten by — the approval panel / settings underneath.
  const isTop = useModalOverlay("lightbox", true, OVERLAY_Z.lightbox);
  const viewportRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [natural, setNatural] = useState<{
    readonly w: number;
    readonly h: number;
  } | null>(
    image.width !== undefined && image.height !== undefined
      ? { w: image.width, h: image.height }
      : null,
  );
  // Scale vs natural pixels; null = fit not yet computed (the img renders
  // max-constrained until then, so there is no flash of a wrong size).
  const [zoom, setZoom] = useState<number | null>(null);

  // Fit once the natural size and the viewport are both known: the whole
  // picture visible, never upscaled past 100%.
  useEffect(() => {
    if (zoom !== null || natural === null) return;
    const vp = viewportRef.current;
    if (vp === null || vp.clientWidth === 0 || vp.clientHeight === 0) return;
    const w = Math.max(1, vp.clientWidth - VIEWPORT_PAD * 2);
    const h = Math.max(1, vp.clientHeight - VIEWPORT_PAD * 2);
    setZoom(clampZoom(Math.min(1, w / natural.w, h / natural.h)));
  }, [natural, zoom]);

  // Escape closes — only while this is the topmost overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && isTop) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // Keyboard users land inside the dialog (the close button), like the
  // key prompt focuses its input.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const step = (dir: 1 | -1): void =>
    setZoom((z) =>
      clampZoom((z ?? 1) * (dir === 1 ? ZOOM_STEP : 1 / ZOOM_STEP)),
    );

  return createPortal(
    <div
      className="lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      // The caption is what the picture IS — same rule as the thumb's alt.
      aria-label={image.caption ?? image.name}
      data-testid="lightbox"
    >
      {/* Clicking the dark ground closes; clicking the picture or the
          controls does not. mousedown, matching the settings backdrop — a
          drag that ends outside the image must not count as a click. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer convenience only — Escape and the labelled ✕ are the accessible close paths */}
      <div
        ref={viewportRef}
        className="lightbox-viewport"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <img
          className="lightbox-img"
          src={attachmentImageUrl(image.path)}
          alt={image.caption ?? image.name}
          title={image.name}
          draggable={false}
          style={
            zoom !== null && natural !== null
              ? { width: `${Math.round(natural.w * zoom)}px` }
              : undefined
          }
          onLoad={(e) => {
            if (natural !== null) return;
            const el = e.currentTarget;
            if (el.naturalWidth > 0 && el.naturalHeight > 0) {
              setNatural({ w: el.naturalWidth, h: el.naturalHeight });
            }
          }}
          // Double-click toggles 100% ↔ fit (fit recomputes via the effect).
          onDoubleClick={() => {
            setZoom((z) => (z !== null && Math.abs(z - 1) < 0.01 ? null : 1));
          }}
        />
      </div>
      <button
        ref={closeRef}
        type="button"
        className="lightbox-close"
        aria-label={t("lightbox.close")}
        onClick={onClose}
      >
        <svg
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
        </svg>
      </button>
      <div className="lightbox-zoom">
        <button
          type="button"
          className="lightbox-zoom__btn"
          aria-label={t("lightbox.zoomOut")}
          onClick={() => step(-1)}
        >
          −
        </button>
        <span className="lightbox-zoom__label" aria-live="polite">
          {zoom !== null ? `${Math.round(zoom * 100)}%` : " "}
        </span>
        <button
          type="button"
          className="lightbox-zoom__btn"
          aria-label={t("lightbox.zoomIn")}
          onClick={() => step(1)}
        >
          +
        </button>
      </div>
    </div>,
    document.body,
  );
}
