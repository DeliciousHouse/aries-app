/**
 * Slice 6 — manual schedule route threads width_px/height_px/duration_seconds
 * from the posts row into the scheduled_posts INSERT.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/social-content-schedule-dims.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handlePatchScheduleSocialContentPost,
  type ScheduleRouteQueryable,
} from '../app/api/social-content/jobs/[jobId]/posts/[postId]/schedule/route';

type Captured = { sql: string; params: unknown[] };

// ---------------------------------------------------------------------------
// Test queryable factory — posts SELECT returns a post row WITH dims
// ---------------------------------------------------------------------------

function buildQueryableWithDims(
  dims: { width_px: number | null; height_px: number | null; duration_seconds: number | null },
): { queryable: ScheduleRouteQueryable; calls: Captured[] } {
  const calls: Captured[] = [];
  let nextScheduledId = 901;
  const query = (async (sql: string, params: unknown[]) => {
    const trimmed = sql.trim();
    calls.push({ sql: trimmed, params });
    if (trimmed.startsWith('SELECT id, tenant_id') && trimmed.includes('FROM posts')) {
      const [postId, tenantId] = params as [number, number];
      return {
        rows: [{
          id: postId,
          tenant_id: tenantId,
          surface: 'reel',
          media_type: 'video',
          width_px: dims.width_px,
          height_px: dims.height_px,
          duration_seconds: dims.duration_seconds,
        }],
        rowCount: 1,
      };
    }
    if (trimmed.startsWith('INSERT INTO scheduled_posts')) {
      const [postId, tenantId, scheduledFor, platforms] = params as [number, number, string, string[]];
      return {
        rows: [{
          id: nextScheduledId++,
          post_id: postId,
          tenant_id: tenantId,
          scheduled_for: scheduledFor,
          target_platforms: platforms,
          updated_at: '2026-06-23T12:00:00.000Z',
        }],
        rowCount: 1,
      };
    }
    // Campaign end date query (resolveCampaignEndDateForJob) — return null.
    return { rows: [], rowCount: 0 };
  });
  return { queryable: { query } as unknown as ScheduleRouteQueryable, calls };
}

function tenantLoader(tenantId: number) {
  return async () => ({
    userId: '1001',
    tenantId: String(tenantId),
    tenantSlug: `tenant-${tenantId}`,
    role: 'tenant_admin' as const,
  });
}

// ---------------------------------------------------------------------------
// Slice 6 — dims threaded into scheduled_posts INSERT
// ---------------------------------------------------------------------------

test('dims: video reel post with 1080x1920 and 15s are in scheduled_posts INSERT params', async () => {
  // FAIL BEFORE: route did not SELECT/pass width_px/height_px/duration_seconds
  // PASS AFTER:  route reads from posts row and passes to upsertScheduledPost → params[7..9]
  const { queryable, calls } = buildQueryableWithDims({ width_px: 1080, height_px: 1920, duration_seconds: 15 });

  const response = await handlePatchScheduleSocialContentPost(
    'job-dims-test',
    '42',
    new Request('http://aries.example.test/api/social-content/jobs/job-dims-test/posts/42/schedule', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduled_at: '2026-06-25T09:00:00.000Z', platforms: ['instagram'] }),
    }),
    {
      tenantContextLoader: tenantLoader(7),
      queryable,
      publishApprovalResolver: async () => true,
    },
  );

  assert.equal(response.status, 200, 'response must be 200 OK');

  const insertCall = calls.find((c) => c.sql.startsWith('INSERT INTO scheduled_posts'));
  assert.ok(insertCall, 'INSERT INTO scheduled_posts must run');

  // UPSERT_SCHEDULED_POST_SQL params (0-based):
  // [0]=postId [1]=tenantId [2]=scheduledFor [3]=platforms [4]=campaignEndDate
  // [5]=surface [6]=mediaType [7]=widthPx [8]=heightPx [9]=durationSeconds
  const p = insertCall!.params;
  assert.equal(p[5], 'reel', '$6 surface from post row must be reel');
  assert.equal(p[6], 'video', '$7 mediaType from post row must be video');
  assert.equal(p[7], 1080, '$8 widthPx must be 1080 from posts row');
  assert.equal(p[8], 1920, '$9 heightPx must be 1920');
  assert.equal(p[9], 15, '$10 durationSeconds must be 15');
});

test('dims: post with null dims passes null into scheduled_posts INSERT', async () => {
  const { queryable, calls } = buildQueryableWithDims({ width_px: null, height_px: null, duration_seconds: null });

  await handlePatchScheduleSocialContentPost(
    'job-null-dims',
    '55',
    new Request('http://aries.example.test/api/social-content/jobs/job-null-dims/posts/55/schedule', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduled_at: '2026-06-25T10:00:00.000Z', platforms: ['facebook'] }),
    }),
    {
      tenantContextLoader: tenantLoader(8),
      queryable,
      publishApprovalResolver: async () => true,
    },
  );

  const insertCall = calls.find((c) => c.sql.startsWith('INSERT INTO scheduled_posts'));
  assert.ok(insertCall, 'INSERT must run');

  const p = insertCall!.params;
  assert.equal(p[7], null, '$8 widthPx null when no dims');
  assert.equal(p[8], null, '$9 heightPx null');
  assert.equal(p[9], null, '$10 durationSeconds null');
});

test('dims: SELECT from posts includes the dims columns', async () => {
  const { queryable, calls } = buildQueryableWithDims({ width_px: 720, height_px: 1280, duration_seconds: 8 });

  await handlePatchScheduleSocialContentPost(
    'job-select-check',
    '77',
    new Request('http://aries.example.test/api/social-content/jobs/job-select-check/posts/77/schedule', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduled_at: '2026-06-25T11:00:00.000Z', platforms: ['instagram'] }),
    }),
    {
      tenantContextLoader: tenantLoader(9),
      queryable,
      publishApprovalResolver: async () => true,
    },
  );

  // The route's SELECT must include width_px, height_px, duration_seconds so
  // the dims can be passed through. This test ensures the SELECT SQL was widened.
  const selectCall = calls.find((c) => c.sql.startsWith('SELECT id, tenant_id') && c.sql.includes('FROM posts'));
  assert.ok(selectCall, 'SELECT FROM posts must run');
  assert.ok(
    selectCall!.sql.includes('width_px'),
    'SELECT must include width_px (FAIL BEFORE: was not selected)',
  );
  assert.ok(selectCall!.sql.includes('height_px'), 'SELECT must include height_px');
  assert.ok(selectCall!.sql.includes('duration_seconds'), 'SELECT must include duration_seconds');
});

// ---------------------------------------------------------------------------
// Also test upsertScheduledPost directly with dims (unit-level)
// ---------------------------------------------------------------------------

test('upsertScheduledPost: dims passed as params $8/$9/$10', async () => {
  const { upsertScheduledPost } = await import('../backend/social-content/scheduled-posts');

  const captured: { sql: string; params: unknown[] }[] = [];
  const mockQueryable = {
    query: async (sql: string, params: unknown[]) => {
      captured.push({ sql, params });
      return {
        rows: [{
          id: '999', post_id: '42', tenant_id: 15,
          scheduled_for: '2026-06-25T09:00:00.000Z',
          target_platforms: ['instagram'],
          updated_at: '2026-06-23T00:00:00.000Z',
        }],
        rowCount: 1,
      };
    },
  };

  await upsertScheduledPost(mockQueryable, {
    tenantId: 15,
    postId: 42,
    scheduledFor: new Date('2026-06-25T09:00:00.000Z'),
    platforms: ['instagram'],
    surface: 'reel',
    mediaType: 'video',
    widthPx: 1080,
    heightPx: 1920,
    durationSeconds: 20,
  });

  assert.equal(captured.length, 1);
  const p = captured[0]!.params;
  // $8=widthPx, $9=heightPx, $10=durationSeconds (0-based: p[7], p[8], p[9])
  assert.equal(p[7], 1080, '$8 widthPx=1080');
  assert.equal(p[8], 1920, '$9 heightPx=1920');
  assert.equal(p[9], 20, '$10 durationSeconds=20');
  // Also verify surface/mediaType are correct
  assert.equal(p[5], 'reel', '$6 surface=reel');
  assert.equal(p[6], 'video', '$7 mediaType=video');
});

test('upsertScheduledPost: null dims map to null params', async () => {
  const { upsertScheduledPost } = await import('../backend/social-content/scheduled-posts');

  const captured: { sql: string; params: unknown[] }[] = [];
  const mockQueryable = {
    query: async (sql: string, params: unknown[]) => {
      captured.push({ sql, params });
      return {
        rows: [{ id: '1', post_id: '1', tenant_id: 1, scheduled_for: new Date().toISOString(), target_platforms: [], updated_at: new Date().toISOString() }],
        rowCount: 1,
      };
    },
  };

  await upsertScheduledPost(mockQueryable, {
    tenantId: 1,
    postId: 1,
    scheduledFor: new Date(),
    platforms: [],
  });

  const p = captured[0]!.params;
  assert.equal(p[7], null, 'widthPx defaults to null');
  assert.equal(p[8], null, 'heightPx defaults to null');
  assert.equal(p[9], null, 'durationSeconds defaults to null');
});

test('upsertScheduledPost: an in-flight publish cannot be rescheduled or mutate its attempt lease', async () => {
  const { upsertScheduledPost } = await import('../backend/social-content/scheduled-posts');
  const captured: { sql: string; params: unknown[] }[] = [];
  const mockQueryable = {
    query: async (sql: string, params: unknown[]) => {
      captured.push({ sql, params });
      if (sql.trim().startsWith('INSERT INTO scheduled_posts')) {
        // PostgreSQL ON CONFLICT ... DO UPDATE WHERE dispatch_status is not
        // in_flight returns no row when the live attempt owns this schedule.
        return { rows: [], rowCount: 0 };
      }
      if (/SELECT dispatch_status FROM scheduled_posts/i.test(sql)) {
        return { rows: [{ dispatch_status: 'in_flight' }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  await assert.rejects(
    upsertScheduledPost(mockQueryable as never, {
      tenantId: 15,
      postId: 42,
      scheduledFor: new Date('2026-06-25T09:00:00.000Z'),
      platforms: ['facebook'],
    }),
    /scheduled_post_in_flight/,
  );

  const insertCall = captured.find((call) => call.sql.trim().startsWith('INSERT INTO scheduled_posts'));
  assert.ok(insertCall);
  assert.match(
    insertCall.sql,
    /WHERE scheduled_posts\.tenant_id = EXCLUDED\.tenant_id\s+AND scheduled_posts\.dispatch_status <> 'in_flight'/,
    'the conflict update must atomically refuse to touch the mutable row while a publish is live',
  );
});
