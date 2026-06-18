'use client';

/**
 * PlatformSelector — segmented control for picking the active analytics/comments
 * platform.  Reuses the visual idiom from calendar-presenter.tsx's week/month
 * toggle (rounded-xl border border-white/5 bg-[#111] wrapper, rounded-lg
 * bg-[#222] active pill) so it matches the existing design system without
 * adding a dependency.
 *
 * Props:
 *   platforms  — ordered list of platforms to show (Facebook always first).
 *   value      — the currently selected platform.
 *   onChange   — called when the user clicks a different segment.
 *
 * Rendered only when `platforms.length > 1`; the parent components gate on that
 * condition so this component is never mounted in the single-platform (flags-off)
 * default, keeping the flags-off screen pixel-identical to today.
 */

import type { Platform } from '@/backend/insights/platforms/registry';
import { PLATFORM_LABELS } from '@/backend/insights/platforms/registry';
import { PlatformIcon } from './platform-icon';

export function PlatformSelector({
  platforms,
  value,
  onChange,
}: {
  platforms: Platform[];
  value: Platform;
  onChange: (p: Platform) => void;
}) {
  return (
    <div className="flex rounded-xl border border-white/5 bg-[#111] p-1">
      {platforms.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-all ${
            value === p
              ? 'rounded-lg bg-[#222] text-white shadow-lg'
              : 'text-zinc-400 hover:text-zinc-300'
          }`}
        >
          <span className="flex h-4 w-4 items-center justify-center">
            <PlatformIcon platform={p} size={12} />
          </span>
          {PLATFORM_LABELS[p]}
        </button>
      ))}
    </div>
  );
}
