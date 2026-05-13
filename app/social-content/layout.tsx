import type { ReactNode } from 'react';

import AppShellLayout from '@/frontend/app-shell/layout';
import { enforceOnboardingGate } from '@/lib/onboarding-gate-server';

// QA 2026-05-13: the legacy /social-content/{new,status,review} URLs are
// still linked from campaign workspaces (campaign-workspace-state.ts
// ISSUE-009 fallback action). Without the shell, users land here with no
// global nav and get stuck. Wrap the segment so legacy surfaces inherit
// the same chrome as /dashboard/*.
export default async function SocialContentSegmentLayout({ children }: { children: ReactNode }) {
  await enforceOnboardingGate();
  return (
    <AppShellLayout currentRouteId="campaigns" loginRedirectPath="/social-content">
      {children}
    </AppShellLayout>
  );
}
