import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

import { buildSocialContentDashboardProjection } from '../../backend/social-content/dashboard-projection';
import { countPublishedPostsForJob } from '../../backend/marketing/published-posts-count';
import type { MarketingDashboardSocialContentJobContent } from '../../backend/marketing/dashboard-content';
import type { SocialContentJobRuntimeDocument } from '../../backend/marketing/runtime-state';

// Regression test for the dashboard "Publish items 0" bug.
//
// The counter was a runtime-doc projection of `payload.publish_package` — a
// dead OpenClaw-era contract the Hermes pipeline never emits — so a completed
// campaign with real synthesized DB `posts` rows still showed "Publish items
// 0". The fix threads a real DB `posts` count into
// buildSocialContentDashboardProjection; this test pins both halves:
//   (1) the projection reflects the real count even when the legacy
//       `includePublishQueue` runtime-state gate is off (pure, no DB);
//   (2) countPublishedPostsForJob counts real `posts` rows by job_id against
//       live Postgres (the count must match reality, not a mock).

function emptyDashboard(): MarketingDashboardSocialContentJobContent {
  return {
    post: null,
    posts: [],
    assets: [],
    publishItems: [],
    calendarEvents: [],
    statuses: {
      countsByStatus: {
        draft: 0,
        in_review: 0,
        ready: 0,
        ready_to_publish: 0,
        published_to_meta_paused: 0,
        scheduled: 0,
        live: 0,
      },
    },
  };
}

// A completed weekly-social runtime doc whose projection plan has ONE post but
// whose `publishingRequested` is unset — i.e. the legacy `includePublishQueue`
// gate is false. This is the shape that produced "Publish items 0" in prod.
function completedSocialDoc(): SocialContentJobRuntimeDocument {
  return {
    tenant_id: 'tenant_publish_counter',
    job_id: 'mkt_publish_counter',
    created_at: '2026-05-20T00:00:00.000Z',
    updated_at: '2026-05-20T00:00:00.000Z',
    inputs: {
      brand_url: 'https://brand.example',
      request: { jobType: 'weekly_social_content', businessName: 'Counter Studio' },
    },
    brand_kit: { brand_name: 'Counter Studio' },
    social_content_runtime: {
      // currentStage is NOT publish_review/completed and publishingRequested is
      // unset — the legacy gate would yield zero publish items.
      currentStage: 'creative_review',
      stageOrder: ['planning', 'creative_review', 'publish_review'],
      stages: {
        planning: {
          output: {
            weekly_content_plan: {
              window_days: 7,
              posts: [
                {
                  id: 'creative-a',
                  day: 'Day 1',
                  platforms: ['instagram'],
                  post_type: 'static',
                  title: 'Post A',
                  caption: 'Caption A.',
                  creative_brief_id: 'creative-a',
                  status: 'approved',
                },
              ],
              image_creatives: [],
              video_scripts: [],
            },
          },
        },
      },
    },
  } as unknown as SocialContentJobRuntimeDocument;
}

test('publish-items counter is 0 without a real post count (reproduces the bug)', () => {
  const dashboard = buildSocialContentDashboardProjection(completedSocialDoc(), emptyDashboard());
  assert.equal(dashboard.publishItems.length, 0, 'legacy gate yields no publish items');
  assert.equal(dashboard.post?.counts.publishItems, 0, 'counter shows 0 — the bug');
});

test('publish-items counter reflects the real DB post count even when the legacy gate is off', () => {
  const dashboard = buildSocialContentDashboardProjection(completedSocialDoc(), emptyDashboard(), {
    realPublishedPostCount: 3,
  });
  assert.equal(
    dashboard.publishItems.length,
    3,
    'publish items padded up to the real synthesized DB post count',
  );
  assert.equal(
    dashboard.post?.counts.publishItems,
    3,
    'campaign counter matches the real DB post count',
  );
});

test('publish-items counter never drops below the projection plan posts', () => {
  // realPublishedPostCount lower than the plan must not shrink the queue.
  const dashboard = buildSocialContentDashboardProjection(
    completedSocialDoc(),
    emptyDashboard(),
    { realPublishedPostCount: 1 },
  );
  assert.equal(dashboard.publishItems.length, 1);
  assert.equal(dashboard.post?.counts.publishItems, 1);
});

function dbConfigFromEnv(): pg.PoolConfig | null {
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  if (!DB_HOST || !DB_PORT || !DB_USER || !DB_PASSWORD || !DB_NAME) {
    return null;
  }
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

test('countPublishedPostsForJob counts real posts rows by job_id (live Postgres)', async (t) => {
  if (!dbConfig) {
    console.warn(
      '\n[dashboard-publish-items-counter] SKIPPED: DB env not all set. This ' +
        'test MUST run against real Postgres — a skip means the counter query ' +
        'was never exercised against the live `posts` schema.\n',
    );
    t.skip('database env not configured');
    return;
  }

  const pool = new pg.Pool(dbConfig);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const orgResult = await client.query<{ id: number }>(
        `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
        ['publish-counter-tenant'],
      );
      const tenantId = orgResult.rows[0].id;
      const jobId = `mkt_publishcounter_${Date.now()}`;
      const otherJobId = `mkt_publishcounter_other_${Date.now()}`;

      // Zero rows yet.
      assert.equal(
        await countPublishedPostsForJob(tenantId, jobId, client),
        0,
        'no posts -> count 0',
      );

      // Insert two posts for the job and one for a sibling job (must not leak).
      for (const [job, platform, idem] of [
        [jobId, 'instagram', `${jobId}:1:instagram`],
        [jobId, 'facebook', `${jobId}:1:facebook`],
        [otherJobId, 'instagram', `${otherJobId}:1:instagram`],
      ] as const) {
        await client.query(
          `INSERT INTO posts (tenant_id, job_id, platform, media_type, caption,
             status, published_status, idempotency_key)
           VALUES ($1, $2, $3, 'image', 'Caption.', 'approved', 'approved', $4)`,
          [tenantId, job, platform, idem],
        );
      }

      assert.equal(
        await countPublishedPostsForJob(tenantId, jobId, client),
        2,
        'counts exactly the two posts for this job_id, ignoring the sibling job',
      );

      // String tenant id (the runtime doc carries tenant_id as a string).
      assert.equal(
        await countPublishedPostsForJob(String(tenantId), jobId, client),
        2,
        'string tenant id resolves the same count',
      );

      // Unusable tenant id -> 0, no throw.
      assert.equal(await countPublishedPostsForJob('not-a-number', jobId, client), 0);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    console.log(
      '[dashboard-publish-items-counter] PASS: counter reflects real `posts` ' +
        'rows by job_id against live Postgres.',
    );
  } finally {
    await pool.end();
  }
});
