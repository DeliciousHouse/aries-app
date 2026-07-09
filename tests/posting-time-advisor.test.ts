/**
 * AI posting-time advisor (backend/marketing/posting-time-advisor.ts).
 *
 * Fully in-memory: a fake queryable routed by SQL shape stands in for the
 * pool, and the competitor Hermes leg runs against an injected fetchImpl (the
 * same testability seam as classify-comments / brand-kit-enrich). No live
 * database, no network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyticsRecommendationFromBuckets,
  deriveAndPersistPostingTimes,
  deriveCompetitorPostingTimes,
  loadPostingTimeOverrides,
  MIN_ANALYTICS_POSTS_DEFAULT,
  type AnalyticsBucket,
  type PostingTimeQueryable,
} from '../backend/marketing/posting-time-advisor';

// ── Fixtures ────────────────────────────────────────────────────────────────

const FLAG_ON = { ARIES_AI_POSTING_TIMES_ENABLED: '1' };

const HERMES_ENV = {
  ...FLAG_ON,
  HERMES_GATEWAY_URL: 'https://hermes.example.com',
  HERMES_API_SERVER_KEY: 'test-key',
};

type FakeCall = { sql: string; params: unknown[] };

/**
 * Fake queryable routed by SQL shape. `analyticsBucketsByPlatform` feeds the
 * WITH per_post query per platform ($2); `latestDerivedAt` feeds the TTL
 * freshness SELECT; `claimGranted` drives the cross-process claim INSERT;
 * upserts + claim releases are recorded in `calls`.
 */
function makeFakeDb(options: {
  latestDerivedAt?: Date | null;
  analyticsBucketsByPlatform?: Record<string, AnalyticsBucket[]>;
  claimGranted?: boolean;
} = {}) {
  const calls: FakeCall[] = [];
  const queryable: PostingTimeQueryable = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const norm = sql.replace(/\s+/g, ' ').trim();
      if (norm.startsWith('INSERT INTO marketing_posting_time_claims')) {
        const granted = options.claimGranted !== false;
        return { rows: granted ? [{ tenant_id: params[0] }] : [], rowCount: granted ? 1 : 0 };
      }
      if (norm.startsWith('DELETE FROM marketing_posting_time_claims')) {
        return { rows: [], rowCount: 1 };
      }
      if (norm.startsWith('SELECT MAX(derived_at)')) {
        return { rows: [{ derived_at: options.latestDerivedAt ?? null }], rowCount: 1 };
      }
      if (norm.startsWith('WITH per_post')) {
        const platform = String(params[1]);
        return { rows: options.analyticsBucketsByPlatform?.[platform] ?? [], rowCount: 0 };
      }
      if (norm.startsWith('INSERT INTO marketing_posting_times')) {
        return { rows: [], rowCount: 1 };
      }
      if (norm.startsWith('SELECT platform, hour, minute, days FROM marketing_posting_times')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { queryable, calls };
}

function upsertCalls(calls: FakeCall[]): FakeCall[] {
  return calls.filter((c) => c.sql.replace(/\s+/g, ' ').trim().startsWith('INSERT INTO marketing_posting_times ('));
}

function claimReleaseCalls(calls: FakeCall[]): FakeCall[] {
  return calls.filter((c) => c.sql.replace(/\s+/g, ' ').trim().startsWith('DELETE FROM marketing_posting_time_claims'));
}

/** Fake Hermes: submit returns a run id; poll returns a completed run whose output is `outputText`. */
function makeFakeHermes(outputText: string, pollStatus = 'completed') {
  const requests: Array<{ url: string; method: string }> = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ url, method });
    if (method === 'POST' && url.endsWith('/v1/runs')) {
      return new Response(JSON.stringify({ run_id: 'run-1' }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: pollStatus, output: outputText }), { status: 200 });
  };
  return { fetchImpl, requests };
}

const noSleep = async () => {};

// ── analyticsRecommendationFromBuckets (pure) ───────────────────────────────

