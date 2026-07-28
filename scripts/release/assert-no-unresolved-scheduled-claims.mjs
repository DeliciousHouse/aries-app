#!/usr/bin/env node

import pg from 'pg';

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
       FROM scheduled_posts
      WHERE dispatch_status = 'in_flight'`,
  );
  const unresolved = Number(result.rows[0]?.unresolved ?? 0);
  if (unresolved > 0) {
    console.error(
      `[scheduled-worker-restore-proof] unresolved in-flight provider claims: ${unresolved}; publishing must remain stopped`,
    );
    process.exitCode = 73;
  } else {
    console.log('[scheduled-worker-restore-proof] no unresolved in-flight provider claims');
  }
} catch (error) {
  console.error('[scheduled-worker-restore-proof] unable to prove restore safety', error);
  process.exitCode = 74;
} finally {
  await pool.end();
}
