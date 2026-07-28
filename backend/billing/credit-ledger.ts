/**
 * AA-164 — purchased task credits.
 *
 * Credits are TASK credits: the unit AA-163 enforces on. A token balance would
 * be unspendable and a token percentage would never move, because every AI_LLM
 * row carries NULL tokens until Hermes reports usage. When that changes, the
 * metric flips via ARIES_PLAN_ENFORCEMENT_METRIC and this ledger's unit follows.
 *
 * The ledger is APPEND-ONLY and a balance is a SUM over unexpired rows. A
 * mutable counter would lose its own audit trail the first time two writers
 * raced, and "why does this company have N credits" must be answerable from the
 * table alone. A mistake is corrected by appending a negative row, never by
 * editing history.
 *
 * Credits stack ON TOP of the plan's monthly allowance and do not reset with the
 * calendar month. Voiding paid-for capacity at a month boundary would be taking
 * money for nothing.
 *
 * WRITERS: `grantCompanyCredits` is the v1 writer, driven by
 * scripts/billing/grant-company-credits.ts — the same seam set-user-plan.ts and
 * set-company-plan.ts already use, so the payment-gateway PR adds a webhook that
 * calls this function with `source:'purchase'` and the gateway's event id, and
 * touches no consumption or enforcement code. `externalEventId` is what makes
 * that fulfillment idempotent under webhook redelivery.
 */

import { pool } from '@/lib/db';

export type Queryable = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

export const CREDIT_SOURCES = ['purchase', 'grant', 'correction'] as const;
export type CreditSource = (typeof CREDIT_SOURCES)[number];

/**
 * Unexpired balance. `expires_at IS NULL` means "never expires", which is the
 * normal case for a purchase.
 */
export const SELECT_CREDIT_BALANCE_SQL = `SELECT COALESCE(sum(credits), 0)::bigint AS balance
     FROM company_credit_ledger
    WHERE company_id = $1
      AND (expires_at IS NULL OR expires_at > now())`;

/**
 * ON CONFLICT DO NOTHING on the partial unique index over external_event_id:
 * a redelivered gateway event credits the company exactly once. rowCount tells
 * the caller whether THIS call was the one that applied it.
 */
export const INSERT_CREDIT_SQL = `INSERT INTO company_credit_ledger
       (company_id, credits, source, external_event_id, note, granted_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (external_event_id) WHERE external_event_id IS NOT NULL DO NOTHING
     RETURNING id, company_id, credits, source, external_event_id, created_at`;

function asNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Unexpired credit balance for a company. Throws on a DB error — callers decide
 * what an unreadable balance means for them (the gate treats it as fail-open;
 * the dashboard surfaces it as an error rather than rendering a wrong number).
 */
export async function loadCreditBalance(
  companyId: number,
  db: Queryable = pool,
): Promise<number> {
  const res = await db.query(SELECT_CREDIT_BALANCE_SQL, [companyId]);
  return asNumber((res.rows[0] as { balance?: unknown } | undefined)?.balance);
}

export type GrantCreditsInput = {
  companyId: number;
  /** Task credits. Negative is a correction — see the append-only rationale. */
  credits: number;
  source: CreditSource;
  /** Gateway event id. Present ⇒ the write is idempotent under redelivery. */
  externalEventId?: string | null;
  note?: string | null;
  grantedBy?: string | null;
  /** NULL/undefined = never expires (the normal case for a purchase). */
  expiresAt?: Date | null;
};

export type GrantCreditsResult =
  | { applied: true; id: number; credits: number }
  /** The event was already fulfilled — a redelivery, not an error. */
  | { applied: false; reason: 'duplicate_event' };

export async function grantCompanyCredits(
  input: GrantCreditsInput,
  db: Queryable = pool,
): Promise<GrantCreditsResult> {
  if (!Number.isInteger(input.companyId) || input.companyId <= 0) {
    throw new Error('invalid_company_id');
  }
  if (!Number.isInteger(input.credits) || input.credits === 0) {
    throw new Error('invalid_credits');
  }
  if (!CREDIT_SOURCES.includes(input.source)) {
    throw new Error('invalid_source');
  }

  const res = await db.query(INSERT_CREDIT_SQL, [
    input.companyId,
    input.credits,
    input.source,
    input.externalEventId?.trim() || null,
    input.note?.trim() || null,
    input.grantedBy?.trim() || null,
    input.expiresAt ?? null,
  ]);

  const row = res.rows[0] as { id?: unknown; credits?: unknown } | undefined;
  if (!row) {
    // The insert was swallowed by the unique index: this exact gateway event has
    // already been credited.
    return { applied: false, reason: 'duplicate_event' };
  }
  return { applied: true, id: asNumber(row.id), credits: asNumber(row.credits) };
}
