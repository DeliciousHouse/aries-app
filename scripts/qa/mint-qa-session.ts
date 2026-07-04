/**
 * Mint a short-lived Auth.js session for the pinned QA sandbox user, for
 * headless rendered-UI verification (gstack /browse) against the live app.
 *
 * How: builds the same JWT claim shape auth.ts's jwt callback produces, and
 * encodes it with the app's own `next-auth/jwt` `encode` (same NEXTAUTH_SECRET,
 * same cookie-name salt) — so `auth()` accepts it exactly like a login-issued
 * session. No password exists or is entered anywhere; possession of the host's
 * NEXTAUTH_SECRET is the (pre-existing) trust boundary.
 *
 * Guards (fail closed): mints ONLY for qa-bot@aries-qa.internal on the
 * aries-qa-sandbox tenant (see qa-session-lib.assertQaScoped), TTL clamped to
 * 12h, and an audit line goes to stderr on every mint. The token itself is
 * written to the output file (0600), never printed.
 *
 * Usage (from a checkout with .env available, e.g. the prod host):
 *   npx tsx scripts/qa/mint-qa-session.ts --out /tmp/qa-cookies.json [--ttl-minutes 120]
 * then:
 *   browse cookie-import /tmp/qa-cookies.json
 */
import 'dotenv/config';

import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { encode } from 'next-auth/jwt';

import {
  assertQaScoped,
  buildQaTokenClaims,
  buildSessionCookieJson,
  clampTtlMinutes,
  sessionCookieNameForBaseUrl,
  QA_USER_EMAIL,
} from './qa-session-lib';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const out = arg('--out');
  if (!out) {
    console.error('usage: mint-qa-session.ts --out <cookies.json> [--ttl-minutes N]');
    process.exit(2);
  }
  const ttlMinutes = clampTtlMinutes(Number(arg('--ttl-minutes')));

  const secret = process.env.NEXTAUTH_SECRET?.trim() || process.env.AUTH_SECRET?.trim();
  const baseUrl = (process.env.APP_BASE_URL || process.env.NEXTAUTH_URL || '').trim();
  if (!secret || !baseUrl) {
    console.error('[mint-qa-session] NEXTAUTH_SECRET/AUTH_SECRET and APP_BASE_URL are required');
    process.exit(2);
  }

  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'aries_user',
    password: process.env.DB_PASSWORD || 'aries_pass',
    database: process.env.DB_NAME || 'aries_dev',
    max: 1,
  });

  try {
    const result = await pool.query(
      `SELECT u.id AS user_id, u.email, u.full_name, u.role,
              o.id AS tenant_id,
              COALESCE(NULLIF(o.slug, ''), 'org-' || o.id::text) AS tenant_slug
         FROM users u
         LEFT JOIN organizations o ON o.id = u.organization_id
        WHERE u.email = $1
        LIMIT 1`,
      [QA_USER_EMAIL],
    );
    const row = result.rows[0];
    if (!row) {
      console.error(
        `[mint-qa-session] QA user ${QA_USER_EMAIL} not found — run scripts/qa/seed-qa-tenant.ts first`,
      );
      process.exit(1);
    }

    const scoped = assertQaScoped(row);
    if (!scoped.ok) {
      console.error(`[mint-qa-session] ${scoped.reason}`);
      process.exit(1);
    }

    // Dual-write the membership row (multi-workspace Phase 0). The mint script must
    // work in both worlds: with the membership tables present it self-heals the QA
    // bot's single 'active' membership so a minted session always resolves through
    // the membership join once later phases read it; where the table does not yet
    // exist (older DB) it is a tolerated no-op. Idempotent + QA-scoped only.
    try {
      await pool.query(
        `INSERT INTO organization_memberships
           (user_id, organization_id, role, status, accepted_at, last_active_at, created_at, updated_at)
         VALUES ($1, $2, 'tenant_admin', 'active', now(), now(), now(), now())
         ON CONFLICT (user_id, organization_id) DO UPDATE SET
           role = 'tenant_admin',
           status = 'active',
           updated_at = now()`,
        [Number(row.user_id), Number(row.tenant_id)],
      );
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      // 42P01 = undefined_table: membership schema not applied yet (pre-Phase-0).
      if (code !== '42P01') {
        throw error;
      }
    }

    const cookieName = sessionCookieNameForBaseUrl(baseUrl);
    const token = await encode({
      token: buildQaTokenClaims(row),
      secret,
      salt: cookieName,
      maxAge: ttlMinutes * 60,
    });

    writeFileSync(out, JSON.stringify(buildSessionCookieJson(baseUrl, token, ttlMinutes, Date.now())), {
      mode: 0o600,
    });

    // Audit trail — identity and lifetime only, never the token.
    console.error(
      `[mint-qa-session] minted session for ${QA_USER_EMAIL} (user ${row.user_id}, tenant ${row.tenant_id}/${row.tenant_slug}) ttl=${ttlMinutes}m -> ${out}`,
    );
    console.log(JSON.stringify({ ok: true, cookieName, ttlMinutes, out }));
  } finally {
    await pool.end().catch(() => {});
  }
}

void main().catch((error) => {
  console.error('[mint-qa-session] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
