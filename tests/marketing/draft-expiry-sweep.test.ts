/**
 * Draft-expiry sweep — self-contained unit tests (no live DB).
 *
 * Covers:
 *   - the flag / age / interval / dry-run parsers;
 *   - the SQL constants' shape (all four embed the one shared predicate; the
 *     expire statement writes 'expired' to both columns + re-checks the guard);
 *   - the sweep orchestration driven against an in-memory fake pool: dry-run is
 *     read-only, commit expires exactly the stranded population (and NOTHING
 *     else), the age boundary, batching, the maxBatches truncation backstop,
 *     idempotency on re-run, and the never-touch-scheduled invariant.
 *
 * The fake pool is the oracle: it implements the predicate ONCE, in JS, and
 * dispatches on the exact exported SQL string the sweep runs — so a drift
 * between the four SQL constants would break dispatch and fail loudly. The
 * real-Postgres planner/constraint coverage lives in the requires-infra test
 * (tests/draft-expiry-sweep.requires-infra.test.ts).
 *
 * Run:
 *   ./node_modules/.bin/tsx --test tests/marketing/draft-expiry-sweep.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  draftExpiryEnabled,
  draftExpiryDryRun,
  resolveDraftExpiryIntervalMs,
  resolveDraftExpiryAgeDays,
  runDraftExpirySweep,
  STRANDED_PREDICATE,
  COUNT_SQL,
  COUNT_BY_TENANT_SQL,
  SELECT_BATCH_SQL,
  EXPIRE_BATCH_SQL,
  DEFAULT_DRAFT_EXPIRY_AGE_DAYS,
  DEFAULT_DRAFT_EXPIRY_INTERVAL_MS,
  type Queryable,
} from '../../backend/marketing/draft-expiry-sweep';

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

test('draftExpiryEnabled: truthy variants only', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
    assert.equal(draftExpiryEnabled({ ARIES_DRAFT_EXPIRY_ENABLED: v } as unknown as NodeJS.ProcessEnv), true, v);
  }
  for (const v of ['', '0', 'false', 'no', 'off', undefined, 'enable']) {
    assert.equal(
      draftExpiryEnabled({ ARIES_DRAFT_EXPIRY_ENABLED: v } as unknown as NodeJS.ProcessEnv),
      false,
      String(v),
    );
  }
});

test('draftExpiryDryRun: truthy variants only; default off', () => {
  assert.equal(draftExpiryDryRun({ ARIES_DRAFT_EXPIRY_DRY_RUN: '1' } as unknown as NodeJS.ProcessEnv), true);
  assert.equal(draftExpiryDryRun({ ARIES_DRAFT_EXPIRY_DRY_RUN: 'yes' } as unknown as NodeJS.ProcessEnv), true);
  assert.equal(draftExpiryDryRun({} as unknown as NodeJS.ProcessEnv), false);
  assert.equal(draftExpiryDryRun({ ARIES_DRAFT_EXPIRY_DRY_RUN: '0' } as unknown as NodeJS.ProcessEnv), false);
});

test('resolveDraftExpiryIntervalMs: default + override + fallback on garbage', () => {
  assert.equal(resolveDraftExpiryIntervalMs({} as unknown as NodeJS.ProcessEnv), DEFAULT_DRAFT_EXPIRY_INTERVAL_MS);
  assert.equal(
    resolveDraftExpiryIntervalMs({ ARIES_DRAFT_EXPIRY_INTERVAL_MS: '60000' } as unknown as NodeJS.ProcessEnv),
    60000,
  );
  for (const bad of ['0', '-5', 'abc', '']) {
    assert.equal(
      resolveDraftExpiryIntervalMs({ ARIES_DRAFT_EXPIRY_INTERVAL_MS: bad } as unknown as NodeJS.ProcessEnv),
      DEFAULT_DRAFT_EXPIRY_INTERVAL_MS,
      bad,
    );
  }
});

test('resolveDraftExpiryAgeDays: default + override + fallback on garbage', () => {
  assert.equal(resolveDraftExpiryAgeDays({} as unknown as NodeJS.ProcessEnv), DEFAULT_DRAFT_EXPIRY_AGE_DAYS);
  assert.equal(resolveDraftExpiryAgeDays({ ARIES_DRAFT_EXPIRY_AGE_DAYS: '30' } as unknown as NodeJS.ProcessEnv), 30);
  for (const bad of ['0', '-1', 'soon', '']) {
    assert.equal(
      resolveDraftExpiryAgeDays({ ARIES_DRAFT_EXPIRY_AGE_DAYS: bad } as unknown as NodeJS.ProcessEnv),
      DEFAULT_DRAFT_EXPIRY_AGE_DAYS,
      bad,
    );
  }
});

// ---------------------------------------------------------------------------
// SQL shape
// ---------------------------------------------------------------------------

test('all four statements embed the one shared predicate (no drift)', () => {
  for (const sql of [COUNT_SQL, COUNT_BY_TENANT_SQL, SELECT_BATCH_SQL, EXPIRE_BATCH_SQL]) {
    assert.ok(sql.includes(STRANDED_PREDICATE), 'must embed STRANDED_PREDICATE verbatim');
  }
});

test('predicate encodes the four stranded conditions on $1 = cutoff', () => {
  assert.ok(STRANDED_PREDICATE.includes('NOT EXISTS (SELECT 1 FROM scheduled_posts sp WHERE sp.post_id = p.id)'));
  assert.ok(STRANDED_PREDICATE.includes('p.published_at IS NULL'));
  assert.ok(STRANDED_PREDICATE.includes("p.published_status IN ('draft','in_review','approved')"));
  assert.ok(STRANDED_PREDICATE.includes("p.status            IN ('draft','in_review','approved')"));
  assert.ok(STRANDED_PREDICATE.includes('p.updated_at < $1'));
});

test('expire statement writes expired to both columns + stamps expired_at + re-checks guard', () => {
  assert.ok(EXPIRE_BATCH_SQL.includes("published_status = 'expired'"));
  assert.ok(EXPIRE_BATCH_SQL.includes("status           = 'expired'"));
  assert.ok(EXPIRE_BATCH_SQL.includes('expired_at       = now()'));
  assert.ok(EXPIRE_BATCH_SQL.includes('p.id = ANY($2::bigint[])'));
  // The full predicate appears in the UPDATE WHERE — the race re-check.
  assert.ok(EXPIRE_BATCH_SQL.includes(STRANDED_PREDICATE));
  assert.ok(EXPIRE_BATCH_SQL.includes('RETURNING p.id, p.tenant_id'));
});

// ---------------------------------------------------------------------------
// In-memory fake pool (the oracle)
// ---------------------------------------------------------------------------

type Row = {
  id: number;
  tenant_id: number;
  published_status: string;
  status: string;
  published_at: string | null;
  updated_at: string; // ISO
  scheduled: boolean; // has a scheduled_posts row
  expired_at: string | null;
};

const PRE_PUBLISH = new Set(['draft', 'in_review', 'approved']);

function isStranded(r: Row, cutoffIso: string): boolean {
  return (
    !r.scheduled &&
    r.published_at === null &&
    (PRE_PUBLISH.has(r.published_status) || PRE_PUBLISH.has(r.status)) &&
    Date.parse(r.updated_at) < Date.parse(cutoffIso)
  );
}

/** A fake Queryable backed by an in-memory rows array, dispatching on the exact SQL strings. */
function fakePool(rows: Row[], nowIso = '2026-06-07T00:00:00.000Z'): Queryable {
  return {
    async query(sql: string, params: unknown[] = []) {
      if (sql === COUNT_SQL) {
        const cutoff = params[0] as string;
        const n = rows.filter((r) => isStranded(r, cutoff)).length;
        return { rows: [{ n }], rowCount: 1 };
      }
      if (sql === COUNT_BY_TENANT_SQL) {
        const cutoff = params[0] as string;
        const byTenant = new Map<number, number>();
        for (const r of rows.filter((x) => isStranded(x, cutoff))) {
          byTenant.set(r.tenant_id, (byTenant.get(r.tenant_id) ?? 0) + 1);
        }
        const out = [...byTenant.entries()]
          .map(([tenant_id, n]) => ({ tenant_id, n }))
          .sort((a, b) => b.n - a.n || a.tenant_id - b.tenant_id);
        return { rows: out, rowCount: out.length };
      }
      if (sql === SELECT_BATCH_SQL) {
        const cutoff = params[0] as string;
        const limit = params[1] as number;
        const out = rows
          .filter((r) => isStranded(r, cutoff))
          .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
          .slice(0, limit)
          .map((r) => ({ id: r.id, tenant_id: r.tenant_id }));
        return { rows: out, rowCount: out.length };
      }
      if (sql === EXPIRE_BATCH_SQL) {
        const cutoff = params[0] as string;
        const ids = new Set(params[1] as number[]);
        const expired: Array<{ id: number; tenant_id: number }> = [];
        for (const r of rows) {
          if (ids.has(r.id) && isStranded(r, cutoff)) {
            r.published_status = 'expired';
            r.status = 'expired';
            r.expired_at = nowIso;
            r.updated_at = nowIso;
            expired.push({ id: r.id, tenant_id: r.tenant_id });
          }
        }
        return { rows: expired, rowCount: expired.length };
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
    },
  };
}

function mkRow(p: Partial<Row> & { id: number }): Row {
  return {
    tenant_id: 1,
    published_status: 'approved',
    status: 'approved',
    published_at: null,
    updated_at: '2026-05-01T00:00:00.000Z', // ~37 days before the fixed now → stranded
    scheduled: false,
    expired_at: null,
    ...p,
  };
}

const NOW = () => new Date('2026-06-07T00:00:00.000Z');
const AGE = 14;

// ---------------------------------------------------------------------------
// Sweep behavior
// ---------------------------------------------------------------------------

test('dry-run: counts candidates + per-tenant, mutates nothing', async () => {
  const rows = [
    mkRow({ id: 1, tenant_id: 15 }),
    mkRow({ id: 2, tenant_id: 15 }),
    mkRow({ id: 3, tenant_id: 7 }),
  ];
  const pool = fakePool(rows);
  const report = await runDraftExpirySweep(pool, { dryRun: true, ageDays: AGE, now: NOW });

  assert.equal(report.candidates, 3);
  assert.equal(report.expired, 0);
  assert.equal(report.batches, 0);
  assert.deepEqual(report.byTenant, [
    { tenantId: '15', candidates: 2 },
    { tenantId: '7', candidates: 1 },
  ]);
  // Nothing mutated.
  assert.ok(rows.every((r) => r.published_status === 'approved'));
});

test('commit: expires exactly the stranded population, nothing else', async () => {
  const rows = [
    mkRow({ id: 1 }), // stranded approved
    mkRow({ id: 2, published_status: 'draft', status: 'draft' }), // stranded draft
    mkRow({ id: 3, published_status: 'in_review', status: 'in_review' }), // stranded in_review
    mkRow({ id: 4, scheduled: true }), // has a scheduled_posts row → NOT touched
    mkRow({ id: 5, published_at: '2026-05-02T00:00:00.000Z', published_status: 'published', status: 'published' }), // published → NOT touched
    mkRow({ id: 6, updated_at: '2026-06-06T00:00:00.000Z' }), // 1 day old → too recent → NOT touched
    mkRow({ id: 7, published_status: 'failed', status: 'failed' }), // terminal non-publish → NOT touched
  ];
  const pool = fakePool(rows);
  const report = await runDraftExpirySweep(pool, { dryRun: false, ageDays: AGE, now: NOW });

  assert.equal(report.candidates, 3);
  assert.equal(report.expired, 3);
  const expired = new Set(rows.filter((r) => r.published_status === 'expired').map((r) => r.id));
  assert.deepEqual([...expired].sort(), [1, 2, 3]);
  // Untouched rows keep their status.
  assert.equal(rows.find((r) => r.id === 4)!.published_status, 'approved');
  assert.equal(rows.find((r) => r.id === 5)!.published_status, 'published');
  assert.equal(rows.find((r) => r.id === 6)!.published_status, 'approved');
  assert.equal(rows.find((r) => r.id === 7)!.published_status, 'failed');
  // Expired rows get both columns + expired_at.
  const r1 = rows.find((r) => r.id === 1)!;
  assert.equal(r1.status, 'expired');
  assert.ok(r1.expired_at);
});

test('age boundary: updated_at exactly at the cutoff is NOT expired (strict <)', async () => {
  // cutoff = now - 14d = 2026-05-24T00:00:00Z.
  const atCutoff = mkRow({ id: 1, updated_at: '2026-05-24T00:00:00.000Z' }); // == cutoff → not < cutoff
  const justBefore = mkRow({ id: 2, updated_at: '2026-05-23T23:59:59.000Z' }); // < cutoff
  const rows = [atCutoff, justBefore];
  const report = await runDraftExpirySweep(fakePool(rows), { dryRun: false, ageDays: AGE, now: NOW });
  assert.equal(report.expired, 1);
  assert.equal(atCutoff.published_status, 'approved');
  assert.equal(justBefore.published_status, 'expired');
});

test('dual-column OR: divergent rows match via either status column', async () => {
  const viaLegacy = mkRow({ id: 1, published_status: 'published', status: 'approved' });
  const viaCanonical = mkRow({ id: 2, published_status: 'approved', status: 'published' });
  const rows = [viaLegacy, viaCanonical];
  // published_at is null for both (mkRow default), so the published_status/status
  // 'published' label alone does not exempt them — the OR catches the pre-publish side.
  const report = await runDraftExpirySweep(fakePool(rows), { dryRun: false, ageDays: AGE, now: NOW });
  assert.equal(report.expired, 2);
});

test('batching: drains all stranded rows across multiple batches', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => mkRow({ id: i + 1 }));
  const report = await runDraftExpirySweep(fakePool(rows), {
    dryRun: false,
    ageDays: AGE,
    batchSize: 2,
    now: NOW,
  });
  assert.equal(report.candidates, 5);
  assert.equal(report.expired, 5);
  assert.equal(report.batches, 3); // 2 + 2 + 1
  assert.equal(report.truncated, false);
  assert.ok(rows.every((r) => r.published_status === 'expired'));
});