test('analytics recommendation: picks the engagement-weighted best hour and top days', () => {
  const buckets: AnalyticsBucket[] = [
    { day_of_week: 2, hour_of_day: 19, post_count: 5, avg_engagement: 50 },
    { day_of_week: 4, hour_of_day: 11, post_count: 4, avg_engagement: 20 },
    { day_of_week: 6, hour_of_day: 19, post_count: 2, avg_engagement: 80 },
  ];
  const rec = analyticsRecommendationFromBuckets(buckets, MIN_ANALYTICS_POSTS_DEFAULT);
  assert.ok(rec, 'sample of 11 posts should clear the default threshold');
  assert.equal(rec.hour, 19, '19:00 has the highest weighted average engagement');
  assert.equal(rec.sampleSize, 11);
  assert.deepEqual(rec.days, [6, 2, 4], 'days ranked by average engagement');
});

test('analytics recommendation: below-threshold sample returns null', () => {
  const buckets: AnalyticsBucket[] = [
    { day_of_week: 2, hour_of_day: 19, post_count: 3, avg_engagement: 50 },
  ];
  assert.equal(analyticsRecommendationFromBuckets(buckets, 8), null);
});

test('analytics recommendation: an hour needs >= 2 posts to win', () => {
  const buckets: AnalyticsBucket[] = [
    // A single viral post must not define the hour.
    { day_of_week: 2, hour_of_day: 3, post_count: 1, avg_engagement: 9999 },
    { day_of_week: 3, hour_of_day: 12, post_count: 8, avg_engagement: 30 },
  ];
  const rec = analyticsRecommendationFromBuckets(buckets, 8);
  assert.ok(rec);
  assert.equal(rec.hour, 12, 'the single-post 03:00 bucket must be ignored');
});

test('analytics recommendation: no hour clears the per-hour minimum → null (competitor fallback)', () => {
  const buckets: AnalyticsBucket[] = Array.from({ length: 9 }, (_, i) => ({
    day_of_week: i % 7,
    hour_of_day: i, // every post at a different hour — no bucket reaches 2
    post_count: 1,
    avg_engagement: 10,
  }));
  assert.equal(analyticsRecommendationFromBuckets(buckets, 8), null);
});

// ── deriveCompetitorPostingTimes ────────────────────────────────────────────

test('competitor derivation: parses and validates the JSON envelope', async () => {
  const { fetchImpl } = makeFakeHermes(
    JSON.stringify({
      status: 'ok',
      output: [
        { platform: 'Facebook', hour: 14, minute: 30, days: [1, 3, 5, 3], rationale: 'Weekday afternoons' },
        { platform: 'instagram', hour: 99, minute: 0, days: [], rationale: 'garbage hour — must be dropped' },
        { platform: 'tiktok', hour: 9, minute: 0, days: [], rationale: 'unrequested platform — dropped' },
      ],
    }),
  );
  const result = await deriveCompetitorPostingTimes({
    competitorUrl: 'https://competitor.example.com',
    timezone: 'America/New_York',
    platforms: ['instagram', 'facebook'],
    env: HERMES_ENV,
    fetchImpl,
    sleep: noSleep,
  });
  assert.ok(result.ok, 'a valid envelope should parse');
  assert.equal(result.recommendations.size, 1, 'only the valid facebook row survives');
  const fb = result.recommendations.get('facebook');
  assert.ok(fb);
  assert.equal(fb.hour, 14);
  assert.equal(fb.minute, 30);
  assert.deepEqual(fb.days, [1, 3, 5], 'days deduped and range-validated');
});

test('competitor derivation: missing config → not_configured, never throws', async () => {
  const result = await deriveCompetitorPostingTimes({
    competitorUrl: 'https://competitor.example.com',
    timezone: 'America/New_York',
    platforms: ['instagram'],
    env: { ...FLAG_ON },
    sleep: noSleep,
  });
  assert.deepEqual(result, { ok: false, reason: 'not_configured' });
});

