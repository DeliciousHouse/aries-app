/**
 * backend/insights/tenant-timezone.ts
 *
 * S2-3 / AA-94 — single source of truth for "what timezone does THIS tenant see
 * their analytics in?". Every insights builder resolves the tenant's own business
 * timezone through this helper and threads it into period-window math and SQL
 * day/hour/week bucketing, so all sections agree on which day/hour an event fell
 * on (the timezone-incoherence bug: heatmap in tenant-tz, DOW/windows in UTC).
 *
 * Resolution order: `business_profiles.timezone` for the tenant → coerced through
 * `resolveTenantTimeZone` (validates against the Intl database) → the single
 * `DEFAULT_TENANT_TIMEZONE` fallback ONLY when unset/invalid. The fallback is a
 * safety net for a tenant who never configured a zone; a configured tenant always
 * gets their own. Fail-open: any DB/query error resolves to the default rather
 * than throwing, so a metadata read can never break a dashboard section.
 */

import { resolveTenantTimeZone } from '@/lib/format-timestamp';

interface QueryableClient {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export async function resolveTenantInsightsTimeZone(
  client: QueryableClient,
  tenantId: number,
): Promise<string> {
  try {
    const res = await client.query<{ timezone: string | null }>(
      `SELECT timezone FROM business_profiles WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );
    return resolveTenantTimeZone(res.rows[0]?.timezone ?? null);
  } catch {
    // Never let a timezone lookup fail a section — fall back to the single default.
    return resolveTenantTimeZone(null);
  }
}
