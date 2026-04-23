'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function OnboardingResumePending(): JSX.Element {
  const router = useRouter();

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      router.refresh();
    }, 1500);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [router]);

  return (
    <main className="min-h-screen bg-[#08070b] text-white">
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-6 text-center">
        <div className="h-16 w-16 rounded-full border border-white/12 bg-white/5" aria-hidden="true" />
        <p className="mt-6 text-xs uppercase tracking-[0.35em] text-white/45">Onboarding handoff</p>
        <h1 className="mt-4 text-4xl font-normal tracking-[-0.04em] text-white">
          Building your first campaign plan
        </h1>
        <p className="mt-4 max-w-xl text-sm leading-7 text-white/65">
          Aries is finishing the workspace handoff now. This page will refresh automatically and open the live
          workspace as soon as the campaign is ready.
        </p>
      </div>
    </main>
  );
}
