"use client";

// ─────────────────────────────────────────────────────────────────────────────
// LazyInsightSection.tsx — AA-123 (S7-5, gap D1)
//
// Defers a section's NETWORK REQUEST until it is near the viewport. It does not
// defer the section.
//
// That distinction is the whole design, and it is not theoretical: AA-152 was a
// regression in this repo where viewport-gated rendering meant content simply
// never appeared, and tests/homepage-progressive-rendering.regression-aa-152.test.ts
// exists to stop it recurring — "must render visibly in server HTML before
// JavaScript runs", "must not depend on IntersectionObserver or viewport state
// to appear".
//
// So this wrapper ALWAYS renders its children. What it controls is a single
// boolean handed to useInsight's `enabled`. A reader with JavaScript disabled,
// a crawler, or a browser without IntersectionObserver sees every section — the
// last case by fetching eagerly, which is the pre-AA-123 behaviour and
// therefore a safe fallback rather than a degraded one.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Start loading slightly BEFORE a section scrolls into view, so the data is
 * usually there by the time it is read. Large enough to hide the request on a
 * normal scroll; small enough that the sections furthest down still cost
 * nothing on first paint.
 */
export const LAZY_SECTION_ROOT_MARGIN = "600px";

export interface LazyInsightSectionProps {
  /** Receives `visible`, which the caller forwards to useInsight's `enabled`. */
  children: (visible: boolean) => ReactNode;
}

/**
 * True when this environment cannot observe intersections at all (SSR, jsdom,
 * older browsers). Such callers must fetch eagerly — never silently show
 * nothing.
 */
function canObserve(): boolean {
  return typeof window !== "undefined" && typeof window.IntersectionObserver === "function";
}

export function LazyInsightSection({ children }: LazyInsightSectionProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Default TRUE when we cannot observe: fail toward fetching, never toward a
  // permanently empty section.
  const [visible, setVisible] = useState(() => !canObserve());

  useEffect(() => {
    if (visible) return;
    const node = ref.current;
    if (!node || !canObserve()) {
      // The observer is unavailable (or the node never mounted) — fetch rather
      // than wait forever for an event that cannot arrive.
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          // One-way latch: once a section has been reached it stays enabled, so
          // scrolling past and back does not re-request data it already has.
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: LAZY_SECTION_ROOT_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  // The wrapper element is always in the document — it is what the observer
  // watches, and it is what guarantees the section's own markup renders
  // regardless of viewport state.
  return <div ref={ref}>{children(visible)}</div>;
}

export default LazyInsightSection;
