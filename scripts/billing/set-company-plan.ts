/**
 * Assign a plan tier (and optional Custom/Enterprise allowance overrides) to a
 * company (AA-163). This is the v1 WRITER of `company_subscriptions` — the
 * manual alternative to a payment processor, exactly like set-user-plan.ts is
 * for the per-account multi-workspace entitlement. A payments PR later replaces
 * ONLY this CLI as the writer, touching zero enforcement code.
 *
 * Note the two are different axes and are NOT interchangeable: `users.plan`
 * ('free'|'pro') gates multi-workspace per ACCOUNT; this gates usage allowance
 * per COMPANY, which is the entity usage is metered against.
 *
 * Usage:
 *   tsx scripts/billing/set-company-plan.ts --company 12 --tier growth
 *   # negotiated Enterprise ceiling (omit to leave a tier's own allowance in force):
 *   tsx scripts/billing/set-company-plan.ts --company 12 --tier enterprise --tasks 100000
 *   # clear an override and fall back to the tier's card:
 *   tsx scripts/billing/set-company-plan.ts --company 12 --tier scale --tasks none
 *   # attribute the change (defaults to "cli:<os-user>"):
 *   tsx scripts/billing/set-company-plan.ts --company 12 --tier growth --by "deal-4471"
 *   # inspect without writing:
 *   tsx scripts/billing/set-company-plan.ts --company 12 --show
 *   # list the configured rate cards:
 *   tsx scripts/billing/set-company-plan.ts --cards
 */
import 'dotenv/config';
import os from 'node:os';

import pg from 'pg';

import { PLAN_TIERS } from '@/backend/billing/rate-cards';

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

/**
 * An override argument is tri-state: absent = leave as-is, `none` = clear it
 * (fall back to the tier card), a number = set it. Without the explicit `none`
 * there would be no way to undo a negotiated ceiling from the CLI.
 */
export function parseOverride(
  raw: string | boolean | undefined,
  label: string,
): { provided: boolean; value: number | null } {
  if (raw === undefined) return { provided: false, value: null };
  if (typeof raw !== 'string') {
    throw new Error(`--${label} needs a value (a non-negative integer, or "none" to clear)`);
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'none' || trimmed === 'null' || trimmed === 'unlimited') {
    return { provided: true, value: null };
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`--${label} must be a non-negative integer or "none" (got ${JSON.stringify(raw)})`);
  }
  return { provided: true, value: Number.parseInt(trimmed, 10) };
}

async function showCards(pool: pg.Pool): Promise<void> {
  const res = await pool.query(
    `SELECT tier_key, display_name, monthly_task_allowance, monthly_token_allowance,
            cost_per_million_tokens_cents, updated_at
       FROM plan_rate_cards ORDER BY sort_order`,
  );
  console.table(res.rows);
}

async function show(pool: pg.Pool, companyId: number): Promise<void> {
  const res = await pool.query(
    `SELECT s.company_id, o.name AS company_name, s.tier_key,
            s.monthly_task_allowance_override, s.monthly_token_allowance_override,
            c.monthly_task_allowance, c.monthly_token_allowance,
            s.assigned_at, s.assigned_by
       FROM company_subscriptions s
       JOIN plan_rate_cards c ON c.tier_key = s.tier_key
       LEFT JOIN organizations o ON o.id = s.company_id
      WHERE s.company_id = $1`,
    [companyId],
  );
  if (res.rowCount === 0) {
    console.log(`(no subscription row for company ${companyId})`);
    return;
  }
  console.table(res.rows);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = buildPool();
  try {
    if (args.cards) {
      await showCards(pool);
      return;
    }

    const rawCompany = typeof args.company === 'string' ? args.company.trim() : '';
    if (!/^\d+$/.test(rawCompany)) {
      throw new Error('--company <organization id> is required');
    }
    const companyId = Number.parseInt(rawCompany, 10);

    if (args.show) {
      await show(pool, companyId);
      return;
    }

    const tier = typeof args.tier === 'string' ? args.tier.trim().toLowerCase() : '';
    if (!(PLAN_TIERS as readonly string[]).includes(tier)) {
      throw new Error(`--tier must be one of: ${PLAN_TIERS.join(', ')} (got ${JSON.stringify(args.tier)})`);
    }

    const taskOverride = parseOverride(args.tasks, 'tasks');
    const tokenOverride = parseOverride(args.tokens, 'tokens');

    const assignedBy =
      typeof args.by === 'string' && args.by.trim()
        ? `cli:${args.by.trim()}`
        : `cli:${os.userInfo().username || 'unknown'}`;

    // The FK to organizations rejects an unknown company, so a typo'd id fails
    // loudly rather than creating a subscription for a company that isn't there.
    // COALESCE keeps an omitted override untouched on an update.
    const res = await pool.query(
      `INSERT INTO company_subscriptions
         (company_id, tier_key, monthly_task_allowance_override, monthly_token_allowance_override, assigned_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id) DO UPDATE
          SET tier_key = EXCLUDED.tier_key,
              monthly_task_allowance_override =
                CASE WHEN $6 THEN EXCLUDED.monthly_task_allowance_override
                     ELSE company_subscriptions.monthly_task_allowance_override END,
              monthly_token_allowance_override =
                CASE WHEN $7 THEN EXCLUDED.monthly_token_allowance_override
                     ELSE company_subscriptions.monthly_token_allowance_override END,
              assigned_by = EXCLUDED.assigned_by,
              assigned_at = now(),
              updated_at = now()
       RETURNING company_id, tier_key, monthly_task_allowance_override,
                 monthly_token_allowance_override, assigned_at, assigned_by`,
      [
        companyId,
        tier,
        taskOverride.value,
        tokenOverride.value,
        assignedBy,
        taskOverride.provided,
        tokenOverride.provided,
      ],
    );

    console.log(
      JSON.stringify({
        event: 'set-company-plan',
        company_id: companyId,
        tier,
        task_override: taskOverride.provided ? taskOverride.value : 'unchanged',
        token_override: tokenOverride.provided ? tokenOverride.value : 'unchanged',
        assigned_by: assignedBy,
        at: new Date().toISOString(),
      }),
    );
    console.table(res.rows);
  } finally {
    await pool.end().catch(() => {});
  }
}

// Only run when invoked directly, so the arg parsers stay unit-testable.
if (process.argv[1] && process.argv[1].includes('set-company-plan')) {
  void main().catch((err) => {
    console.error(`[set-company-plan] ${(err as Error)?.message ?? String(err)}`);
    process.exit(1);
  });
}
