import type { ReactNode } from 'react';

import { enforceOnboardingGate } from '@/lib/onboarding-gate-server';

export default async function SocialContentSegmentLayout({ children }: { children: ReactNode }) {
  await enforceOnboardingGate();
  return <>{children}</>;
}
