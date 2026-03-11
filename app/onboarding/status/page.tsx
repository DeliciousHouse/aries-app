import OnboardingStatusScreen from '../../../frontend/onboarding/status';

export default async function OnboardingStatusPage({
  searchParams
}: {
  searchParams?: Promise<{ tenant_id?: string }>;
}) {
  const resolved = await searchParams;
  const tenantId = resolved?.tenant_id || '';
  return <OnboardingStatusScreen initialTenantId={tenantId} />;
}
