'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

const POLL_INTERVAL_MS = 1500;
const STUCK_AFTER_MS = 45_000;

export default function OnboardingResumePending(): JSX.Element {
  const router = useRouter();
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    if (stuck) {
      return;
    }

    const intervalId = window.setInterval(() => {
      router.refresh();
    }, POLL_INTERVAL_MS);
    const stuckTimeout = window.setTimeout(() => {
      setStuck(true);
    }, STUCK_AFTER_MS);

    return () => {
      window.clearInterval(intervalId);
      window.clearTimeout(stuckTimeout);
    };
  }, [router, stuck]);

  return (
    <main className="min-h-screen bg-[#08070b] text-white">
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-6 text-center">
        <div className="h-16 w-16 rounded-full border border-white/12 bg-white/5" aria-hidden="true" />
        <p className="mt-6 text-xs uppercase tracking-[0.35em] text-white/45">Onboarding handoff</p>
        <div role="status" aria-live="polite" aria-atomic="true">
          {stuck ? (
            <>
              <h1 className="mt-4 text-4xl font-normal tracking-[-0.04em] text-white">
                The campaign service is taking longer than expected
              </h1>
              <p className="mt-4 max-w-xl text-sm leading-7 text-white/65">
                The workspace handoff hasn&apos;t completed yet. Your draft is saved. Try again,
                and if this keeps happening, contact support so we can investigate.
              </p>
            </>
          ) : (
            <>
              <h1 className="mt-4 text-4xl font-normal tracking-[-0.04em] text-white">
                Building your first campaign plan
              </h1>
              <p className="mt-4 max-w-xl text-sm leading-7 text-white/65">
                Aries is finishing the workspace handoff now. This page will refresh automatically and open the live
                workspace as soon as the campaign is ready.
              </p>
            </>
          )}
        </div>
        {stuck ? (
          <button
            type="button"
            onClick={() => {
              setStuck(false);
              router.refresh();
            }}
            className="mt-8 rounded-full border border-white/20 bg-white/5 px-6 py-2 text-sm text-white transition hover:bg-white/10"
          >
            Try again
          </button>
        ) : null}
      </div>
    </main>
  );
}
