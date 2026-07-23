import type { PoolClient } from 'pg';

type GoalCacheQueryExecutor = Pick<PoolClient, 'query'>;

/**
 * backend/insights/goal/cache-invalidation.ts
 *
 * Deletes the tenant's cached GOAL narrative rows (every period × platform combo)
 * so the next GET /api/insights/goal rebuilds from the just-saved primary_goal —
 * closing the S1-5 loop (a "Goal inferred — confirm in Settings" fix would
 * otherwise appear to do nothing for up to the 1h goal cache TTL). S1-6 / AA-85.
 *
 * Scoped to section_key='goal' ONLY — no other cached section reads primary_goal,
 * so their caches are intentionally left intact. Version-independent: keys on
 * (tenant_id, section_key), not TEMPLATE_VERSION, so it clears rows regardless of
 * which template version wrote them. Reuses the caller's query executor (a held
 * PoolClient when one exists; otherwise the shared pool) with no extra checkout.
 * Resilient: NEVER throws — a cache-invalidation failure must not
 * fail the profile save that triggered it (the save is the important operation).
 */
export async function invalidateGoalNarrativeCache(
  client: GoalCacheQueryExecutor,
  tenantId: string | number,
): Promise<void> {
  const numericId = Number(tenantId);
  if (!Number.isFinite(numericId) || numericId <= 0) return;
  try {
    await client.query(
      `DELETE FROM insights_narratives WHERE tenant_id = $1 AND section_key = 'goal'`,
      [numericId],
    );
  } catch (err) {
    console.error('[insights.goal] goal cache invalidation failed (save preserved):', err);
  }
}
