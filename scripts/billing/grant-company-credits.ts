/**
 * Add (or correct) a company's purchased task credits (AA-164). This is the v1
 * WRITER of company_credit_ledger — the manual alternative to a payment
 * gateway, exactly as set-user-plan.ts and set-company-plan.ts are for their
 * entitlements. The self-serve checkout PR adds a webhook that calls
 * `grantCompanyCredits` with `source:'purchase'` and the gateway's event id,
 * and touches no consumption or enforcement code.
 *
 * Credits are TASK credits — the unit enforcement runs on. They stack on top of
 * the plan's monthly allowance and do not reset with the calendar month.
 *
 * Usage:
 *   tsx scripts/billing/grant-company-credits.ts --company 12 --credits 500
 *   # reverse a mistake by appending its inverse (history is never edited):
 *   tsx scripts/billing/grant-company-credits.ts --company 12 --credits -500 --source correction
 *   # attribute it (defaults to "cli:<os-user>"):
 *   tsx scripts/billing/grant-company-credits.ts --company 12 --credits 500 --by "invoice-8812"
 *   # show the balance and recent ledger rows:
 *   tsx scripts/billing/grant-company-credits.ts --company 12 --show
 */
import 'dotenv/config';
import os from 'node:os';

import pg from 'pg';

import {
  CREDIT_SOURCES,
  grantCompanyCredits,
  loadCreditBalance,
  type CreditSource,
} from '@/backend/billing/credit-ledger';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    // A negative number must not be mistaken for the next flag — that is how a
    // correction is expressed.
    if (next === undefined || (next.startsWith('--') && !/^--?\d/.test(next))) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

/** Signed integer, non-zero. A zero-credit row would be a no-op with an audit trail. */
export function parseCredits(raw: string | boolean | undefined): number {
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw.trim())) {
    throw new Error(`--credits must be a non-zero integer (got ${JSON.stringify(raw)})`);
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (parsed === 0) {
    throw new Error('--credits must be non-zero');
  }
  return parsed;
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rawCompany = typeof args.company === 'string' ? args.company.trim() : '';
  if (!/^\d+$/.test(rawCompany)) {
    throw new Error('--company <organization id> is required');
  }
  const companyId = Number.parseInt(rawCompany, 10);

  const pool = buildPool();
  try {
    if (args.show) {
      const balance = await loadCreditBalance(companyId, pool);
      const history = await pool.query(
        `SELECT id, credits, source, external_event_id, note, granted_by, expires_at, created_at
           FROM company_credit_ledger WHERE company_id = $1
          ORDER BY created_at DESC LIMIT 20`,
        [companyId],
      );
      console.log(JSON.stringify({ company_id: companyId, unexpired_balance: balance }));
      console.table(history.rows);
      return;
    }

    const credits = parseCredits(args.credits);
    const source = (typeof args.source === 'string' ? args.source.trim() : 'grant') as CreditSource;
    if (!CREDIT_SOURCES.includes(source)) {
      throw new Error(`--source must be one of: ${CREDIT_SOURCES.join(', ')}`);
    }

    const grantedBy =
      typeof args.by === 'string' && args.by.trim()
        ? `cli:${args.by.trim()}`
        : `cli:${os.userInfo().username || 'unknown'}`;

    const result = await grantCompanyCredits(
      {
        companyId,
        credits,
        source,
        note: typeof args.note === 'string' ? args.note : null,
        grantedBy,
      },
      pool,
    );

    const balance = await loadCreditBalance(companyId, pool);
    console.log(
      JSON.stringify({
        event: 'grant-company-credits',
        company_id: companyId,
        credits,
        source,
        applied: result.applied,
        unexpired_balance: balance,
        granted_by: grantedBy,
        at: new Date().toISOString(),
      }),
    );
  } finally {
    await pool.end().catch(() => {});
  }
}

// Only run when invoked directly, so the arg parsers stay unit-testable.
if (process.argv[1] && process.argv[1].includes('grant-company-credits')) {
  void main().catch((err) => {
    console.error(`[grant-company-credits] ${(err as Error)?.message ?? String(err)}`);
    process.exit(1);
  });
}
