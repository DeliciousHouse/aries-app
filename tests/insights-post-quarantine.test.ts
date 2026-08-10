/**
 * tests/insights-post-quarantine.test.ts
 *
 * The dispatcher's object-quarantine seam, driven against an in-memory fake
 * pool (same technique as tests/insights-dispatcher-leg-isolation.test.ts).
 *
 * WHAT BROKE: `last_metrics_fetched_at` was stamped only on SUCCESS and the
 * comments leg had no watermark at all, so a post deleted on-platform answered
 * Graph `(#100)` on every 30-minute tick forever, pushed a fresh legError each
 * time, and pinned its account's sync run at 'partial' indefinitely — tenant
 * 15's "same object ids failing for 72 h+ with no alert".
 *
 * The two legs carry INDEPENDENT strike state. That is not tidiness: with
 * shared columns and the tick's metrics-then-comments order, a post whose
 * metrics succeed and whose comments permanently fail has its counter reset to
 * 0 by the metrics success every tick before the comments failure can increment
 * it to 1. It would never converge — reproducing the exact bug being fixed.
 * That case is pinned below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { syncAccountForTenant } from '@/backend/insights/sync/dispatcher';
import {
  QUARANTINE_STRIKES_PERMANENT,
  QUARANTINE_STRIKES_GENERIC,
  QUARANTINE_NEVER_THRESHOLD,
  REPROBE_AFTER_DAYS,
} from '@/backend/insights/sync/object-health';
import type { InsightsAdapter } from '@/backend/insights/adapters/_adapter.types';

interface Recorded { text: string; params: unknown[] }

const PERMANENT_ERROR =
  "(#100) Object with ID '17900_1' does not exist, cannot be loaded due to missing permissions";

/** Rows the fake pool hands back for a leg's failure UPDATE. */
type FailureRow = { error_count: number; unavailable_at: string | null; was_quarantined: boolean };

interface PoolOpts {
  /** Posts served to BOTH selection queries. */
  posts?: Array<{ id: number; external_post_id: string }>;
  /** What the metrics failure UPDATE returns. */
  metricsFailure?: FailureRow;
  /** What the comments failure UPDATE returns. */
  commentsFailure?: FailureRow;
}

function fakePool(recorded: Recorded[], opts: PoolOpts = {}) {
  const posts = opts.posts ?? [{ id: 10, external_post_id: '17900_1' }];
  const client = {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      recorded.push({ text, params });
      const empty = { rows: [] as T[], rowCount: 0 };

      if (/FROM insights_accounts\s+WHERE id/i.test(text)) {
        return { rows: [{ id: 7, platform: 'facebook', external_account_id: 'PAGE123' }] as unknown as T[], rowCount: 1 };
      }
      if (/^\s*SELECT[\s\S]*FROM connected_accounts/i.test(text)) {
        return {
          rows: [{
            id: 1, tenant_id: 42, external_user_id: 'u', platform: 'facebook', provider: 'composio',
            connected_account_id: 'ca_1', auth_config_id: 'ac', external_account_id: 'PAGE123',
            external_account_name: 'Page', status: 'connected', capabilities_json: null,
            last_capability_check_at: null, created_at: new Date(0), updated_at: new Date(0),
          }] as unknown as T[],
          rowCount: 1,
        };
      }
      if (/INSERT INTO insights_sync_runs/i.test(text)) {
        return { rows: [{ id: 99 }] as unknown as T[], rowCount: 1 };
      }
      if (/SELECT id, external_post_id\s+FROM insights_posts/i.test(text)) {
        return { rows: posts as unknown as T[], rowCount: posts.length };
      }
      if (/UPDATE insights_posts p/i.test(text) && /metrics_error_count\s*=\s*p\.metrics_error_count\s*\+\s*1/i.test(text)) {
        const row = opts.metricsFailure ?? { error_count: 1, unavailable_at: null, was_quarantined: false };
        return { rows: [row] as unknown as T[], rowCount: 1 };
      }
      if (/UPDATE insights_posts p/i.test(text) && /comments_error_count\s*=\s*p\.comments_error_count\s*\+\s*1/i.test(text)) {
        const row = opts.commentsFailure ?? { error_count: 1, unavailable_at: null, was_quarantined: false };
        return { rows: [row] as unknown as T[], rowCount: 1 };
      }
      return empty;
    },
    release() {},
  };
  return { async connect() { return client; } };
}

