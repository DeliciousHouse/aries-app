import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

import { requireDbEnvOrSkip } from './helpers/requires-infra';

// Regression: the dead-campaign sweep (2026-07-21 stuck-queue incident).
//
// The claim filter (campaign_end_date >= NOW()) permanently excludes rows whose
// campaign window passed — correct for delivery (stale campaign content must
// not go out late), but before the sweep those rows rotted as invisible
// forever-'pending' while their posts still read 'approved': 12 rows in prod
// (scheduled 7/07–7/18, campaign_end 7/13 and 7/20), a week of content
// silently undelivered with no surface saying so.
//
// The sweep terminally marks them (dispatch_status='failed', canonical
// 'campaign_window_passed:' error_message) and expires the posts row
// (published_status='expired', the draft-expiry vocabulary), guarded so a
// post that is live anywhere is never touched.
//
// Three layers, matching scheduled-posts-worker-end-date.test.ts:
//   1. Source-level assertions on the exported SQL (always run).
//   2. tick() integration via a fake pool: report wiring + failure isolation.
//   3. Live-DB behavioural exercise in a rolled-back transaction (skips when
//      DB env absent; requires-infra).

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_PATH = path.join(REPO_ROOT, 'scripts/automations/scheduled-posts-worker.mjs');
const WORKER_SRC = readFileSync(WORKER_PATH, 'utf8');

type WorkerModule = {
  SWEEP_DEAD_CAMPAIGN_SQL: string;
  sweepDeadCampaignRows: (pool: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;
  }) => Promise<{ swept: number; postsExpired: number }>;
  tick: (pool: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;
    connect: () => Promise<unknown>;
  }) => Promise<{ processed: number; dispatched: number; failed: number; skipped: number; expired: number }>;
};

async function loadWorker(): Promise<WorkerModule> {
  return (await import(pathToFileURL(WORKER_PATH).href)) as unknown as WorkerModule;
}

// ---------------------------------------------------------------------------
// Layer 1: source-level assertions
// ---------------------------------------------------------------------------

function extractExportedSql(name: string): string {
  const match = WORKER_SRC.match(new RegExp(`export const ${name} = \`([\\s\\S]*?)\`;`));
  assert.ok(match, `${name} must be defined and exported in the worker`);
  return match[1];
}

const SWEEP_SQL = extractExportedSql('SWEEP_DEAD_CAMPAIGN_SQL');

test('sweep selects only permanently-unclaimable rows: past-end pending, or past-end STALE in_flight', () => {
  assert.match(
    SWEEP_SQL,
    /campaign_end_date IS NOT NULL AND campaign_end_date < NOW\(\)/,
    'the dead CTE must require a PASSED campaign_end_date (NULL = weekly legacy, never swept)',
  );
  assert.match(
    SWEEP_SQL,
    /dispatch_status = 'pending'\s+OR \(dispatch_status = 'in_flight' AND dispatch_claimed_at < \$2\)/,
    'pending rows sweep immediately; in_flight rows only past the stale-reclaim cutoff ($2) so a live publish crossing the deadline still writes its own outcome',
  );
  assert.match(SWEEP_SQL, /FOR UPDATE SKIP LOCKED/, 'the dead CTE must skip rows locked by a concurrent claim');
});

