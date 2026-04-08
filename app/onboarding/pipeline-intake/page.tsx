import { auth } from '@/auth';
import AriesOnboardingFlow from '@/frontend/aries-v1/onboarding-flow';

export default async function PipelineIntakePage() {
  const session = await auth();

  return <AriesOnboardingFlow initialAuthenticated={Boolean(session?.user?.id)} />;
}
