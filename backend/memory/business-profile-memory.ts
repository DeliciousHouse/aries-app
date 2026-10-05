import type { BusinessProfileView } from '@/backend/tenant/business-profile';
import { isHonchoEnabled } from './honcho-env';
import { TenantMemoryClient } from './honcho-client';
import { HonchoHttpTransport } from './honcho-http-transport';

export function businessProfileMemoryContent(profile: BusinessProfileView): string {
  const facts = {
    'Business name': profile.businessName, Website: profile.websiteUrl,
    'Business type': profile.businessType, 'Primary goal': profile.primaryGoal,
    'Goal type': profile.goalType, Offer: profile.offer, 'Brand voice': profile.brandVoice,
    'Launch approver': profile.launchApproverName, 'Launch approver user': profile.launchApproverUserId,
    'Style / vibe': profile.styleVibe, Notes: profile.notes, Competitor: profile.competitorUrl,
    Channels: profile.channels.join(', '), Timezone: profile.timezone, 'Reel audio': profile.reelAudioMode,
  };
  return [
    `Current operator-confirmed business profile as of ${new Date().toISOString()}.`,
    'This replaces earlier profile facts and preferences. Unset fields revoke earlier instructions for that field.',
    ...Object.entries(facts).map(([label, value]) => `${label}: ${value || '(unset)'}`),
  ].join('\n');
}

export async function updateBusinessProfileMemory(
  profile: BusinessProfileView,
  client = new TenantMemoryClient(new HonchoHttpTransport()),
): Promise<void> {
  if (!isHonchoEnabled(process.env)) return;
  const ctx = { tenantId: profile.tenantId, tenantSlug: profile.tenantSlug, userId: 'system', role: 'tenant_admin' as const };
  await client.ensureWorkspace(ctx);
  await client.appendObservation({
    ctx, peer: { kind: 'brand' }, session: { kind: 'onboarding', runId: `profile-${profile.tenantId}` },
    content: businessProfileMemoryContent(profile), metadata: { source: 'business_profile_edit' },
  });
}