test('sweep mutating arm re-checks the FULL predicate (draft-expiry pattern) and writes the existing terminal vocabulary', () => {
  // The UPDATE must re-assert the predicate — a row that gets claimed or
  // finished between the CTE SELECT and the UPDATE is skipped, not clobbered.
  assert.match(
    SWEEP_SQL,
    /WHERE sp\.id = d\.id\s+AND sp\.campaign_end_date IS NOT NULL AND sp\.campaign_end_date < NOW\(\)\s+AND \(sp\.dispatch_status = 'pending'\s+OR \(sp\.dispatch_status = 'in_flight' AND sp\.dispatch_claimed_at < \$2\)\)/,
    'the parent UPDATE must re-check the full dead predicate in its own WHERE',
  );
  assert.match(
    SWEEP_SQL,
    /SET dispatch_status = 'failed'/,
    "the terminal parent state must be the EXISTING 'failed' value (labels.ts / calendar.ts / the child CHECK all handle it)",
  );
  // Widening-union guard: this fix must NOT introduce a new dispatch_status
  // enum value — every ===/'!==' literal check site-wide would need auditing.
  assert.doesNotMatch(SWEEP_SQL, /expired_campaign/, 'no new dispatch_status enum value');
  assert.match(
    SWEEP_SQL,
    /campaign_window_passed: campaign_end_date/,
    'the canonical campaign_window_passed: error_message prefix is what distinguishes a swept row',
  );
  // A partial-success cross-post row (one platform live, one still retrying)
  // rolls up 'pending' and is swept too — the message must not claim "never
  // published" for it (misdiagnosis -> manual re-publish -> duplicate post).
  assert.match(
    SWEEP_SQL,
    /CASE WHEN EXISTS \(SELECT 1 FROM scheduled_post_dispatches spd0\s+WHERE spd0\.scheduled_post_id = sp\.id\s+AND spd0\.status = 'dispatched'\)/,
    'the parent message must be conditional on whether ANY platform already dispatched',
  );
});

test('sweep expires the posts mirror ONLY when the post is provably not live anywhere', () => {
  assert.match(
    SWEEP_SQL,
    /p\.published_at IS NULL\s+AND p\.platform_post_id IS NULL\s+AND p\.published_status IN \('draft','in_review','approved'\)/,
    'posts guard: never expire a published / Meta-native-scheduled / already-terminal post',
  );
  assert.match(
    SWEEP_SQL,
    /SET published_status = 'expired',\s+status = 'expired',\s+expired_at = now\(\)/,
    "posts mirror must write BOTH status columns to 'expired' + expired_at (draft-expiry lockstep rule)",
  );
});

