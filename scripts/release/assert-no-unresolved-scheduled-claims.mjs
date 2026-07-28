#!/usr/bin/env node

import pg from 'pg';

import legacyUnknownOutcomes from '../legacy-scheduled-dispatch-unknown-outcomes.js';

const { LEGACY_UNKNOWN_OUTCOME_SQL_REGEX } = legacyUnknownOutcomes;

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  : new pg.Pool({
      host: process.env.DB_HOST || 'postgres',
      port: Number(process.env.DB_PORT) || 5432,
      user: process.env.DB_USER || 'aries_user',
      password: process.env.DB_PASSWORD || 'aries_pass',
      database: process.env.DB_NAME || 'aries_dev',
      max: 1,
    });

try {
  const result = await pool.query(
    `SELECT count(*)::int AS unresolved
       FROM scheduled_posts AS owner
      WHERE owner.dispatch_status = 'in_flight'
         OR (
           owner.dispatch_status = 'pending'
           AND EXISTS (
             SELECT 1
               FROM scheduled_post_dispatches AS dispatch
              WHERE dispatch.scheduled_post_id = owner.id
                AND dispatch.status = 'pending'
                AND dispatch.error_message ~ '^(fetch failed after retry:|fetch 5xx retry failed:|dispatch [0-9]+: (unparseable response body|missing per-platform results)|graph_network_error:|graph_api_error:)'
           )
         )
         OR (
           owner.dispatch_status IN ('pending', 'failed')
           AND EXISTS (
             SELECT 1
               FROM scheduled_post_dispatches AS dispatch
              WHERE dispatch.scheduled_post_id = owner.id
                AND dispatch.status = 'failed'
                AND dispatch.error_message ~ '${LEGACY_UNKNOWN_OUTCOME_SQL_REGEX}'
           )
         )`,
  );
  const unresolved = Number(result.rows[0]?.unresolved ?? 0);
  if (unresolved > 0) {
    console.error(
      `[scheduled-worker-restore-proof] unresolved legacy provider claims: ${unresolved}; publishing must remain stopped`,
    );
    process.exitCode = 73;
  } else {
    console.log('[scheduled-worker-restore-proof] no unresolved legacy provider claims');
  }
} catch (error) {
  console.error('[scheduled-worker-restore-proof] unable to prove restore safety', error);
  process.exitCode = 74;
} finally {
  await pool.end();
}
