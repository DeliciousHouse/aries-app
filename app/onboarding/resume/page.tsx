import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import pool from '@/lib/db';
import {
  createOrganizationWithUniqueSlug,
  assignUserToOrganization,
  findTenantClaimsByUserId,
  slugFromIdentity,
} from '@/lib/auth-tenant-membership';
import { requireOnboardingDraft, updateOnboardingDraft } from '@/backend/onboarding/draft-store';
import {
  tenantHasStoredBusinessProfileState,
  updateBusinessProfileWithDiagnostics,
} from '@/backend/tenant/business-profile';
import { listMarketingJobIdsForTenant } from '@/backend/marketing/runtime-state';
import { listMarketingReviewItemsForTenant } from '@/backend/marketing/runtime-views';
import { startMarketingJob } from '@/backend/marketing/orchestrator';
import { ensureCampaignWorkspaceRecord } from '@/backend/marketing/workspace-store';

function businessSlugBase(input: { businessName: string; websiteUrl: string; email: string }): string {
  const trimmedBusinessName = input.businessName.trim();
  if (trimmedBusinessName) {
    return slugFromIdentity(trimmedBusinessName, input.email);
  }

  try {
    const hostname = new URL(input.websiteUrl).hostname.replace(/^www\./, '');
    return slugFromIdentity(hostname, input.email);
  } catch {
    return slugFromIdentity(undefined, input.email);
  }
}

async function tenantIsReusable(tenantId: string): Promise<boolean> {
  if (listMarketingJobIdsForTenant(tenantId).length > 0) {
    return false;
  }

  if (tenantHasStoredBusinessProfileState(tenantId)) {
    return false;
  }

  const reviews = await listMarketingReviewItemsForTenant(tenantId);
  return reviews.length === 0;
}

async function resolveTenantForDraft(input: {
  userId: string;
  email: string;
  businessName: string;
  websiteUrl: string;
}): Promise<string> {
  const client = await pool.connect();
  try {
    const currentClaims = await findTenantClaimsByUserId(client, input.userId);
    const currentTenantId = currentClaims?.tenant_id ? String(currentClaims.tenant_id) : null;

    if (currentTenantId && await tenantIsReusable(currentTenantId)) {
      await assignUserToOrganization(client, {
        userId: input.userId,
        organizationId: currentTenantId,
        role: 'tenant_admin',
      });
      return currentTenantId;
    }

    const created = await createOrganizationWithUniqueSlug(client, {
      name: input.businessName.trim() || input.email,
      slugBase: businessSlugBase(input),
    });
    await assignUserToOrganization(client, {
      userId: input.userId,
      organizationId: created.id,
      role: 'tenant_admin',
    });
    return String(created.id);
  } finally {
    client.release();
  }
}

export default async function OnboardingResumePage(
  { searchParams }: { searchParams: Promise<{ draft?: string }> }
) {
  const session = await auth();
  const resolvedSearchParams = await searchParams;
  const draftId = resolvedSearchParams.draft?.trim() || '';

  if (!draftId) {
    redirect('/onboarding/pipeline-intake');
  }

  if (!session?.user?.id || !session.user.email) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/onboarding/resume?draft=${encodeURIComponent(draftId)}`)}`);
  }

  const draft = await requireOnboardingDraft(draftId);
  if (draft.status === 'materialized' && draft.materializedJobId) {
    redirect(`/dashboard/campaigns/${encodeURIComponent(draft.materializedJobId)}?welcome=1`);
  }

  await updateOnboardingDraft(draftId, { status: 'materializing' });

  try {
    const tenantId = await resolveTenantForDraft({
      userId: session.user.id,
      email: session.user.email,
      businessName: draft.businessName,
      websiteUrl: draft.websiteUrl,
    });

    const client = await pool.connect();
    try {
      await updateBusinessProfileWithDiagnostics(client, {
        tenantId,
        businessName: draft.businessName,
        websiteUrl: draft.websiteUrl,
        businessType: draft.businessType,
        primaryGoal: draft.goal,
        launchApproverName: draft.approverName || null,
        offer: draft.offer || null,
        competitorUrl: draft.competitorUrl || null,
        channels: draft.channels,
      });
    } finally {
      client.release();
    }

    const payload = {
      brandUrl: draft.websiteUrl,
      websiteUrl: draft.websiteUrl,
      businessName: draft.businessName,
      businessType: draft.businessType,
      approverName: draft.approverName,
      launchApproverName: draft.approverName,
      competitorUrl: draft.competitorUrl,
      goal: draft.goal,
      primaryGoal: draft.goal,
      offer: draft.offer,
      notes: draft.preview?.description || '',
      channels: draft.channels,
      mode: 'guided',
    };

    const result = await startMarketingJob({
      tenantId,
      jobType: 'brand_campaign',
      payload,
    });

    ensureCampaignWorkspaceRecord({
      jobId: result.jobId,
      tenantId,
      payload,
    });

    await updateOnboardingDraft(draftId, {
      status: 'materialized',
      materializedTenantId: tenantId,
      materializedJobId: result.jobId,
    });

    redirect(`/dashboard/campaigns/${encodeURIComponent(result.jobId)}?welcome=1`);
  } catch (error) {
    await updateOnboardingDraft(draftId, { status: 'ready_for_auth' });
    throw error;
  }
}
