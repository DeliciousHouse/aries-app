'use client';

import { type JSX, useEffect, useState } from 'react';
import Link from 'next/link';

import type { OnboardingAdvisory } from '@/lib/onboarding-gate';

interface OnboardingNudgeBannerProps {
  advisories: ReadonlyArray<OnboardingAdvisory>;
  /**
   * Optional tenant identifier so dismissals are scoped per-tenant per-session.
   * If not provided, the banner uses a generic session key.
   */
  tenantId?: string | null;
}

function sessionKeyFor(advisory: OnboardingAdvisory, tenantId: string | null | undefined): string {
  return `aries:onboarding-advisory-dismissed:${tenantId ?? 'anon'}:${advisory.kind}`;
}

function defaultTitleFor(kind: OnboardingAdvisory['kind']): string {
  switch (kind) {
    case 'meta_not_connected':
      return 'Connect Meta to publish automatically';
    default:
      return 'Heads up';
  }
}

function defaultCtaLabelFor(kind: OnboardingAdvisory['kind']): string {
  switch (kind) {
    case 'meta_not_connected':
      return 'Connect Meta';
    default:
      return 'Open settings';
  }
}

export default function OnboardingNudgeBanner({
  advisories,
  tenantId,
}: OnboardingNudgeBannerProps): JSX.Element | null {
  const [dismissedKinds, setDismissedKinds] = useState<ReadonlyArray<string>>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
    if (typeof window === 'undefined') return;
    const next: string[] = [];
    for (const advisory of advisories) {
      try {
        if (window.sessionStorage.getItem(sessionKeyFor(advisory, tenantId)) === '1') {
          next.push(advisory.kind);
        }
      } catch {
        // sessionStorage may be unavailable (private mode); fall back to in-memory.
      }
    }
    setDismissedKinds(next);
  }, [advisories, tenantId]);

  if (!advisories || advisories.length === 0) {
    return null;
  }

  const visible = hydrated
    ? advisories.filter((a) => !dismissedKinds.includes(a.kind))
    : advisories;

  if (visible.length === 0) {
    return null;
  }

  return (
    <div className="mb-4 flex flex-col gap-2" data-testid="onboarding-nudge-banner">
      {visible.map((advisory) => {
        const severityClasses =
          advisory.severity === 'warning'
            ? 'border-amber-300 bg-amber-50 text-amber-900'
            : 'border-sky-300 bg-sky-50 text-sky-900';
        return (
          <div
            key={advisory.kind}
            role="status"
            className={`flex flex-col gap-2 rounded-lg border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between ${severityClasses}`}
          >
            <div className="flex flex-col">
              <span className="font-semibold">{defaultTitleFor(advisory.kind)}</span>
              <span className="text-sm">{advisory.message}</span>
            </div>
            <div className="flex items-center gap-3">
              <Link
                href={advisory.ctaHref}
                className="rounded-md border border-current bg-white/60 px-3 py-1.5 text-sm font-medium hover:bg-white"
              >
                {defaultCtaLabelFor(advisory.kind)}
              </Link>
              <button
                type="button"
                onClick={() => {
                  setDismissedKinds((prev) => [...prev, advisory.kind]);
                  if (typeof window !== 'undefined') {
                    try {
                      window.sessionStorage.setItem(sessionKeyFor(advisory, tenantId), '1');
                    } catch {
                      // ignore
                    }
                  }
                }}
                className="text-xs font-medium underline hover:no-underline"
              >
                Hide for now
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
