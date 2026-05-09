import type { PoolClient } from 'pg';

import { getBusinessProfileWithDiagnostics } from '@/backend/tenant/business-profile';
import type { TenantContext } from '@/lib/tenant-context';

import { buildOnboardingCandidatesFromProfile } from './build-onboarding-candidates';
import { TenantMemoryClient } from './honcho-client';
import { HonchoHttpTransport } from './honcho-http-transport';
import { seedOnboardingMemory } from './onboarding-seed';
import { isAriesResearchEnabled } from './research-env';

type MinimalCtx = Pick<TenantContext, 'tenantId' | 'tenantSlug' | 'userId' | 'role'>;

/**
 * Ensures organizations.onboarding_memory_seeded_at exists (idempotent DDL).
 */
export async function ensureOnboardingMemorySeedColumn(client: Pick<PoolClient, 'query'>): Promise<void> {
  await client.query(
    `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS onboarding_memory_seeded_at TIMESTAMPTZ`,
    [],
  );
}

/**
 * After dashboard onboarding gate passes, promote first-party profile facts into
 * Honcho tenant memory once per organization (gated by ARIES_RESEARCH_ENABLED).
 */
export async function maybeSeedOnboardingMemoryForTenant(
  client: PoolClient,
  tenantCtx: MinimalCtx,
): Promise<void> {
  if (!isAriesResearchEnabled(process.env)) {
    return;
  }

  const orgId = Number(tenantCtx.tenantId);
  if (!Number.isFinite(orgId) || orgId <= 0) {
    return;
  }

  await ensureOnboardingMemorySeedColumn(client);

  const claim = await client.query(
    `
    UPDATE organizations
    SET onboarding_memory_seeded_at = NOW()
    WHERE id = $1 AND onboarding_memory_seeded_at IS NULL
    RETURNING id
    `,
    [orgId],
  );
  if (claim.rowCount === 0) {
    return;
  }

  const resolved = await getBusinessProfileWithDiagnostics(client, tenantCtx.tenantId);
  const candidates = buildOnboardingCandidatesFromProfile(resolved.profile);

  if (candidates.length === 0) {
    return;
  }

  const memClient = new TenantMemoryClient(new HonchoHttpTransport());
  try {
    await memClient.ensureWorkspace(tenantCtx);
    await seedOnboardingMemory(
      tenantCtx,
      { runId: `org-${orgId}`, candidates },
      memClient,
    );
  } catch (err) {
    await client.query(`UPDATE organizations SET onboarding_memory_seeded_at = NULL WHERE id = $1`, [orgId]);
    console.error('[onboarding-memory-seed] Honcho seed failed', err);
  }
}
