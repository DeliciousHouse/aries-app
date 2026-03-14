import React from 'react';
import OnboardingStatusScreen from '../../../frontend/onboarding/status';

export default async function OnboardingStatusPage({
  searchParams
}: {
  searchParams?: Promise<{ tenant_id?: string; signup_event_id?: string }>;
}) {
  const resolved = await searchParams;
  const tenantId = resolved?.tenant_id || '';
  const signupEventId = resolved?.signup_event_id || '';
  return <OnboardingStatusScreen initialTenantId={tenantId} initialSignupEventId={signupEventId} />;
}