test('competitor derivation: terminal failed run → run_failed', async () => {
  const { fetchImpl } = makeFakeHermes('', 'failed');
  const result = await deriveCompetitorPostingTimes({
    competitorUrl: 'https://competitor.example.com',
    timezone: 'America/New_York',
    platforms: ['instagram'],
    env: HERMES_ENV,
    fetchImpl,
    sleep: noSleep,
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'run_failed');
});

test('competitor derivation: unparseable output → output_invalid', async () => {
  const { fetchImpl } = makeFakeHermes('sorry, here is prose instead of JSON');
  const result = await deriveCompetitorPostingTimes({
    competitorUrl: 'https://competitor.example.com',
    timezone: 'America/New_York',
    platforms: ['instagram'],
    env: HERMES_ENV,
    fetchImpl,
    sleep: noSleep,
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'output_invalid');
});

test('competitor derivation: never-terminal run times out', async () => {
  const { fetchImpl } = makeFakeHermes('', 'running');
  const result = await deriveCompetitorPostingTimes({
    competitorUrl: 'https://competitor.example.com',
    timezone: 'America/New_York',
    platforms: ['instagram'],
    env: { ...HERMES_ENV, HERMES_POSTING_TIMES_TIMEOUT_MS: '50' },
    fetchImpl,
    sleep: noSleep,
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'timeout');
});

// ── loadPostingTimeOverrides ────────────────────────────────────────────────

test('override read: flag off → null without touching the database', async () => {
  const { queryable, calls } = makeFakeDb();
  const overrides = await loadPostingTimeOverrides(15, queryable, {});
  assert.equal(overrides, null);
  assert.equal(calls.length, 0, 'flag-off must be byte-identical: no reads');
});

test('override read: maps valid rows and drops invalid ones', async () => {
  const queryable: PostingTimeQueryable = {
    query: async () => ({
      rows: [
        { platform: 'Instagram', hour: 19, minute: 30, days: [2, 4] },
        { platform: 'facebook', hour: 99, minute: 0, days: [] }, // invalid hour → dropped
        { platform: '', hour: 9, minute: 0, days: [] }, // missing platform → dropped
      ],
      rowCount: 3,
    }),
  };
  const overrides = await loadPostingTimeOverrides(15, queryable, FLAG_ON);
  assert.ok(overrides);
  assert.deepEqual(overrides.instagram, { hour: 19, minute: 30, days: [2, 4] });
  assert.equal(overrides.facebook, undefined);
});

test('override read: database error → null (fail-open to platform defaults)', async () => {
  const queryable: PostingTimeQueryable = {
    query: async () => {
      throw new Error('connection refused');
    },
  };
  assert.equal(await loadPostingTimeOverrides(15, queryable, FLAG_ON), null);
});

// ── deriveAndPersistPostingTimes ────────────────────────────────────────────

test('derive: flag off → disabled, nothing runs', async () => {
  const { queryable, calls } = makeFakeDb();
  const result = await deriveAndPersistPostingTimes({ tenantId: 15, env: {}, queryable });
  assert.deepEqual(result, { status: 'disabled' });
  assert.equal(calls.length, 0);
});

test('derive: invalid tenant id → invalid_tenant', async () => {
  const { queryable } = makeFakeDb();
  const result = await deriveAndPersistPostingTimes({ tenantId: Number.NaN, env: FLAG_ON, queryable });
  assert.deepEqual(result, { status: 'invalid_tenant' });
});

test('derive: fresh derivation within TTL is skipped; force bypasses', async () => {
  const now = new Date('2026-07-09T12:00:00Z');
  const recent = new Date('2026-07-09T11:30:00Z'); // 30 min old < 60 min TTL
  {
    const { queryable, calls } = makeFakeDb({ latestDerivedAt: recent });
    const result = await deriveAndPersistPostingTimes({ tenantId: 15, env: FLAG_ON, queryable, now });
    assert.deepEqual(result, { status: 'skipped_recent' });
    assert.equal(upsertCalls(calls).length, 0);
  }
  {
    // force=true must not even consult the freshness row.
    const { queryable, calls } = makeFakeDb({ latestDerivedAt: recent });
    const result = await deriveAndPersistPostingTimes({
      tenantId: 15,
      env: FLAG_ON,
      queryable,
      now,
      force: true,
      competitorUrl: null,
      brandUrl: null,
    });
    assert.equal(result.status, 'done');
    assert.equal(
      calls.some((c) => c.sql.includes('MAX(derived_at)')),
      false,
      'force bypasses the TTL freshness read',
    );
  }
});

test('derive: analytics source wins per platform; competitor covers the rest', async () => {
  const buckets: AnalyticsBucket[] = [
    { day_of_week: 2, hour_of_day: 19, post_count: 6, avg_engagement: 40 },
    { day_of_week: 4, hour_of_day: 9, post_count: 4, avg_engagement: 10 },
  ];
  const { queryable, calls } = makeFakeDb({
    analyticsBucketsByPlatform: { instagram: buckets, facebook: [] },
  });
  const { fetchImpl } = makeFakeHermes(
    JSON.stringify({
      status: 'ok',
      output: [{ platform: 'facebook', hour: 14, minute: 30, days: [1, 3], rationale: 'Competitor posts weekday PM' }],
    }),
  );
  const result = await deriveAndPersistPostingTimes({
    tenantId: 15,
    env: HERMES_ENV,
    queryable,
    fetchImpl,
    sleep: noSleep,
    competitorUrl: 'https://competitor.example.com',
    brandUrl: 'https://aries.sugarandleather.com',
  });
  assert.equal(result.status, 'done');
  assert.equal(result.status === 'done' && result.platforms.instagram, 'analytics');
  assert.equal(result.status === 'done' && result.platforms.facebook, 'competitor');

  const upserts = upsertCalls(calls);
  assert.equal(upserts.length, 2);
  const ig = upserts.find((c) => c.params[1] === 'instagram');
  assert.ok(ig, 'instagram row upserted');
  assert.equal(ig.params[2], 19, 'analytics best hour');
  assert.equal(ig.params[5], 'analytics');
  assert.equal(ig.params[6], 10, 'sample size = measured posts');
  const fb = upserts.find((c) => c.params[1] === 'facebook');
  assert.ok(fb, 'facebook row upserted');
  assert.equal(fb.params[2], 14);
  assert.equal(fb.params[3], 30);
  assert.equal(fb.params[5], 'competitor');
});

test('derive: competitor URL equal to the brand URL is treated as "no competitor set"', async () => {
  const { queryable, calls } = makeFakeDb();
  let hermesCalled = false;
  const fetchImpl = async (): Promise<Response> => {
    hermesCalled = true;
    return new Response(JSON.stringify({ run_id: 'x' }), { status: 200 });
  };
  const result = await deriveAndPersistPostingTimes({
    tenantId: 998877, // no business profile on disk → stored competitor lookup resolves null
    env: HERMES_ENV,
    queryable,
    fetchImpl,
    sleep: noSleep,
    competitorUrl: 'https://aries.sugarandleather.com',
    brandUrl: 'https://aries.sugarandleather.com',
  });
  assert.equal(result.status, 'done');
  assert.equal(result.status === 'done' && result.platforms.instagram, 'default');
  assert.equal(result.status === 'done' && result.platforms.facebook, 'default');
  assert.equal(hermesCalled, false, 'the orchestrator brand-URL fallback must never be analyzed as a competitor');
  assert.equal(upsertCalls(calls).length, 0);
});

test('derive: competitor run failure degrades to defaults, never throws', async () => {
  const { queryable, calls } = makeFakeDb();
  const { fetchImpl } = makeFakeHermes('', 'failed');
  const result = await deriveAndPersistPostingTimes({
    tenantId: 15,
    env: HERMES_ENV,
    queryable,
    fetchImpl,
    sleep: noSleep,
    competitorUrl: 'https://competitor.example.com',
    brandUrl: 'https://aries.sugarandleather.com',
  });
  assert.equal(result.status, 'done');
  assert.equal(result.status === 'done' && result.platforms.instagram, 'default');
  assert.equal(upsertCalls(calls).length, 0);
});

test('derive: a second concurrent call for the same tenant returns in_flight', async () => {
  let releaseFreshness: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    releaseFreshness = resolve;
  });
  const queryable: PostingTimeQueryable = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('marketing_posting_time_claims')) {
        return { rows: [{ tenant_id: params[0] }], rowCount: 1 };
      }
      if (sql.includes('MAX(derived_at)')) {
        await gate; // hold the first call open
        return { rows: [{ derived_at: new Date() }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const first = deriveAndPersistPostingTimes({ tenantId: 42, env: FLAG_ON, queryable });
  const second = await deriveAndPersistPostingTimes({ tenantId: 42, env: FLAG_ON, queryable });
  assert.deepEqual(second, { status: 'in_flight' });
  releaseFreshness!();
  const firstResult = await first;
  assert.deepEqual(firstResult, { status: 'skipped_recent' });
});

test('derive: a denied cross-process claim returns in_flight — even under force', async () => {
  // Simulates the other cluster worker holding the claim: the conditional
  // INSERT ... ON CONFLICT ... WHERE claim-is-stale returns zero rows.
  const { queryable, calls } = makeFakeDb({ claimGranted: false });
  const result = await deriveAndPersistPostingTimes({
    tenantId: 15,
    env: FLAG_ON,
    queryable,
    force: true,
  });
  assert.deepEqual(result, { status: 'in_flight' });
  assert.equal(upsertCalls(calls).length, 0);
  assert.equal(
    calls.some((c) => c.sql.includes('WITH per_post')),
    false,
    'a denied claim must stop the derivation before any analytics scan',
  );
});

test('derive: claim lifecycle — released when rows were produced, retained as backoff when nothing derived', async () => {
  const buckets: AnalyticsBucket[] = [
    { day_of_week: 2, hour_of_day: 19, post_count: 6, avg_engagement: 40 },
    { day_of_week: 4, hour_of_day: 9, post_count: 4, avg_engagement: 10 },
  ];
  {
    // Analytics produced rows → the claim is released for the next derivation.
    const { queryable, calls } = makeFakeDb({
      analyticsBucketsByPlatform: { instagram: buckets, facebook: buckets },
    });
    const result = await deriveAndPersistPostingTimes({
      tenantId: 15,
      env: FLAG_ON,
      queryable,
      competitorUrl: null,
      brandUrl: null,
    });
    assert.equal(result.status, 'done');
    assert.equal(claimReleaseCalls(calls).length, 1, 'a productive derivation releases its claim');
  }
  {
    // Competitor run failed on a cold-start tenant → NO rows → the claim is
    // retained so the next generate click backs off instead of re-firing a
    // doomed Hermes research run.
    const { queryable, calls } = makeFakeDb();
    const { fetchImpl } = makeFakeHermes('', 'failed');
    const result = await deriveAndPersistPostingTimes({
      tenantId: 15,
      env: HERMES_ENV,
      queryable,
      fetchImpl,
      sleep: noSleep,
      competitorUrl: 'https://competitor.example.com',
      brandUrl: 'https://aries.sugarandleather.com',
    });
    assert.equal(result.status, 'done');
    assert.equal(claimReleaseCalls(calls).length, 0, 'a produced-nothing derivation retains its claim as failure backoff');
  }
  {
    // TTL-skipped → claim released immediately (no work was attempted).
    const { queryable, calls } = makeFakeDb({ latestDerivedAt: new Date('2026-07-09T11:30:00Z') });
    const result = await deriveAndPersistPostingTimes({
      tenantId: 15,
      env: FLAG_ON,
      queryable,
      now: new Date('2026-07-09T12:00:00Z'),
    });
    assert.deepEqual(result, { status: 'skipped_recent' });
    assert.equal(claimReleaseCalls(calls).length, 1);
  }
});
