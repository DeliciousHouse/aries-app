"use client";

import Link from 'next/link';

import type { OnboardingStartSuccess } from '@/lib/api/onboarding';

export function buildOnboardingStatusHref(tenantId: string, signupEventId: string): string {
  return `/onboarding/status?tenant_id=${encodeURIComponent(tenantId)}&signup_event_id=${encodeURIComponent(signupEventId)}`;
}

export function resolveOnboardingStatusHref(
  result: Pick<OnboardingStartSuccess, 'tenant_id' | 'signup_event_id'> | null,
  fallbackTenantId: string,
  fallbackSignupEventId: string
): string {
  const tenantId = result?.tenant_id?.trim() || fallbackTenantId.trim();
  const signupEventId = result?.signup_event_id?.trim() || fallbackSignupEventId.trim();
  return buildOnboardingStatusHref(tenantId, signupEventId);
}

export default function OnboardingStartScreen(): JSX.Element {
  return (
    <div className="min-h-screen bg-background px-6 py-10 md:px-8 lg:px-10">
      <div className="mx-auto max-w-4xl">
        <div className="glass rounded-[2.5rem] p-8 md:p-10">
          <p className="text-xs uppercase tracking-[0.3em] text-primary mb-3">Internal tooling</p>
          <h1 className="text-4xl font-bold mb-3">Tenant onboarding tooling moved off the public path</h1>
          <p className="text-white/65 leading-relaxed">
            Public new-customer setup now starts from the premium intake so business context stays isolated through auth and workspace creation.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href="/onboarding/pipeline-intake"
              className="inline-flex items-center rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#11161c]"
            >
              Open premium intake
            </Link>
            <Link
              href="/onboarding/status"
              className="inline-flex items-center rounded-full border border-white/12 px-5 py-3 text-sm font-semibold text-white/80"
            >
              Open onboarding status
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
