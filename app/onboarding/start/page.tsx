import { auth } from '@/auth';
import AriesOnboardingFlow from '@/frontend/aries-v1/onboarding-flow';

export default async function OnboardingStartPage() {
  const session = await auth();

  return <AriesOnboardingFlow initialAuthenticated={Boolean(session?.user?.id)} />;
}
