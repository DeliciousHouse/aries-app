/**
 * AA-164 — the purchased-credit ledger.
 *
 * This is the module that will sit behind a payment webhook, so the tests are
 * weighted toward the money bugs:
 *   - a redelivered gateway event credits the company exactly ONCE;
 *   - a manual grant (no event id) is never collapsed by that dedupe;
 *   - the balance is a SUM over unexpired rows, so a correction is expressed by
 *     appending a negative row rather than editing history;
 *   - garbage input is rejected before it reaches the table.
 *
 * Fully in-memory: the db handle is injected, no Postgres is touched.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CREDIT_SOURCES,
  INSERT_CREDIT_SQL,
  SELECT_CREDIT_BALANCE_SQL,
  grantCompanyCredits,
  loadCreditBalance,
} from '@/backend/billing/credit-ledger';

type Call = { sql: string; params: unknown[] };

function fakeDb(responder?: (sql: string, params: unknown[]) => { rows?: unknown[] } | undefined) {
  const calls: Call[] = [];
  return {
    calls,
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const res = responder?.(sql, params ?? []);
      return { rows: res?.rows ?? [], rowCount: res?.rows?.length ?? 0 };
    },
  };
}

test('a balance is the sum of unexpired rows only', () => {
  // Expired credits must drop out of the balance without being deleted — the
  // ledger stays a complete audit trail.
  assert.match(SELECT_CREDIT_BALANCE_SQL, /sum\(credits\)/);
  assert.match(SELECT_CREDIT_BALANCE_SQL, /expires_at IS NULL OR expires_at > now\(\)/);
  // COALESCE so a company with no rows reads 0 rather than NULL.
  assert.match(SELECT_CREDIT_BALANCE_SQL, /COALESCE\(sum\(credits\), 0\)/);
});

test('the balance parses a BIGINT string and defaults to zero', async () => {
  const withRows = fakeDb(() => ({ rows: [{ balance: '1500' }] }));
  assert.equal(await loadCreditBalance(7, withRows), 1500);

  const empty = fakeDb();
  assert.equal(await loadCreditBalance(7, empty), 0);
});

test('fulfillment is idempotent under gateway redelivery', async () => {
  // The insert must defer to the partial unique index on external_event_id.
  assert.match(
    INSERT_CREDIT_SQL,
    /ON CONFLICT \(external_event_id\) WHERE external_event_id IS NOT NULL DO NOTHING/,
  );

  // First delivery applies...
  const first = fakeDb(() => ({ rows: [{ id: 1, credits: 500 }] }));
  const applied = await grantCompanyCredits(
    { companyId: 7, credits: 500, source: 'purchase', externalEventId: 'evt_123' },
    first,
  );
  assert.deepEqual(applied, { applied: true, id: 1, credits: 500 });

  // ...the redelivery is swallowed by the index and reported, not thrown. A
  // second credit here would be charging once and crediting twice.
  const redelivery = fakeDb(() => ({ rows: [] }));
  const duplicate = await grantCompanyCredits(
    { companyId: 7, credits: 500, source: 'purchase', externalEventId: 'evt_123' },
    redelivery,
  );
  assert.deepEqual(duplicate, { applied: false, reason: 'duplicate_event' });
});

test('a manual grant carries no event id, so grants are never deduped against each other', async () => {
  const db = fakeDb(() => ({ rows: [{ id: 2, credits: 100 }] }));

  await grantCompanyCredits({ companyId: 7, credits: 100, source: 'grant' }, db);
  await grantCompanyCredits({ companyId: 7, credits: 100, source: 'grant' }, db);

  const inserts = db.calls.filter((c) => c.sql.includes('INSERT INTO company_credit_ledger'));
  assert.equal(inserts.length, 2);
  // NULL is outside the partial index's predicate, so two identical manual
  // grants both land.
  assert.equal(inserts[0].params[3], null);
  assert.equal(inserts[1].params[3], null);
});

test('a correction is a negative row, not an edit', async () => {
  const db = fakeDb(() => ({ rows: [{ id: 3, credits: -500 }] }));

  const result = await grantCompanyCredits(
    { companyId: 7, credits: -500, source: 'correction', note: 'refunded invoice 8812' },
    db,
  );

  assert.equal(result.applied, true);
  const insert = db.calls.find((c) => c.sql.includes('INSERT INTO company_credit_ledger'));
  assert.equal(insert?.params[1], -500);
  assert.equal(insert?.params[2], 'correction');
  // Nothing UPDATEs or DELETEs the ledger.
  assert.equal(db.calls.filter((c) => /UPDATE|DELETE/.test(c.sql)).length, 0);
});

test('invalid input is rejected before it reaches the table', async () => {
  const db = fakeDb();
  await assert.rejects(
    () => grantCompanyCredits({ companyId: 0, credits: 10, source: 'grant' }, db),
    /invalid_company_id/,
  );
  await assert.rejects(
    () => grantCompanyCredits({ companyId: 7, credits: 0, source: 'grant' }, db),
    /invalid_credits/,
  );
  await assert.rejects(
    () => grantCompanyCredits({ companyId: 7, credits: 1.5, source: 'grant' }, db),
    /invalid_credits/,
  );
  await assert.rejects(
    () =>
      grantCompanyCredits(
        { companyId: 7, credits: 10, source: 'freebie' as (typeof CREDIT_SOURCES)[number] },
        db,
      ),
    /invalid_source/,
  );
  assert.deepEqual(db.calls, [], 'nothing reached the database');
});
