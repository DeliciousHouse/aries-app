'use strict';

const LEGACY_SCHEDULED_DISPATCH_QUARANTINE_SQL = `
  WITH legacy AS MATERIALIZED (
    SELECT id, post_id
      FROM scheduled_posts
     WHERE dispatch_status = 'in_flight'
       AND dispatch_started_at IS NULL
     FOR UPDATE
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
       AND dispatch.status IN ('pending', 'in_flight')
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
  SELECT count(*)::integer AS quarantined
    FROM quarantined_scheduled
`;

/**
 * Quarantine pre-fence in-flight rows on every schema initialization.
 *
 * This deliberately has no durable "already ran" marker. A failed rollout may
 * restore an old worker that creates another legacy in-flight row; the next
 * deploy must quarantine that new row before any replacement worker starts.
 * Provider-fenced rows have dispatch_started_at and are never touched.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>, rowCount: number }> }} client
 * @returns {Promise<{ quarantined: number }>}
 */
async function quarantineLegacyScheduledDispatches(client) {
  await client.query('BEGIN');
  try {
    await client.query(`
      SET LOCAL lock_timeout = '5s';
      SET LOCAL statement_timeout = '120s'
    `);
    await client.query(`
      ALTER TABLE scheduled_posts
        ADD COLUMN IF NOT EXISTS dispatch_started_at TIMESTAMPTZ
    `);
    const result = await client.query(LEGACY_SCHEDULED_DISPATCH_QUARANTINE_SQL);
    await client.query('COMMIT');
    return { quarantined: Number(result.rows[0]?.quarantined ?? 0) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

module.exports = {
  LEGACY_SCHEDULED_DISPATCH_QUARANTINE_SQL,
  quarantineLegacyScheduledDispatches,
};