test('sweep terminally fails non-terminal children but PRESERVES their diagnostic error_message', () => {
  assert.match(
    SWEEP_SQL,
    /spd\.status IN \('pending','in_flight'\)/,
    'only non-terminal children are touched; a dispatched child (already live) is never rewritten',
  );
  assert.match(
    SWEEP_SQL,
    /error_message = COALESCE\(spd\.error_message,/,
    'an existing retryable error (e.g. the FB-368 text that caused the miss) is the diagnosis — COALESCE must keep it',
  );
});

test('tick() runs the sweep failure-isolated (a sweep error never stalls dispatch)', () => {
  const tickBody = WORKER_SRC.slice(WORKER_SRC.indexOf('export async function tick'));
  assert.match(
    tickBody,
    /try \{\s*sweep = await sweepDeadCampaignRows\(pool\);\s*\} catch/,
    'the sweep call inside tick() must be wrapped so its failure is isolated',
  );
});

// ---------------------------------------------------------------------------
// Layer 2: tick() integration via a fake pool
// ---------------------------------------------------------------------------

test('tick() reports sweep counts and continues dispatch when the sweep errors', async () => {
  const { tick } = await loadWorker();
  process.env.APP_BASE_URL = 'https://aries.example.test';
  process.env.INTERNAL_API_SECRET = 'test-secret';

  // Case A: sweep returns counts, no due rows -> report.expired wired through.
  const poolA = {
    query: async (sql: string) => {
      if (sql.trimStart().startsWith('WITH dead AS')) {
        return { rows: [{ swept: 3, posts_expired: 2 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 }; // DUE_ROWS_SQL: nothing due
    },
    connect: async () => {
      throw new Error('no claim expected in this case');
    },
  };
  const reportA = await tick(poolA);
  assert.equal(reportA.expired, 3, 'tick report must surface the swept-row count');
  assert.equal(reportA.processed, 0);

  // Case B: the sweep statement throws -> dispatch scan still runs.
  let dueScanned = false;
  const poolB = {
    query: async (sql: string) => {
      if (sql.trimStart().startsWith('WITH dead AS')) {
        throw new Error('sweep exploded');
      }
      dueScanned = true;
      return { rows: [], rowCount: 0 };
    },
    connect: async () => {
      throw new Error('no claim expected in this case');
    },
  };
  const reportB = await tick(poolB);
  assert.equal(dueScanned, true, 'the due-rows scan must still run after a sweep failure');
  assert.equal(reportB.expired, 0, 'a failed sweep reports zero, never a stale count');
});

// ---------------------------------------------------------------------------
// Layer 3: live-DB behavioural exercise (rolled back; requires-infra)
// ---------------------------------------------------------------------------

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

test('dead-campaign sweep semantics against real Postgres (rolled back)', async (t) => {
  const dbConfig = dbConfigFromEnv();
  if (!dbConfig) {
    requireDbEnvOrSkip(t);
    return;
  }
  const { SWEEP_DEAD_CAMPAIGN_SQL } = await loadWorker();

  const pool = new pg.Pool(dbConfig);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const org = await client.query(
        `INSERT INTO organizations (name) VALUES ('campaign-sweep-test') RETURNING id`,
      );
      const tenantId = (org.rows[0] as { id: number }).id;

      // Seed one posts+scheduled_posts pair per case. Helper returns ids.
      async function seedPair(opts: {
        publishedStatus: string;
        dispatchStatus: string;
        campaignEnd: string | null;
        updatedAt?: string;
        platformPostId?: string | null;
      }): Promise<{ postId: number; spId: number }> {
        const post = await client.query(
          `INSERT INTO posts (tenant_id, caption, published_status, platform_post_id)
           VALUES ($1, 'sweep-test caption', $2, $3) RETURNING id`,
          [tenantId, opts.publishedStatus, opts.platformPostId ?? null],
        );
        const postId = (post.rows[0] as { id: number }).id;
        const sp = await client.query(
          `INSERT INTO scheduled_posts
             (post_id, tenant_id, scheduled_for, target_platforms, campaign_end_date, dispatch_status, updated_at)
           VALUES ($1, $2, now() - interval '3 days', '{facebook}', $3, $4, $5)
           RETURNING id`,
          [
            postId,
            tenantId,
            opts.campaignEnd,
            opts.dispatchStatus,
            opts.updatedAt ?? new Date().toISOString(),
          ],
        );
        return { postId, spId: (sp.rows[0] as { id: number }).id };
      }

      const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      const staleUpdated = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h > 15min reclaim

      // 1. pending + past end -> swept, post expired.
      const dead = await seedPair({ publishedStatus: 'approved', dispatchStatus: 'pending', campaignEnd: past });
      // 2. pending + future end -> untouched (still deliverable).
      const alive = await seedPair({ publishedStatus: 'approved', dispatchStatus: 'pending', campaignEnd: future });
      // 3. pending + NULL end (legacy weekly) -> untouched.
      const legacy = await seedPair({ publishedStatus: 'approved', dispatchStatus: 'pending', campaignEnd: null });
      // 4. FRESH in_flight + past end (live publish crossing the deadline) -> untouched.
      const inFlight = await seedPair({ publishedStatus: 'approved', dispatchStatus: 'in_flight', campaignEnd: past });
      // 5. STALE in_flight + past end (crashed pass) -> swept.
      const staleFlight = await seedPair({
        publishedStatus: 'approved',
        dispatchStatus: 'in_flight',
        campaignEnd: past,
        updatedAt: staleUpdated,
      });
      // 6. pending + past end but the post already reached Meta -> row swept,
      //    post NOT expired (the platform_post_id guard).
      const livePost = await seedPair({
        publishedStatus: 'approved',
        dispatchStatus: 'pending',
        campaignEnd: past,
        platformPostId: 'ig_media_123',
      });
      // 7. Partial success: fb child already dispatched (live), ig child still
      //    retryable when the campaign ended. Parent rollup is 'pending' so it
      //    IS swept — but the message must say a platform already published,
      //    and the 'published' post + dispatched child must be untouched.
      const partial = await seedPair({
        publishedStatus: 'published',
        dispatchStatus: 'pending',
        campaignEnd: past,
        platformPostId: 'fb_media_456',
      });
      await client.query(
        `INSERT INTO scheduled_post_dispatches (scheduled_post_id, platform, status)
         VALUES ($1, 'facebook', 'dispatched'), ($1, 'instagram', 'pending')`,
        [partial.spId],
      );
      // Seed a non-terminal child with a diagnostic error for case 1.
      await client.query(
        `INSERT INTO scheduled_post_dispatches (scheduled_post_id, platform, status, error_message)
         VALUES ($1, 'facebook', 'pending', 'rate limit (code 368)')`,
        [dead.spId],
      );

      // NOTE on counts: this transaction sees the REAL database, which may
      // hold genuinely-dead prod rows (the incident population) — the sweep
      // marks those too inside this rolled-back txn. So counts are asserted as
      // lower bounds and the per-case semantics are asserted per-row below.
      // The generous batch limit guarantees the whole population (prod rows +
      // seeds) drains in one pass so the idempotency check is exact.
      const staleCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const sweep = await client.query(SWEEP_DEAD_CAMPAIGN_SQL, [100000, staleCutoff]);
      const counts = sweep.rows[0] as { swept: number; posts_expired: number };
      assert.ok(counts.swept >= 4, `dead pending, stale in_flight, live-post, and partial rows must be swept (got ${counts.swept})`);
      assert.ok(counts.posts_expired >= 2, `the two never-live posts must be expired (got ${counts.posts_expired})`);

      const spState = async (id: number) => {
        const r = await client.query(
          `SELECT dispatch_status, error_message FROM scheduled_posts WHERE id = $1`,
          [id],
        );
        return r.rows[0] as { dispatch_status: string; error_message: string | null };
      };
      const postState = async (id: number) => {
        const r = await client.query(
          `SELECT published_status, status, expired_at FROM posts WHERE id = $1`,
          [id],
        );
        return r.rows[0] as { published_status: string; status: string; expired_at: string | null };
      };

      const deadSp = await spState(dead.spId);
      assert.equal(deadSp.dispatch_status, 'failed');
      assert.match(String(deadSp.error_message), /^campaign_window_passed: campaign_end_date /);
      const deadPost = await postState(dead.postId);
      assert.equal(deadPost.published_status, 'expired');
      assert.equal(deadPost.status, 'expired');
      assert.ok(deadPost.expired_at, 'expired_at is stamped');

      const deadChild = await client.query(
        `SELECT status, error_message FROM scheduled_post_dispatches WHERE scheduled_post_id = $1`,
        [dead.spId],
      );
      assert.equal((deadChild.rows[0] as { status: string }).status, 'failed');
      assert.equal(
        (deadChild.rows[0] as { error_message: string }).error_message,
        'rate limit (code 368)',
        'the diagnostic child error that caused the miss is preserved, not overwritten',
      );

      const partialSp = await spState(partial.spId);
      assert.equal(partialSp.dispatch_status, 'failed', 'partial-success row is swept (rollup was pending)');
      assert.match(
        String(partialSp.error_message),
        /elapsed before full dispatch; at least one platform already published/,
        'partial-success rows must NOT claim "never published"',
      );
      const partialChildren = await client.query(
        `SELECT platform, status FROM scheduled_post_dispatches WHERE scheduled_post_id = $1 ORDER BY platform`,
        [partial.spId],
      );
      assert.deepEqual(
        partialChildren.rows,
        [
          { platform: 'facebook', status: 'dispatched' },
          { platform: 'instagram', status: 'failed' },
        ],
        'the live fb child is untouched; only the never-sent ig child is terminally failed',
      );
      assert.equal(
        (await postState(partial.postId)).published_status,
        'published',
        'a published post is never expired by the sweep',
      );

      assert.equal((await spState(alive.spId)).dispatch_status, 'pending', 'future-end row untouched');
      assert.equal((await spState(legacy.spId)).dispatch_status, 'pending', 'NULL-end row untouched');
      assert.equal((await spState(inFlight.spId)).dispatch_status, 'in_flight', 'fresh in_flight row untouched');
      assert.equal((await spState(staleFlight.spId)).dispatch_status, 'failed', 'stale in_flight row swept');
      assert.equal(
        (await postState(livePost.postId)).published_status,
        'approved',
        'a post that reached Meta keeps its status even though its schedule row is swept',
      );

      // Idempotency: a second pass matches nothing (the first drained the
      // whole population within this transaction).
      const again = await client.query(SWEEP_DEAD_CAMPAIGN_SQL, [100000, staleCutoff]);
      assert.equal((again.rows[0] as { swept: number }).swept, 0, 'sweep is idempotent');

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
});
