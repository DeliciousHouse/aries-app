import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

import { requireDbEnvOrSkip } from './helpers/requires-infra';
import { buildTopSnapshot } from '../backend/insights/top/top-snapshot-builder';

// AA-229 PR2a review (F1/F2/F3) — live-schema proof that the weakest-post
// query in buildTopSnapshot() cannot crown an unmeasured post, breaks ties
// deterministically, and never renders as a duplicate of the best post.
//
// This is a live-Postgres test, not a pure fixture, because all three
// properties are about which SQL ROW gets selected — a mocked `pool.query`
// would just echo back whatever rows the test hands it, proving nothing
// about the actual predicate/ORDER BY. requires-infra: self-skips without DB
// env (as in CI's full-suite gate). Verified red-then-green for real against
// a disposable, throwaway Postgres 16 container (scripts/init-db.js schema,
// no shared volumes/state) — F1 and F3 fail cleanly when their respective
// fix is reverted in isolation and pass once restored; see the F2 test below
// for why that one's red-proof is weaker by nature, not by omission.

function pool() {
  return new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    max: 1,
  });
}

// NOTE: organizations.id is SERIAL (pg returns a JS number), but
// insights_accounts.id / insights_posts.id are BIGSERIAL — pg returns those
// as STRINGS (a bigint doesn't safely fit a JS number), regardless of the
// `<{ id: number }>` compile-time row type. Every id read here is coerced
// with Number(...) so it compares correctly (via assert/strict's
// assert.equal, i.e. ===) against buildTopSnapshot()'s already-coerced
// `Number(row.id)` outputs — otherwise `5 !== '5'` fails for the RIGHT
// answer just as loudly as for the wrong one.
async function makeOrgAndAccount(client: pg.PoolClient, label: string): Promise<{ org: number; account: number }> {
  const org = Number((await client.query<{ id: number }>(
    `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
    [label],
  )).rows[0].id);
  const account = Number((await client.query<{ id: number }>(
    `INSERT INTO insights_accounts (tenant_id, platform, external_account_id)
     VALUES ($1, 'facebook', 'fb-acct-1') RETURNING id`,
    [org],
  )).rows[0].id);
  return { org, account };
}

async function makePost(
  client: pg.PoolClient,
  org: number,
  account: number,
  externalId: string,
  publishedAgo: string,
): Promise<number> {
  return Number((await client.query<{ id: number }>(
    `INSERT INTO insights_posts (tenant_id, account_id, platform, external_post_id, published_at, media_type)
     VALUES ($1, $2, 'facebook', $3, now() - $4::interval, 'image') RETURNING id`,
    [org, account, externalId, publishedAgo],
  )).rows[0].id);
}

async function makeMetricsRow(client: pg.PoolClient, org: number, post: number, reach: number): Promise<void> {
  await client.query(
    `INSERT INTO insights_post_metrics_daily
       (tenant_id, post_id, platform, date, reach, likes, comments_count, saves, shares, raw_source)
     VALUES ($1, $2, 'facebook', CURRENT_DATE, $3, 0, 0, 0, 0, '{}'::jsonb)`,
    [org, post, reach],
  );
}

// F1 — an unmeasured post (published <24h ago, no insights_post_metrics_daily
// row — exactly what the sync dispatcher leaves behind: dispatcher.ts:554
// only writes metrics for posts older than a day) must NEVER be crowned
// "weakest" over a real, low-but-measured post. Fails without the query's
// EXISTS guard: the unmeasured post's forced COALESCE(...,0) reach would
// ASC-sort first.
test('weakest-post query excludes a never-measured post from the ranked set (F1)', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const p = pool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const { org, account } = await makeOrgAndAccount(client, 'AA-229 F1 test');

    const best = await makePost(client, org, account, 'fb-post-best', '5 days');
    await makeMetricsRow(client, org, best, 500);

    const weakestMeasured = await makePost(client, org, account, 'fb-post-weakest', '4 days');
    await makeMetricsRow(client, org, weakestMeasured, 50);

    // Published 2 hours ago — inside the window, but the sync dispatcher has
    // not measured it yet, so it has NO insights_post_metrics_daily row.
    await makePost(client, org, account, 'fb-post-unmeasured', '2 hours');

    const snap = await buildTopSnapshot(org, 'week', 'all', 'reach', client);

    assert.equal(snap.postCount, 3, 'sanity: all three posts are in the scoped set');
    assert.ok(snap.weakest, 'weakest card is populated');
    assert.equal(
      snap.weakest?.id,
      weakestMeasured,
      'weakest is the real measured low-reach post, NOT the never-measured post (whose forced 0 would otherwise win)',
    );
    assert.equal(snap.weakest?.reach, 50);
    assert.equal(snap.posts[0]?.id, best, 'sanity: best post is unaffected');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await p.end();
  }
});

// F2 — a tied metric must resolve deterministically (lowest id), not flip
// between rebuilds on identical data. Without `, id ASC`, Postgres gives NO
// ordering guarantee among ties — in practice a fresh single-transaction seq
// scan often (not always) happens to return insertion order anyway, so this
// fixture can pass even on the pre-fix query on a given run/engine/plan; it
// is not a reliable red-proof the way F1/F3 are (confirmed manually: reverting
// just the tie-breaker did not reproduce a visible failure here). The fix
// itself is still correct and necessary — it removes an unspecified-behavior
// dependency, matching the established `ORDER BY reach DESC, id ASC`
// precedent in WEEK_POST_RANKING_SQL — this test pins that the deterministic
// order holds now and going forward, even though it can't force Postgres to
// expose the absence of it.
test('weakest-post query breaks ties deterministically by id ASC (F2)', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const p = pool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const { org, account } = await makeOrgAndAccount(client, 'AA-229 F2 test');

    const best = await makePost(client, org, account, 'fb-post-best', '5 days');
    await makeMetricsRow(client, org, best, 1000);

    // Two posts tie at reach=10. Insert order fixes id order (lower id first).
    const tieLower = await makePost(client, org, account, 'fb-post-tie-a', '4 days');
    await makeMetricsRow(client, org, tieLower, 10);
    const tieHigher = await makePost(client, org, account, 'fb-post-tie-b', '3 days');
    await makeMetricsRow(client, org, tieHigher, 10);

    assert.ok(tieLower < tieHigher, 'sanity: insert order fixes id order');

    const snap = await buildTopSnapshot(org, 'week', 'all', 'reach', client);

    assert.equal(snap.weakest?.id, tieLower, 'the lower-id post wins the tie, deterministically');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await p.end();
  }
});

// F3 — even when postCount >= 2, if only ONE post survives the "actually
// measured" filter (F1), that single post is trivially both the best AND the
// only weakest candidate — the weakest card must be suppressed, not render a
// duplicate of the #1 top-performer row.
test('weakest card is suppressed when only one post in the window is measured (F3)', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const p = pool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const { org, account } = await makeOrgAndAccount(client, 'AA-229 F3 test');

    const measured = await makePost(client, org, account, 'fb-post-measured', '4 days');
    await makeMetricsRow(client, org, measured, 50);

    // Second post published this window but not yet measured.
    await makePost(client, org, account, 'fb-post-unmeasured', '2 hours');

    const snap = await buildTopSnapshot(org, 'week', 'all', 'reach', client);

    assert.equal(snap.postCount, 2, 'sanity: both posts are in the scoped set (pre-filter gate sees 2)');
    assert.equal(snap.posts[0]?.id, measured, 'sanity: the one measured post is the top performer');
    assert.equal(snap.weakest, null, 'weakest card suppressed — it would be a duplicate of the #1 row');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await p.end();
  }
});
