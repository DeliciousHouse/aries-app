import React from 'react';
import { redirect } from 'next/navigation';
import OnboardingStatusScreen from '../../../frontend/onboarding/status';

export default async function OnboardingStatusPage({
  searchParams
}: {
  searchParams?: Promise<{ tenant_id?: string; signup_event_id?: string }>;
}) {
  const resolved = await searchParams;
  const tenantId = resolved?.tenant_id || '';
  const signupEventId = resolved?.signup_event_id || '';
  // QA ISSUE-005 (2026-05-12): without a tenant or signup-event identifier this
  // page renders an empty "Inspect tenant provisioning progress" surface with no
  // call-to-action. Send the operator to the onboarding entry point instead.
  if (!tenantId && !signupEventId) {
    redirect('/onboarding/start');
  }
  return <OnboardingStatusScreen initialTenantId={tenantId} initialSignupEventId={signupEventId} />;
}
