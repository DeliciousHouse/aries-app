import type { PoolClient } from 'pg';

import { getBusinessProfileWithDiagnostics } from '@/backend/tenant/business-profile';

export type PostLoginDestination = '/onboarding/pipeline-intake' | '/dashboard';

type Queryable = Pick<PoolClient, 'query'>;

type UserJourneyRow = {
  id: string | number;
  organization_id?: string | number | null;
  onboarding_required?: boolean | null;
  onboarding_completed_at?: string | null;
};

export async function ensureUserJourneySchema(client: Queryable): Promise<void> {
  await client.query(
    `
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS onboarding_required BOOLEAN NOT NULL DEFAULT FALSE
    `,
    [],
  );

  await client.query(
    `
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ
    `,
    [],
  );
}

export async function getUserJourneyRow(
  client: Queryable,
  userId: number | string,
): Promise<UserJourneyRow | null> {
  await ensureUserJourneySchema(client);

  const result = await client.query(
    `
      SELECT id, organization_id, onboarding_required, onboarding_completed_at
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [Number(userId)],
  );

  if ((result.rowCount ?? 0) === 0 || result.rows.length === 0) {
    return null;
  }

  return result.rows[0] as UserJourneyRow;
}

export async function isTenantOnboardingComplete(
  client: PoolClient,
  tenantId: string | null | undefined,
): Promise<boolean> {
  if (!tenantId) {
    return false;
  }

  try {
    const resolved = await getBusinessProfileWithDiagnostics(client, String(tenantId));
    return !resolved.profile.incomplete;
  } catch {
    return false;
  }
}

function normalizeTenantId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return String(value);
}

export function shouldRequireOnboarding(args: {
  onboardingRequired?: boolean | null;
  onboardingCompletedAt?: string | null;
  onboardingCompleted: boolean;
}): boolean {
  if (args.onboardingCompletedAt || args.onboardingCompleted) {
    return false;
  }

  return Boolean(args.onboardingRequired);
}

export function resolvePostLoginDestination(needsOnboarding: boolean): PostLoginDestination {
  return needsOnboarding ? '/onboarding/pipeline-intake' : '/dashboard';
}

export async function resolvePostLoginDestinationForUser(
  client: PoolClient,
  userId: string | number,
): Promise<PostLoginDestination> {
  const row = await getUserJourneyRow(client, userId);

  if (!row) {
    throw new Error(`Unable to resolve onboarding journey for missing user ${userId}.`);
  }

  const onboardingCompleted = await isTenantOnboardingComplete(
    client,
    normalizeTenantId(row.organization_id),
  );
  const needsOnboarding = shouldRequireOnboarding({
    onboardingRequired: row.onboarding_required,
    onboardingCompletedAt: row.onboarding_completed_at,
    onboardingCompleted,
  });

  if (onboardingCompleted && (row.onboarding_required || !row.onboarding_completed_at)) {
    await client.query(
      `
        UPDATE users
        SET onboarding_required = FALSE,
            onboarding_completed_at = COALESCE(onboarding_completed_at, NOW())
        WHERE id = $1
      `,
      [Number(row.id)],
    );
  }

  return resolvePostLoginDestination(needsOnboarding);
}