const baseAdapter: InsightsAdapter = {
  platform: 'facebook',
  fetchPostList: async () => [],
  fetchAccountMetrics: async () => [],
  fetchPostMetrics: async () => [],
  fetchComments: async () => [],
};

function metricsSelect(recorded: Recorded[]): Recorded {
  const q = recorded.find((r) => /SELECT id, external_post_id/i.test(r.text) && /last_metrics_fetched_at/i.test(r.text));
  assert.ok(q, 'the per-post metrics selection query ran');
  return q!;
}
function commentsSelect(recorded: Recorded[]): Recorded {
  const q = recorded.find((r) => /SELECT id, external_post_id/i.test(r.text) && /INTERVAL '30 days'/i.test(r.text));
  assert.ok(q, 'the comments selection query ran');
  return q!;
}

// ── Selection ───────────────────────────────────────────────────────────────

test('both selection queries exclude quarantined objects, each on its OWN column', async () => {
  const recorded: Recorded[] = [];
  await syncAccountForTenant(42, 7, 'interval', { pool: fakePool(recorded), resolveAdapter: () => baseAdapter });

  const metrics = metricsSelect(recorded).text;
  assert.match(metrics, /metrics_unavailable_at IS NULL/);
  assert.match(metrics, new RegExp(`metrics_unavailable_at < now\\(\\) - INTERVAL '${REPROBE_AFTER_DAYS} days'`));
  assert.doesNotMatch(metrics, /comments_unavailable_at/, 'the metrics leg must not filter on the comments watermark');

  const comments = commentsSelect(recorded).text;
  assert.match(comments, /comments_unavailable_at IS NULL/);
  assert.match(comments, new RegExp(`comments_unavailable_at < now\\(\\) - INTERVAL '${REPROBE_AFTER_DAYS} days'`));
  assert.doesNotMatch(comments, /metrics_unavailable_at/, 'the comments leg must not filter on the metrics watermark');
});

// ── Failure write ───────────────────────────────────────────────────────────

