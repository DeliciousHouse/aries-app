import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

import { requireDbEnvOrSkip } from './helpers/requires-infra';

import { syncAccountForTenant } from '@/backend/insights/sync/dispatcher';
import { runBackfillInsightsContentType } from '@/scripts/backfill-insights-content-type';
import type { InsightsAdapter } from '@/backend/insights/adapters/_adapter.types';

/**
 * S3-2 (gap C1) — live-Postgres proof for insights_posts.content_type writers.
 *
 * The dispatcher leg-isolation test (tests/insights-dispatcher-leg-isolation.test.ts)
 * only proves the INSERT/DO-UPDATE *text* against a fake recording pool — it never
 * executes the statement, so it cannot catch a real planner rejection (e.g. a
 * malformed ON CONFLICT target, a CHECK constraint mismatch) or prove the
 * COALESCE-preserve semantics actually hold across two real upserts. This file
 * drives `syncAccountForTenant` and `runBackfillInsightsContentType` against a
 * REAL Postgres connection (real schema, real planner) and proves, per plan
 * §6 (docs/plans/2026-07-16-content-type-production-writer.md):
 *
 *   1. the dispatcher-level upsert stamps content_type on first sync;
 *   2. a second sync with a caption that would classify DIFFERENTLY preserves
 *      the first classified value (COALESCE-preserve — never re-derive/overwrite
 *      an already-stamped row);
 *   3. the standalone backfill script is idempotent: running it twice reports
 *      0 newly-classified rows on the second pass.
 *
 * Everything runs against a real `organizations` row and is cleaned up
 * explicitly at the end (syncAccountForTenant opens its own pooled client per
 * call, so this cannot be wrapped in a single outer transaction the way
 * single-statement live-DB tests are — see the no-op-release wrapper below).
 */

function dbConfigFromEnv(): pg.PoolConfig | null {
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  if (!DB_HOST || !DB_PORT || !DB_USER || !DB_PASSWORD || !DB_NAME) return null;
  return {
    host: DB_HOST,
    port: Number(DB_PORT),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    max: 2,
  };
}

const dbConfig = dbConfigFromEnv();

/**
 * Wraps a real, already-checked-out pg.PoolClient as the `SyncDeps.pool` seam
 * `syncAccountForTenant` expects (`{ connect(): Promise<SyncClient> }`).
 * `release()` is a deliberate no-op: `syncAccountForTenant` always calls
 * `client.release()` in its `finally` block, and a real PoolClient.release()
 * would return the connection to the pool mid-test, invalidating the
 * transaction/connection this test needs to keep using afterward for
 * assertions + cleanup. Every query still runs for real against the live
 * connection — only the pool-return bookkeeping is stubbed.
 */
function asSyncPool(client: pg.PoolClient) {
  return {
    async connect() {
      return {
        query: (text: string, params: unknown[] = []) => client.query(text, params),
        release: () => {
          // intentionally a no-op — see doc comment above
        },
      };
    },
  };
}

function fixedPostAdapter(caption: string): InsightsAdapter {
  return {
    platform: 'facebook',
    fetchPostList: async () => [
      {
        externalPostId: 'CTW_LIVE_1',
        publishedAt: new Date('2026-06-01T00:00:00Z'),
        mediaType: 'image',
        title: null,
        caption,
        permalink: 'https://example.com/p/ctw-live-1',
        durationSeconds: null,
        thumbnailUrl: null,
      },
    ],
    fetchAccountMetrics: async () => [],
    fetchPostMetrics: async () => [],
    fetchComments: async () => [],
  };
}

