/**
 * Grant/revoke the multi-workspace paid entitlement (multi-workspace plan
 * Decision 13). This is the v1 WRITER of `users.plan` — the manual alternative
 * to a payment processor, which is explicitly out of the plan's scope. The
 * entitlement seam (`assertMultiWorkspaceEntitlement`, `backend/tenant/
 * entitlements.ts`) reads `users.plan`; a payments PR later replaces ONLY this
 * CLI as the writer, touching zero enforcement code.
 *
 * Sets `users.plan` ('pro' | 'free') plus the Phase-0 audit columns
 * `plan_granted_at = now()` and `plan_granted_by = <who/how>` for every matched
 * account (email is case-insensitive; one-email-one-account is enforced by the
 * LOWER(email) unique index, so a match is exactly one row). Validated, audited
 * with a structured log line, idempotent, and safe to re-run.
 *
 * Usage:
 *   tsx scripts/billing/set-user-plan.ts --email owner@acme.com --plan pro
 *   tsx scripts/billing/set-user-plan.ts --email owner@acme.com --plan free
 *   # attribute the grant (defaults to "cli:<os-user>"):
 *   tsx scripts/billing/set-user-plan.ts --email owner@acme.com --plan pro --by "support-ticket-1234"
 *   # inspect without writing:
 *   tsx scripts/billing/set-user-plan.ts --email owner@acme.com --show
 */
import 'dotenv/config';
import os from 'node:os';

import pg from 'pg';

const VALID_PLANS = new Set(['free', 'pro']);

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function buildPool(): pg.Pool {
  return new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'aries_user',
    password: process.env.DB_PASSWORD || 'aries_pass',
    database: process.env.DB_NAME || 'aries_dev',
    max: 2,
  });
}

async function show(pool: pg.Pool, email: string): Promise<void> {
  const res = await pool.query(
    `SELECT id, email, plan, plan_granted_at, plan_granted_by
       FROM users WHERE LOWER(email) = LOWER($1)`,
    [email],
  );
  if (res.rowCount === 0) {
    console.log(`(no user with email ${email})`);
    return;
  }
  console.table(res.rows);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const email = typeof args.email === 'string' ? args.email.trim() : '';
  if (!email) {
    throw new Error('--email <email> is required');
  }

  const pool = buildPool();
  try {
    if (args.show) {
      await show(pool, email);
      return;
    }

    const plan = typeof args.plan === 'string' ? args.plan.trim().toLowerCase() : '';
    if (!VALID_PLANS.has(plan)) {
      throw new Error(`--plan must be one of: ${[...VALID_PLANS].join(', ')} (got ${JSON.stringify(args.plan)})`);
    }

    // Attribution for the audit column: an explicit --by, else the invoking OS
    // user (so a manual grant is always traceable to who/how it was made).
    const grantedBy =
      typeof args.by === 'string' && args.by.trim()
        ? `cli:${args.by.trim()}`
        : `cli:${os.userInfo().username || 'unknown'}`;

    const res = await pool.query(
      `UPDATE users
          SET plan = $1,
              plan_granted_at = now(),
              plan_granted_by = $2
        WHERE LOWER(email) = LOWER($3)
        RETURNING id, email, plan, plan_granted_at, plan_granted_by`,
      [plan, grantedBy, email],
    );

    if (res.rowCount === 0) {
      throw new Error(`no user found with email ${email}`);
    }

    // Structured audit line (Decision 13 — validated, audited).
    console.log(
      JSON.stringify({
        event: 'set-user-plan',
        email,
        plan,
        granted_by: grantedBy,
        user_ids: res.rows.map((row: { id: number | string }) => Number(row.id)),
        at: new Date().toISOString(),
      }),
    );
    console.table(res.rows);
  } finally {
    await pool.end().catch(() => {});
  }
}

void main().catch((err) => {
  console.error(`[set-user-plan] ${(err as Error)?.message ?? String(err)}`);
  process.exit(1);
});
