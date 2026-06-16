/**
 * Missing-Hermes-asset GC sweep — self-contained unit tests (no live DB).
 *
 * Covers (qa-defect #599):
 *   - the flag / interval / age / dry-run parsers consumed by the worker;
 *   - the SQL constants' shape (both re-assert storage_kind='runtime_asset' so an
 *     ingested upload / composed story can never be orphaned);
 *   - the sweep orchestration driven against an in-memory fake GcDb + a real
 *     tmpdir mount: a present file is never orphaned, an evicted file older than
 *     the grace window is orphaned exactly once, an evicted-but-fresh file is
 *     spared (the false-positive guard), an unset mount is a fail-safe no-op, and
 *     a second run is idempotent.
 *
 * The fake GcDb is the oracle: it implements `orphaned_at IS NULL` +
 * `storage_kind='runtime_asset'` in JS and dispatches on the exact exported SQL
 * strings, so drift between the constants would fail dispatch loudly. Real
 * Postgres planner/column coverage can be added as a *.requires-infra test later.
 *
 * Run:
 *   ./node_modules/.bin/tsx --test tests/marketing/gc-missing-hermes-assets.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  runGcMissingHermesAssets,
  gcEnabled,
  gcDryRun,
  resolveGcIntervalMs,
  resolveGcMaxAgeDays,
  DEFAULT_GC_INTERVAL_MS,
  DEFAULT_GC_MAX_AGE_DAYS,
  SELECT_RUNTIME_ASSETS_SQL,
  MARK_ORPHAN_SQL,
  type GcDb,
} from '../../scripts/gc-missing-hermes-assets';

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

test('gcEnabled: truthy variants only; default off', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
    assert.equal(gcEnabled({ ARIES_HERMES_GC_ENABLED: v } as unknown as NodeJS.ProcessEnv), true, v);
  }
  for (const v of ['', '0', 'false', 'no', 'off', undefined, 'enable']) {
    assert.equal(
      gcEnabled({ ARIES_HERMES_GC_ENABLED: v } as unknown as NodeJS.ProcessEnv),
      false,
      String(v),
    );
  }
});

test('gcDryRun: truthy variants only; default off', () => {
  assert.equal(gcDryRun({ ARIES_HERMES_GC_DRY_RUN: '1' } as unknown as NodeJS.ProcessEnv), true);
  assert.equal(gcDryRun({ ARIES_HERMES_GC_DRY_RUN: 'yes' } as unknown as NodeJS.ProcessEnv), true);
  assert.equal(gcDryRun({} as unknown as NodeJS.ProcessEnv), false);
  assert.equal(gcDryRun({ ARIES_HERMES_GC_DRY_RUN: '0' } as unknown as NodeJS.ProcessEnv), false);
});

test('resolveGcIntervalMs: default + override + fallback on garbage', () => {
  assert.equal(resolveGcIntervalMs({} as unknown as NodeJS.ProcessEnv), DEFAULT_GC_INTERVAL_MS);
  assert.equal(
    resolveGcIntervalMs({ ARIES_HERMES_GC_INTERVAL_MS: '60000' } as unknown as NodeJS.ProcessEnv),
    60000,
  );
  for (const bad of ['0', '-5', 'abc', '']) {
    assert.equal(
      resolveGcIntervalMs({ ARIES_HERMES_GC_INTERVAL_MS: bad } as unknown as NodeJS.ProcessEnv),
      DEFAULT_GC_INTERVAL_MS,
      bad,
    );
  }
});

test('resolveGcMaxAgeDays: default 7 + override + fallback on garbage', () => {
  assert.equal(resolveGcMaxAgeDays({} as unknown as NodeJS.ProcessEnv), DEFAULT_GC_MAX_AGE_DAYS);
  assert.equal(DEFAULT_GC_MAX_AGE_DAYS, 7);
  assert.equal(resolveGcMaxAgeDays({ ARIES_HERMES_GC_MAX_AGE_DAYS: '30' } as unknown as NodeJS.ProcessEnv), 30);
  for (const bad of ['0', '-1', 'soon', '']) {
    assert.equal(
      resolveGcMaxAgeDays({ ARIES_HERMES_GC_MAX_AGE_DAYS: bad } as unknown as NodeJS.ProcessEnv),
      DEFAULT_GC_MAX_AGE_DAYS,
      bad,
    );
  }
});

// ---------------------------------------------------------------------------
// SQL shape — the never-touch-ingested_asset invariant
// ---------------------------------------------------------------------------

test('SELECT only runtime_asset rows that are not already orphaned', () => {
  assert.ok(SELECT_RUNTIME_ASSETS_SQL.includes("storage_kind = 'runtime_asset'"));
  assert.ok(SELECT_RUNTIME_ASSETS_SQL.includes('orphaned_at IS NULL'));
  assert.ok(SELECT_RUNTIME_ASSETS_SQL.includes('storage_key IS NOT NULL'));
});

test('MARK re-asserts runtime_asset + not-already-orphaned (race guard)', () => {
  assert.ok(MARK_ORPHAN_SQL.includes('SET orphaned_at = $2'));
  assert.ok(MARK_ORPHAN_SQL.includes('WHERE id = $1'));
  assert.ok(MARK_ORPHAN_SQL.includes("storage_kind = 'runtime_asset'"));
  assert.ok(MARK_ORPHAN_SQL.includes('orphaned_at IS NULL'));
});

// ---------------------------------------------------------------------------
// In-memory fake GcDb (the oracle) + real tmpdir mount
// ---------------------------------------------------------------------------

type FakeRow = {
  id: string;
  tenant_id: string;
  storage_key: string | null;
  created_at: string; // ISO
  orphaned_at: string | null;
  storage_kind: string;
};

/** Dispatches on the exact exported SQL; mirrors orphaned_at IS NULL + runtime_asset. */
function fakeDb(rows: FakeRow[]): GcDb {
  return {
    async query(sql: string, params: unknown[] = []) {
      if (sql === SELECT_RUNTIME_ASSETS_SQL) {
        const out = rows
          .filter(
            (r) => r.storage_kind === 'runtime_asset' && r.storage_key !== null && r.orphaned_at === null,
          )
          .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
          .map((r) => ({
            id: r.id,
            tenant_id: r.tenant_id,
            storage_key: r.storage_key,
            created_at: r.created_at,
          }));
        return { rows: out, rowCount: out.length };
      }
      if (sql === MARK_ORPHAN_SQL) {
        const [id, ts] = params as [string, string];
        const r = rows.find(
          (x) => x.id === id && x.storage_kind === 'runtime_asset' && x.orphaned_at === null,
        );
        if (r) {
          r.orphaned_at = ts;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 40)}`);
    },
  };
}

function mkRow(p: Partial<FakeRow> & { id: string; storage_key: string }): FakeRow {
  return {
    tenant_id: '15',
    created_at: '2026-05-01T00:00:00.000Z', // ~46 days before the fixed now → past grace
    orphaned_at: null,
    storage_kind: 'runtime_asset',
    ...p,
  };
}

const NOW = () => new Date('2026-06-16T00:00:00.000Z');
const AGE = 7; // cutoff = now - 7d = 2026-06-09T00:00:00Z

function withMount(fn: (mountRoot: string, present: (key: string) => void) => Promise<void>) {
  return async () => {
    const mountRoot = mkdtempSync(path.join(tmpdir(), 'gc-hermes-'));
    const present = (key: string) =>
      writeFileSync(path.join(mountRoot, path.basename(key)), 'png-bytes');
    try {
      await fn(mountRoot, present);
    } finally {
      rmSync(mountRoot, { recursive: true, force: true });
    }
  };
}

// ---------------------------------------------------------------------------
// Sweep behavior
// ---------------------------------------------------------------------------

test(
  'evicted file older than grace → orphaned exactly once',
  withMount(async (mountRoot) => {
    const rows = [mkRow({ id: 'a', storage_key: 'evicted_a.png' })]; // file NOT written → missing
    const stats = await runGcMissingHermesAssets({ dryRun: false, db: fakeDb(rows), mountRoot, maxAgeDays: AGE, now: NOW });
    assert.equal(stats.scanned, 1);
    assert.equal(stats.rowsOrphaned, 1);
    assert.equal(stats.fileStillPresent, 0);
    assert.equal(stats.tooNew, 0);
    assert.ok(rows[0].orphaned_at, 'row marked orphaned_at');
  }),
);

test(
  'present file → never orphaned',
  withMount(async (mountRoot, present) => {
    const rows = [mkRow({ id: 'a', storage_key: 'present_a.png' })];
    present('present_a.png');
    const stats = await runGcMissingHermesAssets({ dryRun: false, db: fakeDb(rows), mountRoot, maxAgeDays: AGE, now: NOW });
    assert.equal(stats.fileStillPresent, 1);
    assert.equal(stats.rowsOrphaned, 0);
    assert.equal(rows[0].orphaned_at, null);
  }),
);

test(
  'evicted but within grace → tooNew, spared (false-positive guard)',
  withMount(async (mountRoot) => {
    // created 1 day before now, well inside the 7-day grace; file missing.
    const rows = [mkRow({ id: 'a', storage_key: 'fresh_a.png', created_at: '2026-06-15T00:00:00.000Z' })];
    const stats = await runGcMissingHermesAssets({ dryRun: false, db: fakeDb(rows), mountRoot, maxAgeDays: AGE, now: NOW });
    assert.equal(stats.tooNew, 1);
    assert.equal(stats.rowsOrphaned, 0);
    assert.equal(rows[0].orphaned_at, null);
  }),
);

test(
  'dry-run: lists candidate, mutates nothing',
  withMount(async (mountRoot) => {
    const rows = [mkRow({ id: 'a', storage_key: 'evicted_a.png' })];
    const stats = await runGcMissingHermesAssets({ dryRun: true, db: fakeDb(rows), mountRoot, maxAgeDays: AGE, now: NOW });
    assert.equal(stats.candidates.length, 1);
    assert.equal(stats.rowsOrphaned, 0);
    assert.equal(rows[0].orphaned_at, null);
  }),
);

test('unset mount → fail-safe no-op (no rows touched)', async () => {
  const rows = [mkRow({ id: 'a', storage_key: 'evicted_a.png' })];
  // Empty mountRoot short-circuits before reading process.env, so this is
  // deterministic regardless of the ambient HERMES_IMAGE_CACHE_MOUNT.
  const stats = await runGcMissingHermesAssets({ dryRun: false, db: fakeDb(rows), mountRoot: '', maxAgeDays: AGE, now: NOW });
  assert.equal(stats.scanned, 0);
  assert.equal(stats.rowsOrphaned, 0);
  assert.equal(rows[0].orphaned_at, null);
});

test(
  'mixed population: only evicted-and-old rows orphaned',
  withMount(async (mountRoot, present) => {
    const rows = [
      mkRow({ id: 'evicted-old', storage_key: 'eo.png' }), // missing + old → orphan
      mkRow({ id: 'present', storage_key: 'p.png' }), // present → keep
      mkRow({ id: 'fresh', storage_key: 'f.png', created_at: '2026-06-15T00:00:00.000Z' }), // missing + fresh → keep
    ];
    present('p.png');
    const stats = await runGcMissingHermesAssets({ dryRun: false, db: fakeDb(rows), mountRoot, maxAgeDays: AGE, now: NOW });
    assert.equal(stats.rowsOrphaned, 1);
    assert.equal(rows.find((r) => r.id === 'evicted-old')!.orphaned_at !== null, true);
    assert.equal(rows.find((r) => r.id === 'present')!.orphaned_at, null);
    assert.equal(rows.find((r) => r.id === 'fresh')!.orphaned_at, null);
  }),
);

test(
  'idempotency: a second run is a clean no-op',
  withMount(async (mountRoot) => {
    const rows = [mkRow({ id: 'a', storage_key: 'evicted_a.png' })];
    const db = fakeDb(rows);
    const first = await runGcMissingHermesAssets({ dryRun: false, db, mountRoot, maxAgeDays: AGE, now: NOW });
    assert.equal(first.rowsOrphaned, 1);
    const second = await runGcMissingHermesAssets({ dryRun: false, db, mountRoot, maxAgeDays: AGE, now: NOW });
    assert.equal(second.scanned, 0, 'orphaned row leaves the SELECT predicate');
    assert.equal(second.rowsOrphaned, 0);
  }),
);