test('a failure is ONE atomic UPDATE: increment, stamp, and threshold test in the same statement', async () => {
  const recorded: Recorded[] = [];
  const adapter: InsightsAdapter = {
    ...baseAdapter,
    fetchPostMetrics: async () => { throw new Error(PERMANENT_ERROR); },
  };
  await syncAccountForTenant(42, 7, 'interval', { pool: fakePool(recorded), resolveAdapter: () => adapter });

  const update = recorded.find((r) => /metrics_error_count\s*=\s*p\.metrics_error_count\s*\+\s*1/i.test(r.text));
  assert.ok(update, 'the metrics failure UPDATE ran');
  // No read-then-write: nothing SELECTs the counter before the UPDATE. That
  // race would drop strikes against a concurrent 'handler'-triggered sync and
  // against the deploy note's manual pre-quarantine SQL.
  const counterReads = recorded.filter((r) => /^\s*SELECT/i.test(r.text) && /metrics_error_count/i.test(r.text));
  assert.equal(counterReads.length, 0, 'the failure path must not read the counter before writing it');

  assert.match(update!.text, /metrics_last_error\s*=\s*\$2/);
  assert.match(update!.text, /metrics_unavailable_at = CASE/);
  assert.match(update!.text, /p\.metrics_error_count\s*\+\s*1\s*>=\s*\$3/);
  assert.match(update!.text, /RETURNING/);
  // Threshold is computed in JS from isPermanentObjectError and bound as $3.
  assert.equal(update!.params[0], 10);
  assert.match(String(update!.params[1]), /#100/);
  assert.equal(update!.params[2], QUARANTINE_STRIKES_PERMANENT);
});

test('a FAILED re-probe re-stamps the quarantine clock (otherwise the object is re-selected forever)', async () => {
  // The bug this pins: the watermark used to be written only `WHEN ... IS NULL`,
  // so a failed re-probe left the ORIGINAL quarantine date in place. Once that
  // date aged past REPROBE_AFTER_DAYS the notQuarantined predicate was
  // permanently true and the dead object came back on EVERY 30-minute tick —
  // silently, because was_quarantined suppresses its legError.
  const recorded: Recorded[] = [];
  const adapter: InsightsAdapter = {
    ...baseAdapter,
    fetchPostMetrics: async () => { throw new Error(PERMANENT_ERROR); },
    fetchComments: async () => { throw new Error(PERMANENT_ERROR); },
  };
  // An object quarantined long enough ago that the re-probe window re-admitted
  // it: this run IS the re-probe, and it failed.
  const longAgo = new Date(Date.now() - (REPROBE_AFTER_DAYS + 3) * 86_400_000).toISOString();
  const result = await syncAccountForTenant(42, 7, 'interval', {
    pool: fakePool(recorded, {
      metricsFailure:  { error_count: 12, unavailable_at: longAgo, was_quarantined: true },
      commentsFailure: { error_count: 12, unavailable_at: longAgo, was_quarantined: true },
    }),
    resolveAdapter: () => adapter,
  });

  for (const leg of ['metrics', 'comments'] as const) {
    const update = recorded.find((r) => new RegExp(`${leg}_error_count\\s*=\\s*p\\.${leg}_error_count\\s*\\+\\s*1`, 'i').test(r.text));
    assert.ok(update, `the ${leg} failure UPDATE ran`);
    const sql = update!.text;
    const restamp = sql.search(new RegExp(`WHEN p\\.${leg}_unavailable_at IS NOT NULL THEN now\\(\\)`, 'i'));
    const cross = sql.search(new RegExp(`WHEN p\\.${leg}_error_count\\s*\\+\\s*1\\s*>=\\s*\\$3 THEN now\\(\\)`, 'i'));
    assert.ok(restamp > 0, `the ${leg} CASE re-stamps an already-quarantined object`);
    assert.ok(cross > 0, `the ${leg} CASE still stamps on crossing the threshold`);
    assert.ok(
      restamp < cross,
      `the re-stamp arm must come FIRST — a later arm never runs for a quarantined row (${leg})`,
    );
    // The old shape. If this ever comes back the object leaks ~96 calls/day.
    assert.doesNotMatch(
      sql,
      new RegExp(`p\\.${leg}_unavailable_at IS NULL AND`, 'i'),
      `the ${leg} stamp must not be gated on the watermark being NULL`,
    );
  }

  // The re-probe stays silent and uncounted: it is not a new quarantine.
  assert.equal(result.quarantined, 0, 'a re-probe failure is not a new 0→quarantined transition');
  assert.equal(result.status, 'ok', 'an already-quarantined object must not re-poison the run status');
});

test('an unrecognised error with no sibling success binds the never-quarantine threshold', async () => {
  // postSpecific is false (nothing succeeded yet, error not recognisably
  // permanent) — a platform-wide outage must not quarantine an account's whole
  // history on one bad afternoon.
  const recorded: Recorded[] = [];
  const adapter: InsightsAdapter = {
    ...baseAdapter,
    fetchPostMetrics: async () => { throw new Error('HTTP 502 Bad Gateway'); },
  };
  await syncAccountForTenant(42, 7, 'interval', { pool: fakePool(recorded), resolveAdapter: () => adapter });
  const update = recorded.find((r) => /metrics_error_count\s*=\s*p\.metrics_error_count\s*\+\s*1/i.test(r.text));
  assert.equal(update!.params[2], QUARANTINE_NEVER_THRESHOLD);
});

test('a sibling success in the same run makes later failures object-specific', async () => {
  const recorded: Recorded[] = [];
  const adapter: InsightsAdapter = {
    ...baseAdapter,
    fetchPostMetrics: async (externalPostId: string) => {
      if (externalPostId === 'ok_1') return [];
      throw new Error('some unrecognised platform error');
    },
  };
  await syncAccountForTenant(42, 7, 'interval', {
    pool: fakePool(recorded, { posts: [{ id: 1, external_post_id: 'ok_1' }, { id: 2, external_post_id: 'bad_2' }] }),
    resolveAdapter: () => adapter,
  });
  const update = recorded.find((r) => /metrics_error_count\s*=\s*p\.metrics_error_count\s*\+\s*1/i.test(r.text));
  assert.equal(update!.params[0], 2);
  assert.equal(update!.params[2], QUARANTINE_STRIKES_GENERIC, 'a proven-live sibling makes the generic threshold reachable');
});

// ── Success write ───────────────────────────────────────────────────────────

test('the metrics success UPDATE resets only the metrics leg, and still stamps the watermark', async () => {
  const recorded: Recorded[] = [];
  await syncAccountForTenant(42, 7, 'interval', { pool: fakePool(recorded), resolveAdapter: () => baseAdapter });
  const ok = recorded.find((r) => /last_metrics_fetched_at = now\(\)/i.test(r.text));
  assert.ok(ok, 'the metrics success UPDATE ran');
  assert.match(ok!.text, /metrics_error_count\s*=\s*0/);
  assert.match(ok!.text, /metrics_last_error\s*=\s*NULL/);
  assert.match(ok!.text, /metrics_unavailable_at\s*=\s*NULL/);
  assert.doesNotMatch(ok!.text, /comments_error_count/, 'the metrics success must NOT reset the comments counter');
});

test('the comments success UPDATE resets only the comments leg', async () => {
  const recorded: Recorded[] = [];
  await syncAccountForTenant(42, 7, 'interval', { pool: fakePool(recorded), resolveAdapter: () => baseAdapter });
  const ok = recorded.find((r) => /comments_error_count\s*=\s*0/i.test(r.text));
  assert.ok(ok, 'the comments success UPDATE ran');
  assert.match(ok!.text, /comments_last_error\s*=\s*NULL/);
  assert.match(ok!.text, /comments_unavailable_at\s*=\s*NULL/);
  assert.doesNotMatch(ok!.text, /metrics_error_count/, 'the comments success must NOT reset the metrics counter');
  assert.doesNotMatch(ok!.text, /last_metrics_fetched_at/);
  // The comments leg has no watermark to stamp, so a clean post must be a
  // no-op — otherwise every healthy account dirties up to 20 rows per tick,
  // forever, for nothing.
  assert.match(ok!.text, /AND \(comments_error_count <> 0/);
  assert.match(ok!.text, /OR comments_unavailable_at IS NOT NULL\)/);
});

// ── The reviewer's convergence case ─────────────────────────────────────────

test('metrics OK + comments permanently failing still converges to a comments quarantine', async () => {
  // With shared columns this is the case that never converges: the metrics
  // success resets the counter to 0 every tick before the comments failure can
  // increment it. Independent columns are what make it terminate.
  const recorded: Recorded[] = [];
  const adapter: InsightsAdapter = {
    ...baseAdapter,
    fetchPostMetrics: async () => [],                              // metrics fine
    fetchComments: async () => { throw new Error(PERMANENT_ERROR); }, // comments dead
  };
  const result = await syncAccountForTenant(42, 7, 'interval', {
    pool: fakePool(recorded, {
      // The strike that crosses: was NOT quarantined, now IS.
      commentsFailure: { error_count: QUARANTINE_STRIKES_PERMANENT, unavailable_at: '2026-08-10T00:00:00Z', was_quarantined: false },
    }),
    resolveAdapter: () => adapter,
  });

  const metricsOk = recorded.find((r) => /last_metrics_fetched_at = now\(\)/i.test(r.text));
  assert.ok(metricsOk, 'the metrics leg still succeeded');

  const commentsFail = recorded.find((r) => /comments_error_count\s*=\s*p\.comments_error_count\s*\+\s*1/i.test(r.text));
  assert.ok(commentsFail, 'the comments failure was recorded against the COMMENTS counter');
  assert.equal(commentsFail!.params[2], QUARANTINE_STRIKES_PERMANENT);

  assert.equal(result.quarantined, 1, 'the 0→quarantined transition is counted');
  // The transition strike still reports, so the last failure is never silent.
  assert.match(String(result.errorMessage), /fetchComments/);
  assert.equal(result.status, 'partial');
});

// ── Un-poisoning the run status ─────────────────────────────────────────────

test('an ALREADY-quarantined object pushes no legError — the run returns to ok', async () => {
  const recorded: Recorded[] = [];
  const adapter: InsightsAdapter = {
    ...baseAdapter,
    fetchPostMetrics: async () => { throw new Error(PERMANENT_ERROR); },
    fetchComments: async () => { throw new Error(PERMANENT_ERROR); },
  };
  const result = await syncAccountForTenant(42, 7, 'interval', {
    pool: fakePool(recorded, {
      metricsFailure:  { error_count: 9, unavailable_at: '2026-07-01T00:00:00Z', was_quarantined: true },
      commentsFailure: { error_count: 9, unavailable_at: '2026-07-01T00:00:00Z', was_quarantined: true },
    }),
    resolveAdapter: () => adapter,
  });

  assert.equal(result.status, 'ok', 'a converged account must stop being permanently partial');
  assert.equal(result.errorMessage, undefined);
  assert.equal(result.quarantined, 0, 'an already-quarantined object is not re-counted');
  const okTerminal = recorded.find((r) => /UPDATE insights_sync_runs[\s\S]*status\s*=\s*'ok'/i.test(r.text));
  assert.ok(okTerminal, 'the ok fast-path ran');
});

test('a not-yet-quarantined failure still reports normally (nothing is silenced early)', async () => {
  const recorded: Recorded[] = [];
  const adapter: InsightsAdapter = {
    ...baseAdapter,
    fetchPostMetrics: async () => { throw new Error(PERMANENT_ERROR); },
  };
  const result = await syncAccountForTenant(42, 7, 'interval', {
    pool: fakePool(recorded, { metricsFailure: { error_count: 1, unavailable_at: null, was_quarantined: false } }),
    resolveAdapter: () => adapter,
  });
  assert.equal(result.status, 'partial');
  assert.match(String(result.errorMessage), /fetchPostMetrics\(17900_1\)/);
  assert.equal(result.quarantined, 0);
});

test('a failure-write outage degrades to today behaviour rather than swallowing the error', async () => {
  // recordObjectFailure never throws; if the strike cannot be persisted the
  // error must still reach legErrors so the run is visibly partial.
  const recorded: Recorded[] = [];
  const base = fakePool(recorded);
  const brokenPool = {
    async connect() {
      const client = await base.connect();
      return {
        async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
          if (/metrics_error_count\s*=\s*p\.metrics_error_count\s*\+\s*1/i.test(text)) {
            throw new Error('deadlock detected');
          }
          return client.query<T>(text, params);
        },
        release() {},
      };
    },
  };
  const adapter: InsightsAdapter = {
    ...baseAdapter,
    fetchPostMetrics: async () => { throw new Error(PERMANENT_ERROR); },
  };
  const warnings: string[] = [];
  const previousWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map((a) => JSON.stringify(a) ?? String(a)).join(' ')); };
  let result;
  try {
    result = await syncAccountForTenant(42, 7, 'interval', { pool: brokenPool, resolveAdapter: () => adapter });
  } finally {
    console.warn = previousWarn;
  }
  assert.equal(result.status, 'partial');
  assert.match(String(result.errorMessage), /fetchPostMetrics/);
  assert.equal(result.quarantined, 0);
  // …and it says so. A silently failing strike write means quarantine never
  // engages, which is invisible from every other signal this module emits.
  const strikeWarning = warnings.find((w) => w.includes('strike write failed'));
  assert.ok(strikeWarning, `the failed strike write must be logged, got: ${JSON.stringify(warnings)}`);
  assert.match(strikeWarning!, /deadlock detected/, 'the underlying error is carried through');
  assert.match(strikeWarning!, /metrics/, 'the leg is named');
});

// ── Account-level gating ────────────────────────────────────────────────────

test('syncAllAccountsForTenant only fans out over accounts that are not disabled', async () => {
  // Read the SQL from the module surface: the fan-out uses the global pool, so
  // assert on the statement text the dispatcher declares rather than executing
  // it. (The per-account path is covered above.)
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../backend/insights/sync/dispatcher.ts', import.meta.url), 'utf8'));
  assert.match(src, /SELECT id, platform FROM insights_accounts WHERE tenant_id = \$1 AND disabled_at IS NULL/);
});
