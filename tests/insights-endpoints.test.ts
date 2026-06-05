/**
 * tests/insights-endpoints.test.ts
 *
 * Integration tests for the Insights API endpoints (Sections 2–6).
 * Self-skips when the DB env vars are not configured.
 *
 * Run with:
 *   ARIES_TEST_REQUIRES_INFRA_ENABLED=1 \
 *   DB_HOST=... DB_PORT=5432 DB_USER=... DB_PASSWORD=... DB_NAME=... \
 *   APP_BASE_URL=https://aries.example.com \
 *   tsx --test tests/insights-endpoints.test.ts
 *
 * Pre-conditions:
 *   - `npm run db:init` has been run (schema in place)
 *   - `npm run db:seed-insights` has been run (seed tenant + YouTube data)
 *     The seed creates a tenant with slug 'insights-demo'.
 *
 * What the seed data covers (and its limitations):
 *   - 1 YouTube account, 30 days account-level metrics, 15 posts, 50 comments
 *   - NO aries_post_id on insights_posts → Sections 4–6 return hasData=false
 *     with raw seed data alone. This test wires up aries_post_id via a temp
 *     post insert so the full flow can be exercised.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import pool from '@/lib/db';
import type { TenantContext } from '@/lib/tenant-context';
import { handleGetInsightsGoal } from '@/backend/insights/goal/handler';
import { handleGetInsightsAttention } from '@/backend/insights/attention/handler';
import { handleGetInsightsActivity } from '@/backend/insights/activity/handler';
import { handleGetInsightsTrends } from '@/backend/insights/trends/handler';
import { handleGetInsightsTop } from '@/backend/insights/top/handler';
import { requireDbEnvOrSkip } from './helpers/requires-infra';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fakeRequest(params: Record<string, string>): Request {
  const qs = new URLSearchParams(params).toString();
  return new Request(`https://aries.example.com/api/insights/test?${qs}`);
}

function makeTenantLoader(tenantId: number): () => Promise<TenantContext> {
  return async () => ({
    tenantId:   String(tenantId),
    tenantSlug: 'insights-demo',
    role:       'tenant_admin' as const,
    userId:     'test-user',
  } as TenantContext);
}

async function json(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let tenantId = -1;
let wiredPostCount = 0;

test.before(async () => {
  const client = await pool.connect();
  try {
    // Resolve seed tenant
    const org = await client.query<{ id: number }>(
      `SELECT id FROM organizations WHERE slug = 'insights-demo' LIMIT 1`,
    );
    if (org.rows.length === 0) {
      throw new Error(
        'Seed tenant not found. Run: npm run db:seed-insights',
      );
    }
    tenantId = org.rows[0].id;

    // Insert a minimal posts row so aries_post_id FK can be satisfied.
    // We insert one post and link the 5 most recent insights_posts to it,
    // simulating that they were Aries-generated.
    const postRes = await client.query<{ id: number }>(
      `INSERT INTO posts (tenant_id, caption, published_status, status)
       VALUES ($1, 'Test post for insights integration test', 'published', 'published')
       RETURNING id`,
      [tenantId],
    );
    const fakeAriesPostId = postRes.rows[0].id;

    // Link the 5 most-recently-published insights_posts to this fake aries post
    const linked = await client.query<{ id: number }>(
      `UPDATE insights_posts
       SET aries_post_id = $1
       WHERE id IN (
         SELECT id FROM insights_posts
         WHERE tenant_id = $2 AND aries_post_id IS NULL
         ORDER BY published_at DESC
         LIMIT 5
       )
       RETURNING id`,
      [fakeAriesPostId, tenantId],
    );
    wiredPostCount = linked.rowCount ?? 0;
  } finally {
    client.release();
  }
});

test.after(async () => {
  // Clean up wired aries_post_id and the temp post to leave the seed clean
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE insights_posts SET aries_post_id = NULL WHERE tenant_id = $1`,
      [tenantId],
    );
    await client.query(
      `DELETE FROM posts
       WHERE tenant_id = $1 AND caption = 'Test post for insights integration test'`,
      [tenantId],
    );
  } finally {
    client.release();
    await pool.end();
  }
});

// ── Section 2 — Goal ──────────────────────────────────────────────────────────

test('GET /api/insights/goal — week period returns valid shape', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const res = await handleGetInsightsGoal(
    fakeRequest({ period: 'week', platform: 'all' }),
    makeTenantLoader(tenantId),
  );

  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  const body = await json(res);

  // Valid statuses: 'ok' (goal configured) or 'no_goal' (tenant has no goal yet — expected for seed data)
  assert.ok(
    body.status === 'ok' || body.status === 'no_goal',
    `status field: ${JSON.stringify(body)}`,
  );

  if (body.status === 'ok') {
    assert.ok('period' in body, 'missing period');
    assert.ok('platform' in body, 'missing platform');
    assert.ok('cached' in body, 'missing cached flag');
    const meta = body.meta as Record<string, unknown> | undefined;
    assert.ok(meta, 'missing meta');
    assert.ok('hasData' in meta, 'meta missing hasData');
  }

  console.log('[goal/week]', JSON.stringify({ status: body.status }));
});

test('GET /api/insights/goal — 30day period', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const res = await handleGetInsightsGoal(
    fakeRequest({ period: '30day', platform: 'all', force: 'true' }),
    makeTenantLoader(tenantId),
  );
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.ok(body.status === 'ok' || body.status === 'no_goal');
  console.log('[goal/30day] status:', body.status);
});

test('GET /api/insights/goal — rejects invalid period', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const res = await handleGetInsightsGoal(
    fakeRequest({ period: 'invalid' }),
    makeTenantLoader(tenantId),
  );
  assert.equal(res.status, 400);
});

// ── Section 3 — Attention ─────────────────────────────────────────────────────

test('GET /api/insights/attention — week returns card array', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const res = await handleGetInsightsAttention(
    fakeRequest({ period: 'week', platform: 'all' }),
    makeTenantLoader(tenantId),
  );

  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.status, 'ok');
  assert.ok(Array.isArray(body.cards), 'cards must be an array');
  assert.ok('meta' in body, 'missing meta');

  const cards = body.cards as unknown[];
  console.log(`[attention/week] ${cards.length} cards`);
});

test('GET /api/insights/attention — 90day platform=youtube', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const res = await handleGetInsightsAttention(
    fakeRequest({ period: '90day', platform: 'youtube', force: 'true' }),
    makeTenantLoader(tenantId),
  );
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.status, 'ok');
  console.log('[attention/90day/youtube] meta:', JSON.stringify(body.meta));
});

// ── Section 4 — Activity ──────────────────────────────────────────────────────

test('GET /api/insights/activity — week returns strip + content mix', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const res = await handleGetInsightsActivity(
    fakeRequest({ period: 'week', platform: 'all' }),
    makeTenantLoader(tenantId),
  );

  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.status, 'ok');
  assert.ok('strip' in body, 'missing strip');
  assert.ok('contentMix' in body, 'missing contentMix');
  assert.ok('meta' in body, 'missing meta');

  const strip = body.strip as Record<string, unknown>;
  assert.ok('postsPublished' in strip, 'strip missing postsPublished');
  assert.ok('hoursSaved' in strip, 'strip missing hoursSaved');

  const meta = body.meta as Record<string, unknown>;
  const hasData = meta.hasData as boolean;
  // With wiredPostCount posts linked, we expect hasData=true for activity
  if (wiredPostCount > 0) {
    console.log(`[activity/week] postsPublished=${strip.postsPublished}, hasData=${hasData}`);
  } else {
    console.log('[activity/week] ⚠ wiredPostCount=0 — no aries_post_id rows, hasData will be false');
  }
});

test('GET /api/insights/activity — 30day platform=youtube', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const res = await handleGetInsightsActivity(
    fakeRequest({ period: '30day', platform: 'youtube', force: 'true' }),
    makeTenantLoader(tenantId),
  );
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.status, 'ok');
  const strip = body.strip as Record<string, unknown>;
  console.log('[activity/30day/youtube] strip:', JSON.stringify(strip));
});

// ── Section 5 — Trends ────────────────────────────────────────────────────────

test('GET /api/insights/trends — week returns metrics + series', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const res = await handleGetInsightsTrends(
    fakeRequest({ period: 'week', platform: 'all' }),
    makeTenantLoader(tenantId),
  );

  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.status, 'ok');
  assert.ok('metrics' in body, 'missing metrics');
  assert.ok('series' in body, 'missing series');
  assert.ok('keyMovements' in body, 'missing keyMovements');
  assert.ok('platformBreakdown' in body, 'missing platformBreakdown');
  assert.ok('visitsAvailable' in body, 'missing visitsAvailable');

  // YouTube seed: visits not tracked → visitsAvailable should be false
  assert.equal(body.visitsAvailable, false, 'YouTube seed has no profile_visits — expect visitsAvailable=false');

  const series = body.series as Record<string, unknown>;
  const metrics = body.metrics as Record<string, unknown>;
  console.log('[trends/week] visitsAvailable=false ✓, metrics keys:', Object.keys(metrics));
  console.log('[trends/week] series keys:', Object.keys(series));
});

test('GET /api/insights/trends — 90day returns weekly-bucketed series', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const res = await handleGetInsightsTrends(
    fakeRequest({ period: '90day', platform: 'all', force: 'true' }),
    makeTenantLoader(tenantId),
  );
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.status, 'ok');

  // series.reach is { current: [...], prior: [...], labels: [...] } — not a flat array
  const series = body.series as Record<string, { current: unknown[]; prior: unknown[]; labels: unknown[] }> | undefined;
  assert.ok(series, 'missing series');
  assert.ok(series.reach, 'series.reach missing');

  // 90day uses weekly bucketing — expect ~13 buckets, never 90 daily points
  const currentBuckets = series.reach.current ?? [];
  assert.ok(currentBuckets.length <= 14, `Expected ≤14 weekly buckets, got ${currentBuckets.length}`);
  console.log(`[trends/90day] reach.current length: ${currentBuckets.length} (expect ≤14 weekly buckets)`);
});

test('GET /api/insights/trends — invalid period returns 400', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const res = await handleGetInsightsTrends(
    fakeRequest({ period: 'bad' }),
    makeTenantLoader(tenantId),
  );
  assert.equal(res.status, 400);
});

// ── Section 6 — Top Performing Content ───────────────────────────────────────

test('GET /api/insights/top — reach sort returns post list + pattern', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const res = await handleGetInsightsTop(
    fakeRequest({ period: '30day', platform: 'all', sort: 'reach' }),
    makeTenantLoader(tenantId),
  );

  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.status, 'ok');
  assert.ok(Array.isArray(body.posts), 'posts must be array');
  assert.ok('pattern' in body, 'missing pattern');
  assert.ok('sortBy' in body, 'missing sortBy');
  assert.equal(body.sortBy, 'reach');

  const posts = body.posts as unknown[];
  assert.ok(posts.length <= 5, `At most 5 posts, got ${posts.length}`);

  if (posts.length > 0) {
    const first = posts[0] as Record<string, unknown>;
    assert.ok('id' in first, 'post missing id');
    assert.ok('reach' in first, 'post missing reach');
    assert.ok('whyItWorked' in first, 'post missing whyItWorked');
    assert.ok('multiplier' in first, 'post missing multiplier');
    assert.ok(typeof first.whyItWorked === 'string' && first.whyItWorked.length > 0, 'whyItWorked should be non-empty string');
    console.log(`[top/reach] ${posts.length} posts, top post reach=${first.reach}, multiplier=${first.multiplier}`);
    console.log(`[top/reach] whyItWorked: "${first.whyItWorked}"`);
  } else {
    console.log('[top/reach] ⚠ 0 posts — check if aries_post_id wiring succeeded');
  }

  const pattern = body.pattern as Record<string, unknown>;
  assert.ok('title' in pattern, 'pattern missing title');
  assert.ok('takeaway' in pattern, 'pattern missing takeaway');
  console.log(`[top/reach] pattern: "${pattern.title}"`);
});

test('GET /api/insights/top — engagement sort', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const res = await handleGetInsightsTop(
    fakeRequest({ period: '30day', platform: 'all', sort: 'engagement', force: 'true' }),
    makeTenantLoader(tenantId),
  );
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.sortBy, 'engagement');

  // Verify engagement sort is descending
  const posts = body.posts as Array<{ engagement: number }>;
  for (let i = 1; i < posts.length; i++) {
    assert.ok(
      posts[i - 1].engagement >= posts[i].engagement,
      `Engagement sort broken at index ${i}: ${posts[i-1].engagement} < ${posts[i].engagement}`,
    );
  }
  console.log(`[top/engagement] sort order verified across ${posts.length} posts`);
});

test('GET /api/insights/top — invalid sort falls back to reach', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const res = await handleGetInsightsTop(
    fakeRequest({ period: 'week', platform: 'all', sort: 'notasortkeyXYZ' }),
    makeTenantLoader(tenantId),
  );
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.sortBy, 'reach', 'invalid sort should fall back to reach');
  console.log('[top/invalid-sort] correctly fell back to reach');
});

test('GET /api/insights/top — 90day youtube returns valid response', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const res = await handleGetInsightsTop(
    fakeRequest({ period: '90day', platform: 'youtube', sort: 'saves', force: 'true' }),
    makeTenantLoader(tenantId),
  );
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.status, 'ok');
  assert.equal(body.sortBy, 'saves');
  const posts = body.posts as unknown[];
  console.log(`[top/90day/youtube/saves] ${posts.length} posts`);
});