test('truncation: maxBatches backstop stops the loop and flags truncated', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => mkRow({ id: i + 1 }));
  const report = await runDraftExpirySweep(fakePool(rows), {
    dryRun: false,
    ageDays: AGE,
    batchSize: 2,
    maxBatches: 1,
    now: NOW,
  });
  assert.equal(report.candidates, 5);
  assert.equal(report.expired, 2); // only the first batch ran
  assert.equal(report.batches, 1);
  assert.equal(report.truncated, true);
});

test('idempotency: a second run is a clean no-op', async () => {
  const rows = [mkRow({ id: 1 }), mkRow({ id: 2 })];
  const pool = fakePool(rows);
  const first = await runDraftExpirySweep(pool, { dryRun: false, ageDays: AGE, now: NOW });
  assert.equal(first.expired, 2);
  const second = await runDraftExpirySweep(pool, { dryRun: false, ageDays: AGE, now: NOW });
  assert.equal(second.candidates, 0);
  assert.equal(second.expired, 0);
  assert.equal(second.batches, 0);
});

test('never touches a scheduled post even when old + approved', async () => {
  const rows = [mkRow({ id: 1, scheduled: true })];
  const report = await runDraftExpirySweep(fakePool(rows), { dryRun: false, ageDays: AGE, now: NOW });
  assert.equal(report.candidates, 0);
  assert.equal(report.expired, 0);
  assert.equal(rows[0].published_status, 'approved');
});
