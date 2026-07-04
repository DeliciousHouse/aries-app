/**
 * In-page screenshot capture for the customer incident report dialog (AA-77).
 *
 * The original "Capture screen" used navigator.mediaDevices.getDisplayMedia() —
 * the screen-SHARE API. That inherently (1) pops the browser's window/tab/entire-
 * screen picker, (2) captures the whole shared surface rather than the page
 * behind the widget, and (3) is unsupported on mobile — so in practice it never
 * captured the actual error (AA-77: "captures incorrect portion of the screen").
 *
 * This replaces it with a DOM rasterization of the current page via html-to-image
 * (the browser's own SVG <foreignObject> renderer, so Tailwind v4 `oklch()`
 * colors and backdrop-blur render as the browser draws them): no picker, works
 * on mobile, and captures exactly "the page you're on". The feedback UI itself
 * (the modal, its backdrop, and the floating button) is excluded via the
 * `data-feedback-capture-ignore` marker so the shot shows the page BEHIND the
 * dialog, not our own chrome.
 *
 * Best-effort: any failure resolves null so the dialog degrades silently to the
 * file picker — the same contract the old getDisplayMedia path had on denial.
 */

/** Nodes carrying this attribute (and their subtrees) are omitted from the capture. */
export const CAPTURE_IGNORE_ATTR = 'data-feedback-capture-ignore';

/**
 * JPEG (not PNG) at viewport resolution keeps a full-page capture comfortably
 * under the report dialog's 2 MB screenshot cap even for tall pages; JPEG is in
 * the accepted MIME whitelist (image/jpeg).
 */
export const CAPTURE_JPEG_QUALITY = 0.82;

/** Opaque fallback fill when the page background can't be read (JPEG has no alpha). */
const CAPTURE_BG_FALLBACK = '#050505';

/**
 * html-to-image `filter` predicate: drop the feedback UI (the modal, its
 * backdrop, and the floating button) so the screenshot shows the page behind
 * it. Any node that IS — or is nested inside — a `[data-feedback-capture-ignore]`
 * element is excluded; everything else is kept. Non-element nodes (text) and
 * nodes without `closest` are kept.
 */
export function shouldCaptureNode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return true;
  const el = node as { nodeType?: number; closest?: (selector: string) => unknown };
  // Only Element nodes (nodeType 1) can carry the marker; text/comment nodes stay.
  if (el.nodeType !== 1 || typeof el.closest !== 'function') return true;
  return el.closest(`[${CAPTURE_IGNORE_ATTR}]`) == null;
}

type ToJpeg = (node: HTMLElement, options: Record<string, unknown>) => Promise<string>;

export interface PageCaptureDeps {
  /** Injectable for tests; defaults to a lazy html-to-image import (off the main bundle). */
  toJpeg?: ToJpeg;
}

/**
 * Rasterize the current page to a JPEG data URL, excluding the feedback UI.
 * Resolves null when there is no DOM, the capture throws, or the output is not a
 * JPEG data URL — the caller degrades to the file picker on null.
 */
export async function capturePageScreenshot(deps: PageCaptureDeps = {}): Promise<string | null> {
  if (typeof document === 'undefined' || !document.body) return null;
  try {
    const toJpeg: ToJpeg = deps.toJpeg ?? (await import('html-to-image')).toJpeg;
    const dataUrl = await toJpeg(document.body, {
      quality: CAPTURE_JPEG_QUALITY,
      // CSS-pixel resolution: plenty for a bug screenshot and keeps the encoded
      // size under the 2 MB cap even on tall pages and HiDPI displays.
      pixelRatio: 1,
      cacheBust: true,
      backgroundColor: getCaptureBackgroundColor(),
      filter: shouldCaptureNode,
    });
    return typeof dataUrl === 'string' && dataUrl.startsWith('data:image/jpeg') ? dataUrl : null;
  } catch {
    return null;
  }
}

/** True whenever an in-page capture is possible (any client DOM). */
export function pageCaptureSupported(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/** The page's own background so JPEG's opaque fill matches the app, not black. */
function getCaptureBackgroundColor(): string {
  try {
    if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
      return CAPTURE_BG_FALLBACK;
    }
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const bg = window.getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') return bg;
    }
  } catch {
    /* fall through to the fallback */
  }
  return CAPTURE_BG_FALLBACK;
}
