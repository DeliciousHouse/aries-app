import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleGetScheduledPosts,
  type ScheduledPostsQueryable,
} from '../app/api/social-content/scheduled-posts/route';

type Captured = { sql: string; params: unknown[] };

function buildQueryable(
  rows: unknown[],
  unscheduledRows: unknown[] = [],
): {
  queryable: ScheduledPostsQueryable;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const query = (async (sql: string, params: unknown[]) => {
    const trimmed = sql.trim();
    calls.push({ sql: trimmed, params });
    // The route runs the unscheduled-backlog query after the main queue query.
    if (trimmed.includes('LEFT JOIN scheduled_posts')) {
      return { rows: unscheduledRows, rowCount: unscheduledRows.length };
    }
    return { rows, rowCount: rows.length };
  });
  return { queryable: { query } as unknown as ScheduledPostsQueryable, calls };
}

function tenantLoader(tenantId: number) {
  return async () => ({
    userId: '1001',
    tenantId: String(tenantId),
    tenantSlug: `tenant-${tenantId}`,
    role: 'tenant_admin' as const,
  });
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 901,
    post_id: 42,
    tenant_id: 7,
    scheduled_for: '2026-05-21T13:00:00.000Z',
    target_platforms: ['facebook', 'instagram'],
    dispatch_status: 'pending',
    dispatched_at: null,
    error_at: null,
    error_message: null,
    updated_at: '2026-05-20T12:00:00.000Z',
    job_id: 'job-abc-123',
    caption: 'Spring sale is live\nGrab it now',
    platform: 'facebook',
    dispatches: [
      { platform: 'facebook', status: 'dispatched', dispatched_at: '2026-05-21T13:01:00.000Z', error_at: null, error_message: null },
      { platform: 'instagram', status: 'failed', dispatched_at: null, error_at: '2026-05-21T13:02:00.000Z', error_message: 'rate limited' },
    ],
    ...overrides,
  };
}

function getRequest(query: string) {
  return new Request(`http://aries.example.test/api/social-content/scheduled-posts${query}`, {
    method: 'GET',
  });
}

