import type { PoolClient } from 'pg';
import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import pool from '@/lib/db';
import {
  createOrganizationWithUniqueSlug,
  assignUserToOrganization,
  findTenantClaimsByUserId,
  slugFromIdentity,
} from '@/lib/auth-tenant-membership';
import { isMultiWorkspaceEnabled } from '@/backend/tenant/multi-workspace-env';
import { assertMultiWorkspaceEntitlement } from '@/backend/tenant/entitlements';
import { WORKSPACE_UPGRADE_PATH } from '@/backend/tenant/workspace-upgrade';
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

type ResolveTenantResult =
  | { status: 'ok'; tenantId: string }
  // Decision 13: a free account trying to create a SECOND workspace. Nothing is
  // created — the caller sends the user to the upgrade-required screen.
  | { status: 'requires_pro' };

async function resolveTenantForDraft(input: {
  userId: string;
  email: string;
  businessName: string;
  websiteUrl: string;
}): Promise<ResolveTenantResult> {
  const client = await pool.connect();
  try {
    if (isMultiWorkspaceEnabled()) {
      return await resolveTenantForDraftWithMemberships(client, input);
    }

    // Flag OFF: byte-identical to the pre-Phase-4 single-pointer behavior —
    // reuse the current org when it looks empty (repointing the pointer + role),
    // else create a new org and repoint.
    const currentClaims = await findTenantClaimsByUserId(client, input.userId);
    const currentTenantId = currentClaims?.tenant_id ? String(currentClaims.tenant_id) : null;

    if (currentTenantId && await tenantIsReusable(currentTenantId)) {
      await assignUserToOrganization(client, {
        userId: input.userId,
        organizationId: currentTenantId,
        role: 'tenant_admin',
      });
      return { status: 'ok', tenantId: currentTenantId };
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
    return { status: 'ok', tenantId: String(created.id) };
  } finally {
    client.release();
  }
}

/**
 * Flag-ON tenant resolution for onboarding (multi-workspace plan Decision 8a/8b
 * + Decision 13). "Onboard a business" ALWAYS creates a NEW org + a NEW admin
 * membership + sets it active — it NEVER reuses/repoints an existing org (8a).
 * The `role:'tenant_admin'` force-set therefore only ever applies to the org the
 * user just created, never an existing org they merely belong to (8b — the
 * self-escalation hole in the legacy reuse branch is gone because the branch is
 * gone). Because creating a workspace while the account already holds ≥1 active
 * membership is a SECOND-workspace attach, the Decision-13 entitlement check
 * gates it (this RSC mutates on render and is out of the Phase-3 header guard by
 * design, so the check is explicit here). It runs INSIDE the transaction that
 * creates the org + membership, counting active memberships FOR UPDATE, so a
 * free account's second workspace is denied (nothing created) and the caller
 * routes to the upgrade screen; the first workspace / a zero-membership account
 * stays free (the helper encodes "0 active memberships OR pro").
 */
async function resolveTenantForDraftWithMemberships(
  client: PoolClient,
  input: { userId: string; email: string; businessName: string; websiteUrl: string },
): Promise<ResolveTenantResult> {
  await client.query('BEGIN', []);
  try {
    // Serialize concurrent second-workspace creates for THIS account on the user
    // row BEFORE the entitlement count (Phase 4 review — zero-membership create
    // TOCTOU): assertMultiWorkspaceEntitlement's FOR UPDATE locks NOTHING when
    // the account has zero active memberships, so two simultaneous create
    // requests from a brand-new free account could otherwise both pass as "first
    // workspace" and mint two free workspaces. This create-path-local user-row
    // lock (deliberately NOT in the shared helper — the Phase-2 accept path
    // already locks the user row before the count) makes the second create block
    // until the first commits its membership, then correctly see 1 active
    // membership and be denied (free) / allowed (pro). Cheap: one indexed lock
    // on the account's own row, inside the txn that was already open.
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [Number(input.userId)]);

    const entitlement = await assertMultiWorkspaceEntitlement(client, input.userId);
    if (!entitlement.allowed) {
      await client.query('ROLLBACK', []);
      return { status: 'requires_pro' };
    }

    const created = await createOrganizationWithUniqueSlug(client, {
      name: input.businessName.trim() || input.email,
      slugBase: businessSlugBase(input),
    });
    // assignUserToOrganization repoints the active pointer + role mirror AND
    // dual-writes an 'active' admin membership for the just-created org. The
    // tenant_admin role is applied ONLY to this newly-created org.
    await assignUserToOrganization(client, {
      userId: input.userId,
      organizationId: created.id,
      role: 'tenant_admin',
    });
    await client.query('COMMIT', []);
    return { status: 'ok', tenantId: String(created.id) };
  } catch (error) {
    await client.query('ROLLBACK', []);
    throw error;
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
    const resolved = await resolveTenantForDraft({
      userId: session.user.id,
      email: session.user.email,
      businessName: claim.draft.businessName,
      websiteUrl: claim.draft.websiteUrl,
    });

    if (resolved.status === 'requires_pro') {
      // Decision 13: a free account tried to create a second workspace. No org
      // was created and the draft is left ready_for_auth (via the catch below is
      // not reached — reset explicitly here) so the user can resume after
      // upgrading. Route to the upgrade-required screen.
      await updateOnboardingDraft(draftId, { status: 'ready_for_auth' });
      redirect(WORKSPACE_UPGRADE_PATH);
    }

    const tenantId = resolved.tenantId;

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