test('insights_posts.content_type: dispatcher stamps on first sync, preserves via COALESCE on re-sync, and the standalone backfill is idempotent (real Postgres)', async (t) => {
  if (!dbConfig) {
    console.warn(
      '\n[insights-content-type-writer-requires-infra] SKIPPED: DB env not all set. ' +
        'This test MUST run against a real database in CI/prod validation — a skip ' +
        'means the real planner and the COALESCE-preserve conflict semantics were ' +
        'never exercised.\n',
    );
    requireDbEnvOrSkip(t);
    return;
  }

  const pool = new pg.Pool(dbConfig);
  let tenantId: number | null = null;
  try {
    const client = await pool.connect();
    try {
      // ── Setup: one real organizations row + one insights_accounts row ────
      const orgResult = await client.query<{ id: number }>(
        `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
        ['content-type-writer-requires-infra-tenant'],
      );
      tenantId = orgResult.rows[0].id;

      const accountResult = await client.query<{ id: number }>(
        `INSERT INTO insights_accounts (tenant_id, platform, external_account_id)
         VALUES ($1, 'facebook', 'CTW_LIVE_PAGE')
         RETURNING id`,
        [tenantId],
      );
      const accountId = accountResult.rows[0].id;

      // ── 1. First sync: unambiguously promotional caption stamps content_type ──
      const firstResult = await syncAccountForTenant(tenantId, accountId, 'interval', {
        pool: asSyncPool(client),
        resolveAdapter: () => fixedPostAdapter('20% off this week only! Shop now.'),
      });
      assert.equal(firstResult.status, 'ok', 'first sync completes ok against the real schema');
      assert.equal(firstResult.postsSeen, 1);

      const afterFirst = await client.query<{ content_type: string | null; caption: string | null }>(
        `SELECT content_type, caption FROM insights_posts WHERE tenant_id = $1 AND external_post_id = $2`,
        [tenantId, 'CTW_LIVE_1'],
      );
      assert.equal(afterFirst.rowCount, 1, 'the post row was inserted');
      assert.equal(
        afterFirst.rows[0].content_type,
        'promotional',
        'the real INSERT stamps content_type on first sync',
      );

      // ── 2. Second sync: an unambiguously LIFESTYLE caption on the SAME ──────
      //    external_post_id must NOT overwrite the already-stamped
      //    'promotional' value — the caption itself DOES refresh (title/
      //    caption/platform_data are unconditionally updated), proving this
      //    is genuinely a COALESCE-preserve on content_type specifically, not
      //    a no-op DO UPDATE.
      const secondResult = await syncAccountForTenant(tenantId, accountId, 'interval', {
        pool: asSyncPool(client),
        resolveAdapter: () => fixedPostAdapter('Meet the team behind our workshop! We love our community.'),
      });
      assert.equal(secondResult.status, 'ok', 'second sync completes ok');

      const afterSecond = await client.query<{ content_type: string | null; caption: string | null }>(
        `SELECT content_type, caption FROM insights_posts WHERE tenant_id = $1 AND external_post_id = $2`,
        [tenantId, 'CTW_LIVE_1'],
      );
      assert.equal(afterSecond.rowCount, 1);
      assert.equal(
        afterSecond.rows[0].content_type,
        'promotional',
        'content_type is preserved via COALESCE across a later sync — never re-derived/overwritten',
      );
      assert.equal(
        afterSecond.rows[0].caption,
        'Meet the team behind our workshop! We love our community.',
        'caption itself DOES refresh on DO UPDATE — proving content_type preservation is a real COALESCE, not a stale no-op row',
      );

      // ── 3. Backfill idempotency: a second real row with content_type IS NULL ──
      //    (bypassing the dispatcher — simulating pre-existing history), run
      //    the standalone backfill script twice against the real DB.
      const historyResult = await client.query<{ id: number }>(
        `INSERT INTO insights_posts
           (tenant_id, account_id, platform, external_post_id, published_at, media_type, caption)
         VALUES ($1, $2, 'facebook', 'CTW_LIVE_HISTORY_1', now() - interval '10 days', 'image',
                 'Tag a friend who needs to see this and comment below with your favorite!')
         RETURNING id`,
        [tenantId, accountId],
      );
      const historyPostId = historyResult.rows[0].id;

      const firstBackfill = await runBackfillInsightsContentType({ db: client, tenantId, dryRun: false });
      assert.equal(firstBackfill.rowsUpdated, 1, 'the one NULL-content_type row is classified and updated');
      assert.equal(firstBackfill.classified, 1);

      const afterBackfill = await client.query<{ content_type: string | null }>(
        `SELECT content_type FROM insights_posts WHERE id = $1`,
        [historyPostId],
      );
      assert.equal(
        afterBackfill.rows[0].content_type,
        'engagement',
        'the backfill classifies the history row using the same shared heuristic',
      );

      // Re-running the backfill must be a true no-op: no NULL rows remain in
      // this tenant's scope, so the second pass reports 0 newly classified.
      const secondBackfill = await runBackfillInsightsContentType({ db: client, tenantId, dryRun: false });
      assert.equal(secondBackfill.scanned, 0, 'no content_type IS NULL rows remain for this tenant');
      assert.equal(secondBackfill.classified, 0, 'second backfill run reports 0 newly classified rows (idempotent)');
      assert.equal(secondBackfill.rowsUpdated, 0);
      // Both the dispatcher-stamped row and the backfilled row are now
      // counted as pre-classified on the second pass.
      assert.equal(
        secondBackfill.preClassified,
        2,
        'the second pass counts both already-classified rows (dispatcher-stamped + backfilled) as preClassified',
      );

      console.log(
        '[insights-content-type-writer-requires-infra] PASS: dispatcher stamps + COALESCE-preserves; backfill is idempotent.',
      );
    } finally {
      client.release();
    }
  } finally {
    // Explicit cleanup (organizations cascade-deletes insights_accounts /
    // insights_posts via ON DELETE CASCADE) rather than a wrapping
    // transaction, because syncAccountForTenant's SyncDeps seam is driven
    // above via a no-op-release wrapper around a single checked-out client —
    // see asSyncPool's doc comment for why a shared transaction can't be used
    // the way single-statement live-DB tests in this repo use one.
    if (tenantId !== null) {
      await pool.query('DELETE FROM organizations WHERE id = $1', [tenantId]).catch(() => {
        // best-effort cleanup; a leaked test-tenant row is a minor annoyance,
        // never a reason to mask the real assertion failures above
      });
    }
    await pool.end();
  }
});