test('GET scheduled-posts is tenant-scoped and date-range filtered', async () => {
  const { queryable, calls } = buildQueryable([makeRow()]);
  const response = await handleGetScheduledPosts(
    getRequest('?from=2026-05-20T00:00:00.000Z&to=2026-05-28T00:00:00.000Z'),
    { tenantContextLoader: tenantLoader(7), queryable },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { posts: unknown[]; range: { from: string; to: string } };
  assert.equal(body.posts.length, 1);

  const call = calls[0];
  assert.ok(call, 'a DB query must have run');
  // tenant id, then the two range bounds, in order.
  assert.deepEqual(call.params, [
    7,
    '2026-05-20T00:00:00.000Z',
    '2026-05-28T00:00:00.000Z',
  ]);
  assert.match(call.sql, /sp\.tenant_id = \$1/);
  assert.match(call.sql, /sp\.scheduled_for >= \$2/);
  assert.match(call.sql, /sp\.scheduled_for < \$3/);
});

test('GET scheduled-posts returns the real posts.job_id and per-platform dispatch detail', async () => {
  const { queryable } = buildQueryable([makeRow()]);
  const response = await handleGetScheduledPosts(
    getRequest('?from=2026-05-20T00:00:00.000Z&to=2026-05-28T00:00:00.000Z'),
    { tenantContextLoader: tenantLoader(7), queryable },
  );

  const body = (await response.json()) as {
    posts: Array<{
      id: string;
      postId: string;
      jobId: string | null;
      title: string;
      scheduledFor: string;
      dispatchStatus: string;
      dispatches: Array<{ platform: string; status: string; errorMessage: string | null }>;
    }>;
  };
  const post = body.posts[0];
  assert.equal(post.id, '901');
  assert.equal(post.postId, '42');
  assert.equal(post.jobId, 'job-abc-123', 'job_id must be the real stored value');
  assert.equal(post.title, 'Spring sale is live');
  assert.equal(post.scheduledFor, '2026-05-21T13:00:00.000Z');
  assert.equal(post.dispatchStatus, 'pending');
  assert.equal(post.dispatches.length, 2);
  const ig = post.dispatches.find((d) => d.platform === 'instagram');
  assert.equal(ig?.status, 'failed');
  assert.equal(ig?.errorMessage, 'rate limited');
});

test('GET scheduled-posts rejects a missing date range with 400', async () => {
  const { queryable } = buildQueryable([]);
  const response = await handleGetScheduledPosts(getRequest('?from=2026-05-20T00:00:00.000Z'), {
    tenantContextLoader: tenantLoader(7),
    queryable,
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { reason: string };
  assert.equal(body.reason, 'invalid_date_range');
});

test('GET scheduled-posts rejects a non-ISO date param with 400', async () => {
  const { queryable } = buildQueryable([]);
  const response = await handleGetScheduledPosts(
    getRequest('?from=not-a-date&to=2026-05-28T00:00:00.000Z'),
    { tenantContextLoader: tenantLoader(7), queryable },
  );
  assert.equal(response.status, 400);
  const body = (await response.json()) as { reason: string };
  assert.equal(body.reason, 'invalid_date_range');
});

test('GET scheduled-posts rejects from >= to with 400', async () => {
  const { queryable, calls } = buildQueryable([]);
  const response = await handleGetScheduledPosts(
    getRequest('?from=2026-05-28T00:00:00.000Z&to=2026-05-20T00:00:00.000Z'),
    { tenantContextLoader: tenantLoader(7), queryable },
  );
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0, 'must not query the DB on an invalid range');
});

test('GET scheduled-posts handles an empty queue with a 200 + empty array', async () => {
  const { queryable } = buildQueryable([]);
  const response = await handleGetScheduledPosts(
    getRequest('?from=2026-05-20T00:00:00.000Z&to=2026-05-28T00:00:00.000Z'),
    { tenantContextLoader: tenantLoader(7), queryable },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { posts: unknown[] };
  assert.deepEqual(body.posts, []);
});

test('GET scheduled-posts returns the unscheduled approved-posts backlog (T13)', async () => {
  const { queryable, calls } = buildQueryable(
    [makeRow()],
    [
      { id: 77, job_id: 'job-9', caption: 'Approved waiting post\nbody', platform: 'instagram' },
      { id: 78, job_id: null, caption: '', platform: null },
    ],
  );
  const response = await handleGetScheduledPosts(
    getRequest('?from=2026-05-20T00:00:00.000Z&to=2026-05-28T00:00:00.000Z'),
    { tenantContextLoader: tenantLoader(7), queryable },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    unscheduled: Array<{ postId: string; jobId: string | null; title: string; platform: string | null }>;
  };
  assert.equal(body.unscheduled.length, 2);
  assert.equal(body.unscheduled[0].postId, '77');
  assert.equal(body.unscheduled[0].jobId, 'job-9');
  assert.equal(body.unscheduled[0].title, 'Approved waiting post');
  assert.equal(body.unscheduled[1].title, 'Scheduled post');

  // The backlog query is tenant-scoped and filters out rows with a schedule.
  const backlogCall = calls.find((call) => call.sql.includes('LEFT JOIN scheduled_posts'));
  assert.ok(backlogCall, 'the unscheduled backlog query must run');
  assert.deepEqual(backlogCall.params, [7]);
  assert.match(backlogCall.sql, /sp\.id IS NULL/);
  assert.match(backlogCall.sql, /p\.tenant_id = \$1/);
});

test('GET scheduled-posts falls back to a generic title for a blank caption', async () => {
  const { queryable } = buildQueryable([makeRow({ caption: '', dispatches: [] })]);
  const response = await handleGetScheduledPosts(
    getRequest('?from=2026-05-20T00:00:00.000Z&to=2026-05-28T00:00:00.000Z'),
    { tenantContextLoader: tenantLoader(7), queryable },
  );
  const body = (await response.json()) as { posts: Array<{ title: string; dispatches: unknown[] }> };
  assert.equal(body.posts[0].title, 'Scheduled post');
  assert.deepEqual(body.posts[0].dispatches, []);
});
