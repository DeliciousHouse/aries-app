import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { syncAccountForTenant } from '@/backend/insights/sync/dispatcher';
import { CURRENT_CLASSIFIER_VERSION } from '@/backend/insights/sync/classify-comments';
import type { InsightsAdapter } from '@/backend/insights/adapters/_adapter.types';
import { resolveProjectRoot } from './helpers/project-root.js';

/**
 * M3 regression: a per-post fetchPostMetrics throw must NOT skip the comments
 * leg (#597). Drives the dispatcher against an in-memory fake pool + a fake
 * adapter whose fetchPostMetrics always throws, and asserts comments still
 * ingest and the run is downgraded to 'partial' (not 'failed', not 'ok').
 */

interface Recorded { text: string; params: unknown[] }

function fakePool(recorded: Recorded[]) {
  const client = {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      recorded.push({ text, params });
      const rows = (): T[] => [] as T[];

      if (/FROM insights_accounts\s+WHERE id/i.test(text)) {
        return { rows: [{ id: 7, platform: 'facebook', external_account_id: 'PAGE123' }] as unknown as T[], rowCount: 1 };
      }
      if (/FROM connected_accounts/i.test(text)) {
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
        // Serves BOTH the post-metrics (postsToSync) and the comments (recentPosts) selects.
        return { rows: [{ id: 10, external_post_id: 'PAGE123_1' }] as unknown as T[], rowCount: 1 };
      }
      return { rows: rows(), rowCount: 0 };
    },
    release() {},
  };
  return { async connect() { return client; } };
}

const throwingPostMetricsAdapter: InsightsAdapter = {
  platform: 'facebook',
  fetchPostList: async () => [],
  fetchAccountMetrics: async () => [],
  fetchPostMetrics: async () => {
    throw new Error('POST_INSIGHTS 500');
  },
  fetchComments: async () => [
    { externalCommentId: 'PAGE123_1_99', receivedAt: new Date('2026-06-11T00:00:00Z'), authorHandle: 'Jane', bodyText: 'hi' },
  ],
};

test('M3: comments still ingest when fetchPostMetrics throws; run is partial, not failed/ok', async () => {
  const recorded: Recorded[] = [];
  const result = await syncAccountForTenant(42, 7, 'interval', {
    pool: fakePool(recorded),
    resolveAdapter: () => throwingPostMetricsAdapter,
  });

  // The comments leg ran despite the post-metrics throw.
  const commentInserts = recorded.filter((q) => /INSERT INTO insights_comments/i.test(q.text));
  assert.equal(commentInserts.length, 1, 'a comment was inserted even though fetchPostMetrics threw');
  assert.equal(result.commentsSeen, 1);

  // The run is downgraded to partial (leg isolated), never the ok fast-path,
  // never a hard failure that would zero everything.
  assert.equal(result.status, 'partial');
  assert.match(String(result.errorMessage), /fetchPostMetrics/);
  assert.match(String(result.errorMessage), /POST_INSIGHTS 500/);

  const partialUpdate = recorded.find((q) => /UPDATE insights_sync_runs[\s\S]*status = 'partial'/i.test(q.text));
  assert.ok(partialUpdate, 'the sync run is closed out as partial');
  const okTerminal = recorded.find((q) => /UPDATE insights_sync_runs[\s\S]*status\s*=\s*'ok'/i.test(q.text));
  assert.equal(okTerminal, undefined, 'the ok fast-path must not run when a leg failed');
});

