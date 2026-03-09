import OnboardingStatusScreen from '../../../frontend/onboarding/status';

export default function OnboardingStatusPage({
  searchParams
}: {
  searchParams?: { tenant_id?: string };
}) {
  const tenantId = searchParams?.tenant_id || '';
  return <OnboardingStatusScreen initialTenantId={tenantId} />;
}
