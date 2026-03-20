'use client';
export { default } from './pipeline-intake';

// Backward-compat export used by tests
export function buildOnboardingStatusHref(tenantId: string, signupEventId: string): string {
  return `/onboarding/status?tenant_id=${encodeURIComponent(tenantId)}&signup_event_id=${encodeURIComponent(signupEventId)}`;
}

export function resolveOnboardingStatusHref(
  result: { tenant_id?: string; signup_event_id?: string } | null,
  fallbackTenantId: string,
  fallbackSignupEventId: string
): string {
  const tenantId = result?.tenant_id?.trim() || fallbackTenantId.trim();
  const signupEventId = result?.signup_event_id?.trim() || fallbackSignupEventId.trim();
  return buildOnboardingStatusHref(tenantId, signupEventId);
}
