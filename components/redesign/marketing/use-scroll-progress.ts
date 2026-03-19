'use client';

import type { RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function useSectionScrollProgress<T extends HTMLElement>(
  viewportOffset = 0.16,
): {
  ref: RefObject<T>;
  progress: number;
} {
  const ref = useRef<T>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let frameId = 0;

    const update = () => {
      const node = ref.current;

      if (!node) {
        return;
      }

      const rect = node.getBoundingClientRect();
      const viewportHeight = window.innerHeight || 1;
      const start = viewportHeight * viewportOffset;
      const travel = Math.max(rect.height - viewportHeight * 0.45, viewportHeight * 0.7);
      const next = clamp((start - rect.top) / travel);

      setProgress((current) => (Math.abs(current - next) < 0.001 ? current : next));
    };

    const requestUpdate = () => {
      cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(update);
    };

    requestUpdate();
    window.addEventListener('scroll', requestUpdate, { passive: true });
    window.addEventListener('resize', requestUpdate);

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener('scroll', requestUpdate);
      window.removeEventListener('resize', requestUpdate);
    };
  }, [viewportOffset]);

  return { ref, progress };
}

export function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setPrefersReducedMotion(mediaQuery.matches);

    onChange();
    mediaQuery.addEventListener('change', onChange);

    return () => {
      mediaQuery.removeEventListener('change', onChange);
    };
  }, []);

  return prefersReducedMotion;
}
