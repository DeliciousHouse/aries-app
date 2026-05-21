/**
 * Count the real DB `posts` rows a completed marketing pipeline produced.
 *
 * The dashboard "Publish items" counter historically projected
 * `payload.publish_package` — a dead legacy-era contract that the
 * Hermes-native pipeline never emits, so a completed campaign showed
 * "Publish items 0" even though `synthesizePublishPostsFromContentPackage`
 * had created real `posts` rows on the publish-completed callback.
 *
 * This helper is the source of truth for that counter: how many `posts`
 * rows exist for the campaign's `job_id`. Counting rows (one query, GROUP
 * BY-free) keeps it cheap on the status endpoint's hot path.
 */

import { pool } from '@/lib/db';

/** Minimal queryable surface — the shared pool or a transactional client. */
export interface PostsCountQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export const COUNT_POSTS_BY_JOB_SQL = `
  SELECT COUNT(*)::int AS count
    FROM posts
   WHERE tenant_id = $1
     AND job_id = $2
`;

/**
 * Returns the number of `posts` rows for a campaign. Returns 0 — never throws —
 * when the tenant id is unusable or the query fails, so the dashboard degrades
 * to the legacy projection-derived count instead of erroring.
 *
 * `queryable` defaults to the shared pool; tests pass a transactional client so
 * the assertion runs against real Postgres without leaving rows behind.
 */
export async function countPublishedPostsForJob(
  tenantId: string | number,
  jobId: string,
  queryable: PostsCountQueryable = pool,
): Promise<number> {
  const tenantIdNum = typeof tenantId === 'number' ? tenantId : Number(tenantId);
  if (!Number.isInteger(tenantIdNum) || tenantIdNum <= 0 || !jobId) {
    return 0;
  }
  try {
    const result = await queryable.query(COUNT_POSTS_BY_JOB_SQL, [tenantIdNum, jobId]);
    const row = result.rows[0] as { count?: number } | undefined;
    return typeof row?.count === 'number' && row.count > 0 ? row.count : 0;
  } catch (err) {
    console.warn('[published-posts-count] posts count query failed — falling back to projection count', {
      jobId,
      tenantId: String(tenantId),
      error: (err as Error)?.message ?? String(err),
    });
    return 0;
  }
}
