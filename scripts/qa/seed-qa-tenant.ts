/**
 * Seed the headless-QA sandbox: one organization (aries-qa-sandbox) and one
 * QA user (qa-bot@aries-qa.internal) with an UNUSABLE password — the hash is
 * over random bytes that are discarded immediately, so the account cannot be
 * logged into with credentials at all. Sessions for it are minted exclusively
 * by scripts/qa/mint-qa-session.ts (requires host access to NEXTAUTH_SECRET).
 *
 * Idempotent: re-running updates names/membership and re-randomizes the
 * unusable hash; it never creates duplicates (org keyed by unique slug, user
 * by unique email).
 *
 * Usage (from a checkout with the DB env available, e.g. the prod host):
 *   npx tsx scripts/qa/seed-qa-tenant.ts
 */
import 'dotenv/config';

import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import pg from 'pg';

import {
  QA_TENANT_NAME,
  QA_TENANT_SLUG,
  QA_USER_EMAIL,
  QA_USER_NAME,
} from './qa-session-lib';

async function main(): Promise<void> {
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'aries_user',
    password: process.env.DB_PASSWORD || 'aries_pass',
    database: process.env.DB_NAME || 'aries_dev',
    max: 1,
  });

  try {
    const org = await pool.query<{ id: number }>(
      `INSERT INTO organizations (name, slug)
       VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [QA_TENANT_NAME, QA_TENANT_SLUG],
    );
    const tenantId = org.rows[0].id;

    // Unusable credential: 48 random bytes hashed and immediately forgotten.
    const unusable = await bcrypt.hash(randomBytes(48).toString('hex'), 10);
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash, full_name, organization_id, role, onboarding_required)
       VALUES ($1, $2, $3, $4, 'tenant_admin', FALSE)
       ON CONFLICT (email) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         full_name = EXCLUDED.full_name,
         organization_id = EXCLUDED.organization_id,
         role = 'tenant_admin',
         onboarding_required = FALSE
       RETURNING id`,
      [QA_USER_EMAIL, unusable, QA_USER_NAME, tenantId],
    );

    console.log(
      JSON.stringify({
        seeded: true,
        tenantId,
        tenantSlug: QA_TENANT_SLUG,
        userId: user.rows[0].id,
        email: QA_USER_EMAIL,
        note: 'password is unusable by design; mint sessions via scripts/qa/mint-qa-session.ts',
      }),
    );
  } finally {
    await pool.end().catch(() => {});
  }
}

void main().catch((error) => {
  console.error('[seed-qa-tenant] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