test('M3: a clean run (no leg errors) still takes the ok path', async () => {
  const recorded: Recorded[] = [];
  const cleanAdapter: InsightsAdapter = {
    ...throwingPostMetricsAdapter,
    fetchPostMetrics: async () => [],
  };
  const result = await syncAccountForTenant(42, 7, 'interval', {
    pool: fakePool(recorded),
    resolveAdapter: () => cleanAdapter,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.errorMessage, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// S8-4 / AA-127 (gap E5) — leg isolation for the two legs the M3 tests above do
// not reach: ACCOUNT METRICS and CLASSIFICATION.
//
// The isolation contract is the same for every leg and is the whole reason the
// sync is worth running at all: one platform endpoint failing must not discard
// the work the other legs already persisted. A regression here does not throw —
// it silently drops a leg's rows and still reports a green-looking run, which is
// precisely the class of bug that made #597 survive so long.
// ─────────────────────────────────────────────────────────────────────────────

test('AA-127: an account-metrics failure isolates; comments and posts still persist', async () => {
  const recorded: Recorded[] = [];
  const adapter: InsightsAdapter = {
    ...throwingPostMetricsAdapter,
    fetchPostMetrics: async () => [],
    fetchAccountMetrics: async () => {
      throw new Error('ACCOUNT_INSIGHTS 503');
    },
  };

  const result = await syncAccountForTenant(42, 7, 'interval', {
    pool: fakePool(recorded),
    resolveAdapter: () => adapter,
  });

  // The failing leg wrote nothing…
  const accountUpserts = recorded.filter((q) =>
    /INSERT INTO insights_account_metrics_daily/i.test(q.text),
  );
  assert.equal(accountUpserts.length, 0, 'the account-metrics leg produced no rows');

  // …but the legs downstream of it still ran to completion.
  const commentInserts = recorded.filter((q) => /INSERT INTO insights_comments/i.test(q.text));
  assert.equal(commentInserts.length, 1, 'the comments leg must not be skipped');
  assert.equal(result.commentsSeen, 1);

  assert.equal(result.status, 'partial', 'isolated, so partial — not failed, not ok');
  assert.match(String(result.errorMessage), /fetchAccountMetrics/, 'the failing leg is named');
  assert.match(String(result.errorMessage), /ACCOUNT_INSIGHTS 503/, 'with the real cause');

  const okTerminal = recorded.find((q) =>
    /UPDATE insights_sync_runs[\s\S]*status\s*=\s*'ok'/i.test(q.text),
  );
  assert.equal(okTerminal, undefined, 'a failed leg must never take the ok fast-path');
});

/**
 * The shared fakePool returns no rows for the classify-candidate SELECT, so the
 * classifier is never invoked and the leg cannot be observed. This wrapper
 * serves exactly one unclassified comment for that query and delegates
 * everything else, so the recording (and every other leg) is unchanged.
 */
function fakePoolWithUnclassifiedComment(recorded: Recorded[]) {
  const base = fakePool(recorded);
  return {
    async connect() {
      const client = await base.connect();
      return {
        async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
          const passthrough = await client.query<T>(text, params);
          if (/LEFT JOIN insights_comment_classifications/i.test(text)) {
            return {
              rows: [{ id: 501, body_text: 'do you ship to canada?' }] as unknown as T[],
              rowCount: 1,
            };
          }
          return passthrough;
        },
        release() {},
      };
    },
  };
}

test('AA-127: an unconfigured classifier isolates and is reported, not swallowed', async () => {
  // The documented "empty-default trap": with the flag ON but the worker missing
  // Hermes creds, classification cannot run. That must be LOUD (a leg error,
  // status partial) rather than a silent no-op — otherwise Conversations shows
  // 0% positive and the lead count reads 0 with nothing anywhere saying why.
  //
  // Driven through the real classifier's not_configured branch rather than a
  // stub: the dispatcher imports it directly, and this is a genuine production
  // state (a worker deployed without HERMES_GATEWAY_URL).
  const prev = {
    flag: process.env.ARIES_COMMENT_CLASSIFICATION_ENABLED,
    url: process.env.HERMES_GATEWAY_URL,
    key: process.env.HERMES_API_SERVER_KEY,
  };
  process.env.ARIES_COMMENT_CLASSIFICATION_ENABLED = '1';
  delete process.env.HERMES_GATEWAY_URL;
  delete process.env.HERMES_API_SERVER_KEY;

  try {
    const recorded: Recorded[] = [];
    const adapter: InsightsAdapter = {
      ...throwingPostMetricsAdapter,
      fetchPostMetrics: async () => [],
    };
    const result = await syncAccountForTenant(42, 7, 'interval', {
      pool: fakePoolWithUnclassifiedComment(recorded),
      resolveAdapter: () => adapter,
    });

    assert.equal(result.status, 'partial', 'a misconfigured classifier downgrades the run');
    assert.match(String(result.errorMessage), /classifyComments/, 'the leg is named');
    assert.match(String(result.errorMessage), /not_configured/, 'and the reason is specific');

    // The comments themselves still landed — only their LABELS are missing.
    assert.equal(result.commentsSeen, 1, 'the comment ingest leg is unaffected');
    const labelWrites = recorded.filter((q) =>
      /INSERT INTO insights_comment_classifications/i.test(q.text),
    );
    assert.equal(labelWrites.length, 0, 'no labels can be written without a classifier');
  } finally {
    if (prev.flag === undefined) delete process.env.ARIES_COMMENT_CLASSIFICATION_ENABLED;
    else process.env.ARIES_COMMENT_CLASSIFICATION_ENABLED = prev.flag;
    if (prev.url !== undefined) process.env.HERMES_GATEWAY_URL = prev.url;
    if (prev.key !== undefined) process.env.HERMES_API_SERVER_KEY = prev.key;
  }
});

test('AA-127: classification DISABLED is a skip, not a failure', async () => {
  // The distinction that keeps the signal usable. A gate-skip is not an error:
  // if the flag being off downgraded every run to partial, then every
  // deployment running without the classifier would look permanently degraded
  // and a real leg failure would be invisible in the noise.
  const prev = process.env.ARIES_COMMENT_CLASSIFICATION_ENABLED;
  process.env.ARIES_COMMENT_CLASSIFICATION_ENABLED = '0';

  try {
    const recorded: Recorded[] = [];
    const adapter: InsightsAdapter = {
      ...throwingPostMetricsAdapter,
      fetchPostMetrics: async () => [],
    };
    const result = await syncAccountForTenant(42, 7, 'interval', {
      pool: fakePool(recorded),
      resolveAdapter: () => adapter,
    });

    assert.equal(result.status, 'ok', 'the flag being off is not a leg failure');
    assert.equal(result.errorMessage, undefined, 'and contributes no error text');

    const classifySelect = recorded.find((q) =>
      /FROM insights_comments c[\s\S]*classifier_version IS DISTINCT FROM/i.test(q.text),
    );
    assert.equal(classifySelect, undefined, 'a disabled leg must not even query for candidates');
  } finally {
    if (prev === undefined) delete process.env.ARIES_COMMENT_CLASSIFICATION_ENABLED;
    else process.env.ARIES_COMMENT_CLASSIFICATION_ENABLED = prev;
  }
});

// S3-2 (gap C1): insights_posts upsert must stamp content_type on INSERT and
// preserve an already-classified row via COALESCE on conflict — never
// re-derive/overwrite a stamped value on a later sync.
test('S3-2: insights_posts INSERT binds content_type and DO UPDATE preserves it via COALESCE', async () => {
  const recorded: Recorded[] = [];
  const adapterWithPost: InsightsAdapter = {
    ...throwingPostMetricsAdapter,
    fetchPostList: async () => [
      {
        externalPostId: 'PAGE123_1',
        publishedAt: new Date('2026-06-01T00:00:00Z'),
        mediaType: 'image',
        title: null,
        caption: '20% off this week only! Shop now.',
        permalink: 'https://example.com/p/1',
        durationSeconds: null,
        thumbnailUrl: null,
      },
    ],
    fetchPostMetrics: async () => [],
    fetchComments: async () => [],
  };

  const result = await syncAccountForTenant(42, 7, 'interval', {
    pool: fakePool(recorded),
    resolveAdapter: () => adapterWithPost,
  });

  const postInsert = recorded.find((q) => /INSERT INTO insights_posts/i.test(q.text));
  assert.ok(postInsert, 'insights_posts upsert ran');

  // Anchored BEFORE the VALUES keyword — this is the actual INSERT column
  // list, not a substring match that also happens to hit unrelated EXCLUDED
  // references inside the ON CONFLICT clause below. AA-99 appends
  // aries_post_id, resolved from the platform id without an extra parameter.
  // A prior version of this assertion (/[\s\S]*content_type\s*\)/, no VALUES
  // anchor) was a confirmed false-pass: it matched even if content_type were
  // dropped from the actual INSERT column list, because the regex was
  // satisfied by "EXCLUDED.content_type)" further down the same string.
  assert.match(
    postInsert!.text,
    /platform_data,\s*content_type,\s*aries_post_id\s*\)\s*VALUES/i,
    'INSERT column list includes content_type and aries_post_id before VALUES',
  );
  // The 12th positional placeholder must appear in the VALUES tuple (content_type
  // is the 12th bound column per the source comment).
  assert.match(
    postInsert!.text,
    /VALUES\s*\([^)]*\$12[^)]*\)/i,
    'the VALUES tuple binds a $12 placeholder for the 12th (content_type) column',
  );
  // The SQL's highest placeholder number must equal the length of the bound
  // params array — i.e. every placeholder the query text references is
  // actually supplied, and no extra unbound param is silently dropped.
  const placeholderNumbers = [...postInsert!.text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  const maxPlaceholder = placeholderNumbers.length > 0 ? Math.max(...placeholderNumbers) : 0;
  assert.equal(
    maxPlaceholder,
    postInsert!.params.length,
    `the SQL's highest placeholder ($${maxPlaceholder}) must equal the bound params array length (${postInsert!.params.length})`,
  );

  assert.match(
    postInsert!.text,
    /content_type\s*=\s*COALESCE\(\s*insights_posts\.content_type\s*,\s*EXCLUDED\.content_type\s*\)/i,
    'ON CONFLICT DO UPDATE must preserve an existing content_type via COALESCE, never blind-overwrite it',
  );
  assert.match(
    postInsert!.text,
    /SELECT\s+p\.id[\s\S]*FROM\s+posts\s+p[\s\S]*p\.platform_post_id\s*=\s*\$4/i,
    'the sync upsert preserves the legacy posts.platform_post_id fallback',
  );
  assert.match(
    postInsert!.text,
    /scheduled_post_dispatches[\s\S]*platform_post_id\s*=\s*\$4/i,
    'the sync upsert recovers non-first ids from scheduled dispatch children',
  );
  assert.match(
    postInsert!.text,
    /aries_post_id\s*=\s*COALESCE\(\s*insights_posts\.aries_post_id\s*,\s*EXCLUDED\.aries_post_id\s*\)/i,
    'a later sync fills NULL attribution without overwriting an existing link',
  );
  // The caption is unambiguously promotional ("% off" + "shop now") — the
  // last bound param is the classified value threaded through to the INSERT.
  assert.equal(postInsert!.params[postInsert!.params.length - 1], 'promotional');

  assert.equal(result.postsSeen, 1);
  assert.equal(result.status, 'ok');
});

// ── S4-2 (gap C3): reach / saves persistence ──────────────────────────────────
// The columns existed and five builders read them, but neither INSERT bound
// them — Instagram fetched reach/saved and buried both in raw_source JSONB.
// These pin the write, and the COALESCE-on-conflict that keeps a fail-soft tick
// from erasing a value the previous tick measured.

const metricsAdapter = (
  post: Partial<{ reach: number | null; saves: number | null }>,
): InsightsAdapter => ({
  ...throwingPostMetricsAdapter,
  fetchPostMetrics: async () => [
    {
      date: '2026-06-11',
      views: 4200,
      watchTimeMinutes: 0,
      avgViewDurationSec: 0,
      avgViewPercentage: 0,
      likes: 88,
      commentsCount: 12,
      shares: 5,
      ...post,
      rawSource: { source: 'test' },
    },
  ],
});

test('S4-2: per-post INSERT binds reach/saves and preserves them via COALESCE on conflict', async () => {
  const recorded: Recorded[] = [];
  await syncAccountForTenant(42, 7, 'interval', {
    pool: fakePool(recorded),
    resolveAdapter: () => metricsAdapter({ reach: 3900, saves: 60 }),
  });

  const insert = recorded.find((q) => /INSERT INTO insights_post_metrics_daily/i.test(q.text));
  assert.ok(insert, 'the per-post metrics INSERT ran');
  assert.match(insert!.text, /\breach\b/i, 'reach is in the column list');
  assert.match(insert!.text, /\bsaves\b/i, 'saves is in the column list');

  // Values reach the statement rather than staying stuck in raw_source.
  assert.ok(insert!.params.includes(3900), 'reach is bound');
  assert.ok(insert!.params.includes(60), 'saves is bound');

  // COALESCE-preserve, NOT a bare EXCLUDED. The IG adapter fails soft to the
  // list_posts engagement cache, which has no reach/saves — a bare assignment
  // would wipe the last measured value on every such tick.
  assert.match(
    insert!.text,
    /reach\s*=\s*COALESCE\(\s*EXCLUDED\.reach\s*,\s*insights_post_metrics_daily\.reach\s*\)/i,
    'reach must be preserved via COALESCE on conflict',
  );
  assert.match(
    insert!.text,
    /saves\s*=\s*COALESCE\(\s*EXCLUDED\.saves\s*,\s*insights_post_metrics_daily\.saves\s*\)/i,
    'saves must be preserved via COALESCE on conflict',
  );
});

test('S4-2: an adapter that cannot measure reach/saves binds NULL, never 0', async () => {
  // The NULL-vs-0 contract at the persistence boundary. Facebook omits both
  // fields entirely; that must land as NULL so a reader can tell "not measured"
  // from "measured zero" (the product_sales silent-zero trap).
  const recorded: Recorded[] = [];
  await syncAccountForTenant(42, 7, 'interval', {
    pool: fakePool(recorded),
    resolveAdapter: () => metricsAdapter({}),
  });

  const insert = recorded.find((q) => /INSERT INTO insights_post_metrics_daily/i.test(q.text));
  assert.ok(insert, 'the per-post metrics INSERT ran');
  // reach and saves are the two params immediately before the raw_source JSON.
  const rawSourceIdx = insert!.params.findIndex(
    (p) => typeof p === 'string' && p.includes('"source"'),
  );
  assert.ok(rawSourceIdx > 1, 'raw_source param located');
  assert.equal(insert!.params[rawSourceIdx - 2], null, 'reach binds NULL, not 0');
  assert.equal(insert!.params[rawSourceIdx - 1], null, 'saves binds NULL, not 0');
});

test('S4-2: account INSERT binds reach with COALESCE-preserve; saves/profile_visits stay unwritten', async () => {
  const recorded: Recorded[] = [];
  await syncAccountForTenant(42, 7, 'interval', {
    pool: fakePool(recorded),
    resolveAdapter: () => ({
      ...throwingPostMetricsAdapter,
      fetchPostMetrics: async () => [],
      fetchAccountMetrics: async () => [
        {
          date: '2026-06-11',
          views: 950,
          watchTimeMinutes: 0,
          followers: 1234,
          followersDelta: 0,
          likes: 0,
          commentsCount: 0,
          shares: 0,
          reach: 820,
          rawSource: { source: 'test' },
        },
      ],
    }),
  });

  const insert = recorded.find((q) => /INSERT INTO insights_account_metrics_daily/i.test(q.text));
  assert.ok(insert, 'the account metrics INSERT ran');
  assert.ok(insert!.params.includes(820), 'account reach is bound');
  assert.match(
    insert!.text,
    /reach\s*=\s*COALESCE\(\s*EXCLUDED\.reach\s*,\s*insights_account_metrics_daily\.reach\s*\)/i,
    'account reach must be preserved via COALESCE on conflict',
  );

  // saves / profile_visits have NO source at the account level (IG exposes
  // neither and its profile_views metric is deprecated; FB Pages have no saves),
  // so they must stay OUT of the executable statement. Binding them would write
  // NULL over any future writer's value on every tick. Strip `--` comments
  // first: the statement's own comments discuss these columns by name.
  const sql = insert!.text.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(sql, /\bsaves\b/i, 'account saves must not be written');
  assert.doesNotMatch(sql, /profile_visits/i, 'profile_visits must not be written');
});

// ── S4-3 (gap C5): comment re-classification path ─────────────────────────────
// ON CONFLICT (comment_id) DO NOTHING + a hardcoded classifier_version froze
// every label at whatever the first classifier produced, so prompt/model
// improvements could never reach an already-labelled comment (the "frozen
// labels" caveat S1-11 shipped with). A version bump must now re-sweep.

const S4_3_ROOT = resolveProjectRoot(import.meta.url);
const dispatcherSource = readFileSync(
  path.join(S4_3_ROOT, 'backend', 'insights', 'sync', 'dispatcher.ts'),
  'utf8',
);

test('S4-3: the classify sweep selects stale-version rows, binding the current version', async () => {
  const prev = process.env.ARIES_COMMENT_CLASSIFICATION_ENABLED;
  process.env.ARIES_COMMENT_CLASSIFICATION_ENABLED = '1';
  try {
    const recorded: Recorded[] = [];
    await syncAccountForTenant(42, 7, 'interval', {
      pool: fakePool(recorded),
      resolveAdapter: () => ({ ...throwingPostMetricsAdapter, fetchPostMetrics: async () => [] }),
    });

    const sweep = recorded.find((q) =>
      /FROM insights_comments c[\s\S]*LEFT JOIN insights_comment_classifications/i.test(q.text),
    );
    assert.ok(sweep, 'the classify selection query ran');

    // Eligible = never classified OR classified by a superseded version. Before
    // S4-3 this was `cl.comment_id IS NULL` alone, which is what froze labels.
    assert.match(
      sweep!.text,
      /cl\.comment_id IS NULL\s*\n?\s*OR cl\.classifier_version IS DISTINCT FROM/i,
      'the sweep must also pick up rows at a superseded classifier_version',
    );
    // The version is a bound parameter, not a SQL literal — bumping the
    // constant is the entire trigger.
    assert.ok(
      sweep!.params.includes(CURRENT_CLASSIFIER_VERSION),
      'the current classifier version is bound as a parameter',
    );
    // Still one bounded batch per account per tick: a bump must converge over
    // ticks, never stampede.
    assert.ok(sweep!.params.includes(40), 'MAX_CLASSIFY_BATCH still bounds the sweep');
    assert.match(sweep!.text, /ORDER BY c\.received_at DESC/i,
      'newest-first ordering keeps new comments ahead of a re-sweep backlog');
  } finally {
    if (prev === undefined) delete process.env.ARIES_COMMENT_CLASSIFICATION_ENABLED;
    else process.env.ARIES_COMMENT_CLASSIFICATION_ENABLED = prev;
  }
});

test('S4-3: the classification write is a versioned upsert, not DO NOTHING', () => {
  // Source-level pin (precedent: the pool.connect ordering assertion in
  // tests/insights-force-throttle.test.ts). The INSERT only executes after a
  // successful Hermes run, which is not reachable from a unit test — the
  // dispatcher calls classifyCommentsWithHermes directly with no seam.
  const insert = dispatcherSource.match(
    /INSERT INTO insights_comment_classifications[\s\S]*?`/,
  );
  assert.ok(insert, 'the classification INSERT is present');
  const sql = insert![0];

  assert.doesNotMatch(sql, /DO NOTHING/i, 'DO NOTHING is what froze the labels');
  assert.match(sql, /ON CONFLICT \(comment_id\) DO UPDATE SET/i);
  assert.match(sql, /classifier_version = EXCLUDED\.classifier_version/i);
  assert.match(sql, /classified_at\s*=\s*now\(\)/i);
  // No-op when already current: a re-delivered or raced batch must not rewrite
  // the row or churn classified_at.
  assert.match(
    sql,
    /WHERE insights_comment_classifications\.classifier_version\s*\n?\s*IS DISTINCT FROM EXCLUDED\.classifier_version/i,
    'the upsert must no-op when the stored label is already at the current version',
  );
  // The version must not be re-hardcoded in SQL — that is exactly the drift the
  // exported constant exists to prevent.
  assert.doesNotMatch(sql, /'hermes-comment-v\d+'/i, 'version must be a bound param, not a literal');
});

test('S4-3: the conflict target stays (comment_id) so the nine reader joins cannot double-count', () => {
  // The load-bearing invariant. conversations, goal (x4), attention, top and
  // trends all join `ON cc.comment_id = c.id` with NO version predicate,
  // because comment_id is the PRIMARY KEY and one row per comment is
  // guaranteed. A composite (comment_id, classifier_version) key would keep a
  // row per version and silently double-count every lead count, sentiment
  // percentage and per-post sentiment the first time a re-sweep ran — with
  // nothing failing loudly. If this assertion ever needs changing, all nine
  // joins must be made version-aware in the same commit.
  assert.doesNotMatch(
    dispatcherSource,
    /ON CONFLICT \(comment_id,\s*classifier_version\)/i,
    'a per-version conflict target requires making all nine reader joins version-aware first',
  );

  const initDb = readFileSync(path.join(S4_3_ROOT, 'scripts', 'init-db.js'), 'utf8');
  assert.match(
    initDb,
    /comment_id\s+BIGINT PRIMARY KEY REFERENCES insights_comments\(id\)/i,
    'comment_id must remain the PRIMARY KEY — one row per comment holding its current label',
  );
  // The sweep predicate needs an index or it seq-scans on every tick of every
  // account, bump or no bump. Two-place rule: init-db.js + migrations/.
  assert.match(initDb, /idx_insights_comment_classifications_version/);
  const migration = readFileSync(
    path.join(S4_3_ROOT, 'migrations', '20260804000000_comment_classifier_version_index.sql'),
    'utf8',
  );
  assert.match(migration, /CREATE INDEX IF NOT EXISTS idx_insights_comment_classifications_version/);
});

// AA-item5b: SyncResult carries a `quarantined` count so the worker (and the
// host monitor's digest) can see objects going permanently dark. Leg isolation
// itself is unchanged by quarantine — a poisoned object must still not skip the
// other leg.
test('SyncResult carries a quarantined count, and leg isolation still holds around it', async () => {
  const recorded: Recorded[] = [];
  const result = await syncAccountForTenant(42, 7, 'interval', {
    pool: fakePool(recorded),
    resolveAdapter: () => throwingPostMetricsAdapter,
  });
  assert.equal(typeof result.quarantined, 'number');
  // The fake pool returns no row for the failure UPDATE, so no strike can be
  // confirmed — the error must therefore still reach legErrors (fail-open).
  assert.equal(result.quarantined, 0);
  assert.equal(result.status, 'partial');
  assert.equal(result.commentsSeen, 1, 'the comments leg still ran');
});
