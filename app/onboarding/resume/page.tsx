import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import pool from '@/lib/db';
import {
  createOrganizationWithUniqueSlug,
  assignUserToOrganization,
  findTenantClaimsByUserId,
  slugFromIdentity,
} from '@/lib/auth-tenant-membership';
import {
  claimOnboardingDraftMaterialization,
  updateOnboardingDraft,
} from '@/backend/onboarding/draft-store';
import {
  tenantHasStoredBusinessProfileState,
  updateBusinessProfileWithDiagnostics,
} from '@/backend/tenant/business-profile';
import { listSocialContentJobIdsForTenant } from '@/backend/marketing/runtime-state';
import { listMarketingReviewItemsForTenant } from '@/backend/marketing/runtime-views';
import { startSocialContentJob } from '@/backend/marketing/orchestrator';
import { startFirstPostVariantBatch } from '@/backend/marketing/onboarding-variant-batch';
import { isOnboardingVariantBoardEnabled } from '@/backend/onboarding/variant-board-env';
import { ensureSocialContentWorkspaceRecord } from '@/backend/marketing/workspace-store';

import OnboardingResumePending from './pending';

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
  if ((await listSocialContentJobIdsForTenant(tenantId)).length > 0) {
    return false;
  }

  if (await tenantHasStoredBusinessProfileState(tenantId)) {
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
    redirect('/onboarding/start');
  }

  if (!session?.user?.id || !session.user.email) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/onboarding/resume?draft=${encodeURIComponent(draftId)}`)}`);
  }

  const claim = await claimOnboardingDraftMaterialization(draftId);
  if (claim.draft.status === 'materialized' && claim.draft.materializedJobId) {
    const materializedId = claim.draft.materializedJobId;
    // A variant batch id (vbatch_*) routes back to the board; a normal job id to
    // the dashboard.
    redirect(
      materializedId.startsWith('vbatch_')
        ? `/onboarding/variants/${encodeURIComponent(materializedId)}`
        : `/dashboard/social-content/${encodeURIComponent(materializedId)}?welcome=1`,
    );
  }

  if (!claim.claimed) {
    return <OnboardingResumePending />;
  }

  // Set once the variant batch is pinned to the draft (see onBatchCreated below):
  // from that point a failure must not reset the draft, or a revisit re-fans out.
  let variantBatchStarted = false;

  try {
    const tenantId = await resolveTenantForDraft({
      userId: session.user.id,
      email: session.user.email,
      businessName: claim.draft.businessName,
      websiteUrl: claim.draft.websiteUrl,
    });

    const client = await pool.connect();
    try {
      await updateBusinessProfileWithDiagnostics(client, {
        tenantId,
        businessName: claim.draft.businessName,
        websiteUrl: claim.draft.websiteUrl,
        businessType: claim.draft.businessType,
        primaryGoal: claim.draft.goal,
        launchApproverName: claim.draft.approverName || null,
        offer: claim.draft.offer || null,
        competitorUrl: claim.draft.competitorUrl || null,
        channels: claim.draft.channels,
      });
    } finally {
      client.release();
    }

    const payload = {
      brandUrl: claim.draft.websiteUrl,
      websiteUrl: claim.draft.websiteUrl,
      businessName: claim.draft.businessName,
      businessType: claim.draft.businessType,
      approverName: claim.draft.approverName,
      launchApproverName: claim.draft.approverName,
      competitorUrl: claim.draft.competitorUrl,
      goal: claim.draft.goal,
      primaryGoal: claim.draft.goal,
      offer: claim.draft.offer,
      notes: claim.draft.preview?.description || '',
      channels: claim.draft.channels,
      mode: 'guided',
    };

    // Flag ON: the first post becomes a 3-variant board. Fan out the variants,
    // materialize the draft against the batch id, and send the user to the board.
    // Flag OFF: the existing single weekly job — byte-identical to before.
    if (isOnboardingVariantBoardEnabled()) {
      const batch = await startFirstPostVariantBatch({
        tenantId,
        createdBy: session.user.id,
        payload,
        // Pin the draft to the batch BEFORE any job submits, so a later submit
        // failure leaves a recoverable pointer (a revisit routes back to the
        // board) instead of re-running the 3-job fan-out and orphaning jobs.
        onBatchCreated: async (batchId) => {
          variantBatchStarted = true;
          await updateOnboardingDraft(draftId, {
            status: 'materialized',
            materializedTenantId: tenantId,
            materializedJobId: batchId,
          });
        },
      });
      redirect(`/onboarding/variants/${encodeURIComponent(batch.variantBatchId)}`);
    }

    const result = await startSocialContentJob({
      tenantId,
      jobType: 'weekly_social_content',
      createdBy: session.user.id,
      payload,
    });

    await ensureSocialContentWorkspaceRecord({
      jobId: result.jobId,
      tenantId,
      payload,
    });

    await updateOnboardingDraft(draftId, {
      status: 'materialized',
      materializedTenantId: tenantId,
      materializedJobId: result.jobId,
    });

    redirect(`/dashboard/social-content/${encodeURIComponent(result.jobId)}?welcome=1`);
  } catch (error) {
    // redirect() throws NEXT_REDIRECT as control flow — a successful redirect must
    // NOT reset the (already-materialized) draft, or a revisit would re-materialize
    // and re-run the job/variant fan-out. Only reset on a genuine failure.
    const digest = (error as { digest?: unknown } | null)?.digest;
    if (typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT')) {
      throw error;
    }
    // Once a variant batch is pinned to the draft (materialized), a later failure
    // must NOT reset to ready_for_auth — a revisit would re-run the 3-job fan-out
    // and orphan the live jobs. The board recovers (renders what landed, times out).
    if (!variantBatchStarted) {
      await updateOnboardingDraft(draftId, { status: 'ready_for_auth' });
    }
    throw error;
  }
}
