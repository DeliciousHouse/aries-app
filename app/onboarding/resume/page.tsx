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
  loadTenantTimezoneOrFallback,
  tenantHasStoredBusinessProfileState,
  updateBusinessProfileWithDiagnostics,
} from '@/backend/tenant/business-profile';
import { provisionDefaultMarketingSchedule } from '@/backend/marketing/schedule-store';
import { listSocialContentJobIdsForTenant } from '@/backend/marketing/runtime-state';
import { listMarketingReviewItemsForTenant } from '@/backend/marketing/runtime-views';
import { startSocialContentJob } from '@/backend/marketing/orchestrator';
import { startFirstPostVariantBatch } from '@/backend/marketing/onboarding-variant-batch';
import { isOnboardingVariantBoardEnabled } from '@/backend/onboarding/variant-board-env';
import { ensureSocialContentWorkspaceRecord } from '@/backend/marketing/workspace-store';

import OnboardingResumeFailed from './failed';
import OnboardingResumePending from './pending';

/**
 * Mint a short, human-quotable support handle and log it next to the real error.
 * Demo feedback (David, item 4): the user hit a server error and "moved too fast
 * to grab the error number" — there was none. Every failure on this page now
 * carries a reference that appears on screen AND in the server log.
 */
function logOnboardingResumeFailure(draftId: string, error: unknown): string {
  const reference = `ARS-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  console.error('[onboarding-resume] materialization failed', {
    reference,
    draftId,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  return reference;
}

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

/**
 * The account's single active membership, when it points at an organization
 * that has never been onboarded and that nobody else belongs to — i.e. the stub
 * created by a signup that filled in the optional "Organization" field.
 *
 * Returns null (so the caller falls through to the normal entitlement-gated
 * create) unless ALL of these hold:
 *   - exactly one active membership on the account
 *   - that membership is already `tenant_admin` (never an elevation)
 *   - the account is the org's only active member (never a hijack)
 *   - the org is reusable: no jobs, no stored business profile, no reviews
 */
async function findReusableStubTenant(
  client: PoolClient,
  userId: string,
): Promise<string | null> {
  const memberships = await client.query(
    `SELECT organization_id, role
       FROM organization_memberships
      WHERE user_id = $1 AND status = 'active'
      FOR UPDATE`,
    [Number(userId)],
  );

  if (memberships.rows.length !== 1) {
    return null;
  }

  const row = memberships.rows[0] as { organization_id: number | string; role?: string | null };
  if (row.role !== 'tenant_admin') {
    return null;
  }

  const organizationId = String(row.organization_id);

  const otherMembers = await client.query(
    `SELECT 1
       FROM organization_memberships
      WHERE organization_id = $1 AND status = 'active' AND user_id <> $2
      LIMIT 1`,
    [Number(organizationId), Number(userId)],
  );
  if ((otherMembers.rowCount ?? 0) > 0) {
    return null;
  }

  return (await tenantIsReusable(organizationId)) ? organizationId : null;
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
 * + Decision 13). "Onboard a business" creates a NEW org + a NEW admin
 * membership + sets it active, rather than repointing an org the user merely
 * belongs to (8a).
 *
 * ONE narrow exception, added after the demo: a never-onboarded STUB org that
 * this account solely admins is reused rather than counted as an existing
 * workspace (see findReusableStubTenant for the guards, and the call site for
 * why). Without it, filling in the optional "Organization" field at signup
 * paywalled the user's own first workspace.
 *
 * The `role:'tenant_admin'` force-set therefore only ever applies to the org the
 * user just created, or to that solely-owned stub — never an existing org they
 * merely belong to (8b — the self-escalation hole in the legacy reuse branch
 * stays closed). Because creating a workspace while the account already holds ≥1 active
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

    // Reuse a never-onboarded stub org before counting workspaces.
    //
    // A credentials signup that filled in the OPTIONAL "Organization" field
    // creates an organization plus an active tenant_admin membership before
    // onboarding ever runs (see registerUserAction). That stub is not a
    // workspace — no business profile, no jobs, no reviews — but
    // assertMultiWorkspaceEntitlement counts active memberships, so it read as
    // "this account already has one workspace". The result, on the free plan:
    // a brand-new user who typed their company name at signup got their FIRST
    // workspace denied and was redirected to the upgrade paywall seconds after
    // registering, stranding the draft. Reusing the stub is also what the
    // flag-OFF branch does.
    //
    // Decision 8b (no self-escalation) is preserved by the guards: we only
    // reuse when the account is ALREADY tenant_admin of the org and is its only
    // active member, so this can never repoint or elevate anyone into an org
    // that belongs to someone else.
    const stub = await findReusableStubTenant(client, input.userId);
    if (stub) {
      await assignUserToOrganization(client, {
        userId: input.userId,
        organizationId: stub,
        role: 'tenant_admin',
      });
      await client.query('COMMIT', []);
      return { status: 'ok', tenantId: stub };
    }

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
        brandVoice: claim.draft.brandVoice,
        notes: claim.draft.notes,
        competitorUrl: claim.draft.competitorUrl || null,
        channels: claim.draft.channels,
        // The user has just created their account; a website we cannot scrape
        // right now must not cost them the workspace. The profile row is saved
        // either way and the brand kit is re-derived on the first job.
        tolerateBrandKitFailure: true,
      });

      // Multi-brand workspaces Phase 1a: seed a default weekly cadence row for
      // every newly-materialized tenant so a cadence-settings card (1b) and the
      // weekly trigger worker have something to read/pick up. Best-effort and
      // NEVER blocks onboarding — flag-independent (runs for all onboarding
      // completions; the multi-workspace flag split lives upstream in
      // resolveTenantForDraft, not here). ON CONFLICT DO NOTHING makes this
      // safe to call unconditionally, including for a reused tenant.
      try {
        await provisionDefaultMarketingSchedule(client, {
          tenantId: Number(tenantId),
          timezone: loadTenantTimezoneOrFallback(tenantId),
        });
      } catch (scheduleError) {
        console.warn(
          `[onboarding-resume] provisionDefaultMarketingSchedule failed for tenant ${tenantId}:`,
          scheduleError,
        );
      }
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
      brandVoice: claim.draft.brandVoice,
      notes: claim.draft.notes,
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
      // Best-effort: if this reset itself fails the user still gets the recovery
      // screen rather than the bare 500 this catch used to rethrow.
      try {
        await updateOnboardingDraft(draftId, { status: 'ready_for_auth' });
      } catch (resetError) {
        console.error('[onboarding-resume] draft reset failed', { draftId, resetError });
      }
    }

    // Do NOT rethrow. Rethrowing here produced the demo's bare "server error":
    // the user had just created an account, and a failure anywhere in the
    // materialization chain (most often the brand-kit scrape of a slow or
    // unreachable customer website) blew up the whole render. The draft is
    // still intact and still reachable by id, so hand the user a recovery
    // screen that keeps the draft id — and a reference they can quote.
    const reference = logOnboardingResumeFailure(draftId, error);
    return <OnboardingResumeFailed draftId={draftId} reference={reference} />;
  }
}
