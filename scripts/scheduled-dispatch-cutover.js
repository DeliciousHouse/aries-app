'use strict';

const LEGACY_SCHEDULED_DISPATCH_QUARANTINE_SQL = `
  WITH legacy_transport_ambiguous AS MATERIALIZED (
    SELECT DISTINCT owner.id
      FROM scheduled_posts AS owner
      JOIN scheduled_post_dispatches AS dispatch
        ON dispatch.scheduled_post_id = owner.id
     WHERE (
       owner.dispatch_status = 'pending'
       AND dispatch.status = 'pending'
       AND dispatch.error_message ~ '^(fetch failed after retry:|fetch 5xx retry failed:|dispatch [0-9]+: (unparseable response body|missing per-platform results)|graph_network_error:|graph_api_error:)'
     ) OR (
       owner.dispatch_status = 'failed'
       AND dispatch.status = 'failed'
       AND dispatch.error_message ~ '^(video_publish_outcome_unknown|facebook_publish_missing_id|instagram_publish_missing_id)'
     )
  ), locked_posts AS MATERIALIZED (
    SELECT post.id
      FROM posts AS post
     WHERE EXISTS (
       SELECT 1
         FROM scheduled_posts AS candidate
         WHERE candidate.post_id = post.id
           AND (
             (
               candidate.dispatch_status = 'in_flight'
               AND candidate.dispatch_started_at IS NULL
             )
             OR EXISTS (
               SELECT 1
                 FROM legacy_transport_ambiguous AS ambiguous
                WHERE ambiguous.id = candidate.id
             )
           )
     )
     ORDER BY post.id
     FOR UPDATE OF post
  ), legacy AS MATERIALIZED (
    SELECT scheduled.id, scheduled.post_id
      FROM scheduled_posts AS scheduled
      JOIN locked_posts AS post ON post.id = scheduled.post_id
     WHERE (
       scheduled.dispatch_status = 'in_flight'
       AND scheduled.dispatch_started_at IS NULL
     ) OR EXISTS (
       SELECT 1
         FROM legacy_transport_ambiguous AS ambiguous
        WHERE ambiguous.id = scheduled.id
     )
     ORDER BY scheduled.post_id, scheduled.id
     FOR UPDATE OF scheduled
  ), quarantined_dispatches AS (
    UPDATE scheduled_post_dispatches AS dispatch
       SET status = 'manual_reconciliation',
           error_at = COALESCE(error_at, now()),
           error_message = COALESCE(
             error_message,
             'legacy in-flight dispatch predates the provider-submission fence; manual reconciliation required'
           ),
           updated_at = now()
      FROM legacy
      WHERE dispatch.scheduled_post_id = legacy.id
        AND (
          dispatch.status IN ('pending', 'in_flight')
          OR (
            dispatch.status = 'failed'
            AND dispatch.error_message ~ '^(video_publish_outcome_unknown|facebook_publish_missing_id|instagram_publish_missing_id)'
          )
        )
    RETURNING dispatch.id
  ), quarantined_posts AS (
    UPDATE posts AS post
       SET published_status = 'unverified'
     WHERE post.published_status <> 'published'
       AND EXISTS (
         SELECT 1
           FROM legacy
          WHERE legacy.post_id = post.id
       )
    RETURNING post.id
  ), quarantined_scheduled AS (
    UPDATE scheduled_posts AS scheduled
       SET dispatch_status = 'manual_reconciliation',
           error_at = COALESCE(error_at, now()),
           error_message = COALESCE(
             error_message,
             'legacy in-flight dispatch predates the provider-submission fence; manual reconciliation required'
           ),
           updated_at = now()
      FROM legacy
     WHERE scheduled.id = legacy.id
    RETURNING scheduled.id
  )
  SELECT (SELECT count(*)::integer FROM quarantined_scheduled) AS scheduled_posts,
         (SELECT count(*)::integer FROM quarantined_dispatches) AS platform_dispatches,
         (SELECT count(*)::integer FROM quarantined_posts) AS posts_unverified
`;

/**
 * Quarantine pre-fence rows after the compatible app is healthy. This includes
 * legacy pending image attempts whose transport error could hide an accepted
 * provider publish; safe pending rows without that evidence remain claimable.
 *
 * This deliberately has no durable "already ran" marker. A failed rollout may
 * restore an old worker that creates another legacy in-flight or transport-
 * ambiguous pending row; the next deploy must quarantine that new row before
 * any replacement worker starts.
 * Provider-fenced rows have dispatch_started_at and are never touched.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>, rowCount: number }> }} client
 * @returns {Promise<{ scheduledPosts: number, platformDispatches: number, postsUnverified: number }>}
 */
async function quarantineLegacyScheduledDispatches(client) {
  await client.query('BEGIN');
  try {
    await client.query(`
      SET LOCAL lock_timeout = '5s';
      SET LOCAL statement_timeout = '120s'
    `);
    const result = await client.query(LEGACY_SCHEDULED_DISPATCH_QUARANTINE_SQL);
    await client.query('COMMIT');
    return {
      scheduledPosts: Number(result.rows[0]?.scheduled_posts ?? 0),
      platformDispatches: Number(result.rows[0]?.platform_dispatches ?? 0),
      postsUnverified: Number(result.rows[0]?.posts_unverified ?? 0),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

module.exports = {
  LEGACY_SCHEDULED_DISPATCH_QUARANTINE_SQL,
  quarantineLegacyScheduledDispatches,
};
