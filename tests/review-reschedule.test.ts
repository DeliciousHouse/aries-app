import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handlePatchScheduleSocialContentPost,
  type ScheduleRouteQueryable,
} from '../app/api/social-content/jobs/[jobId]/posts/[postId]/schedule/route';

type Captured = {
  sql: string;
  params: unknown[];
};

interface FixtureOptions {
  ownedTenantId?: number;
  ownedPostId?: number;
}

function buildQueryable(opts: FixtureOptions = {}): {
  queryable: ScheduleRouteQueryable;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const ownedTenantId = opts.ownedTenantId ?? 7;
  const ownedPostId = opts.ownedPostId ?? 42;
  let nextScheduledId = 901;
  const query = (async (sql: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => {
    const trimmed = sql.trim();
    calls.push({ sql: trimmed, params });
    if (trimmed.startsWith('SELECT id, tenant_id FROM posts')) {
      const [postId, tenantId] = params as [number, number];
      if (postId === ownedPostId && tenantId === ownedTenantId) {
        return { rows: [{ id: postId, tenant_id: tenantId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (trimmed.startsWith('INSERT INTO scheduled_posts')) {
      const [postId, tenantId, scheduledFor, platforms] = params as [number, number, string, string[]];
      return {
        rows: [
          {
            id: nextScheduledId++,
            post_id: postId,
            tenant_id: tenantId,
            scheduled_for: scheduledFor,
            target_platforms: platforms,
            updated_at: '2026-05-06T12:00:00.000Z',
          },
        ],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected SQL in test fixture: ${trimmed}`);
  });
  const queryable = { query } as unknown as ScheduleRouteQueryable;
  return { queryable, calls };
}

function tenantLoader(tenantId: number) {
  return async () => ({
    userId: '1001',
    tenantId: String(tenantId),
    tenantSlug: `tenant-${tenantId}`,
    role: 'tenant_admin' as const,
  });
}

// These tests exercise scheduling mechanics, not the publish-approval gate
// (covered by social-content-schedule-approval.test.ts), so they always
// resolve the gate as approved.
const approvedResolver = async () => true;

test('PATCH schedule persists scheduled_at ISO and platforms with FB toggled off (instagram only)', async () => {
  const { queryable, calls } = buildQueryable({ ownedTenantId: 7, ownedPostId: 42 });
  const scheduledIso = '2026-05-13T13:00:00.000Z';
  const response = await handlePatchScheduleSocialContentPost(
    'job-001',
    '42',
    new Request('http://aries.example.test/api/social-content/jobs/job-001/posts/42/schedule', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduled_at: scheduledIso, platforms: ['instagram'] }),
    }),
    { tenantContextLoader: tenantLoader(7), queryable, publishApprovalResolver: approvedResolver },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.jobId, 'job-001');
  assert.equal(body.postId, '42');
  assert.equal(body.scheduledAt, scheduledIso);
  assert.deepEqual(body.platforms, ['instagram']);

  const insertCall = calls.find((call) => call.sql.startsWith('INSERT INTO scheduled_posts'));
  assert.ok(insertCall, 'INSERT INTO scheduled_posts must be invoked');
  const [postIdParam, tenantIdParam, scheduledForParam, platformsParam] = insertCall.params as [
    number,
    number,
    string,
    string[],
  ];
  assert.equal(postIdParam, 42);
  assert.equal(tenantIdParam, 7);
  assert.equal(scheduledForParam, scheduledIso);
  assert.deepEqual(platformsParam, ['instagram']);
});

test('PATCH schedule preserves both platforms when FB and IG selected', async () => {
  const { queryable, calls } = buildQueryable();
  const response = await handlePatchScheduleSocialContentPost(
    'job-002',
    '42',
    new Request('http://aries.example.test/api/social-content/jobs/job-002/posts/42/schedule', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduled_at: '2026-05-14T09:00:00.000Z', platforms: ['instagram', 'facebook'] }),
    }),
    { tenantContextLoader: tenantLoader(7), queryable, publishApprovalResolver: approvedResolver },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(body.platforms, ['instagram', 'facebook']);
  const insertCall = calls.find((call) => call.sql.startsWith('INSERT INTO scheduled_posts'));
  assert.deepEqual(insertCall?.params[3], ['instagram', 'facebook']);
});

test('PATCH schedule rejects empty platforms array with 400', async () => {
  const { queryable, calls } = buildQueryable();
  const response = await handlePatchScheduleSocialContentPost(
    'job-003',
    '42',
    new Request('http://aries.example.test/api/social-content/jobs/job-003/posts/42/schedule', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduled_at: '2026-05-14T09:00:00.000Z', platforms: [] }),
    }),
    { tenantContextLoader: tenantLoader(7), queryable, publishApprovalResolver: approvedResolver },
  );
  assert.equal(response.status, 400);
  const body = (await response.json()) as { reason: string };
  assert.equal(body.reason, 'invalid_platforms');
  assert.equal(calls.length, 0);
});

test('PATCH schedule rejects unknown platform values with 400', async () => {
  const { queryable, calls } = buildQueryable();
  const response = await handlePatchScheduleSocialContentPost(
    'job-004',
    '42',
    new Request('http://aries.example.test/api/social-content/jobs/job-004/posts/42/schedule', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduled_at: '2026-05-14T09:00:00.000Z', platforms: ['linkedin'] }),
    }),
    { tenantContextLoader: tenantLoader(7), queryable, publishApprovalResolver: approvedResolver },
  );
  assert.equal(response.status, 400);
  const body = (await response.json()) as { reason: string };
  assert.equal(body.reason, 'invalid_platforms');
  assert.equal(calls.length, 0);
});

test('PATCH schedule rejects invalid scheduled_at with 400', async () => {
  const { queryable, calls } = buildQueryable();
  const response = await handlePatchScheduleSocialContentPost(
    'job-005',
    '42',
    new Request('http://aries.example.test/api/social-content/jobs/job-005/posts/42/schedule', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduled_at: 'not-a-date', platforms: ['instagram'] }),
    }),
    { tenantContextLoader: tenantLoader(7), queryable, publishApprovalResolver: approvedResolver },
  );
  assert.equal(response.status, 400);
  const body = (await response.json()) as { reason: string };
  assert.equal(body.reason, 'invalid_scheduled_at');
  assert.equal(calls.length, 0);
});

test('PATCH schedule rejects malformed JSON body with 400', async () => {
  const { queryable, calls } = buildQueryable();
  const response = await handlePatchScheduleSocialContentPost(
    'job-006',
    '42',
    new Request('http://aries.example.test/api/social-content/jobs/job-006/posts/42/schedule', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    }),
    { tenantContextLoader: tenantLoader(7), queryable, publishApprovalResolver: approvedResolver },
  );
  assert.equal(response.status, 400);
  const body = (await response.json()) as { reason: string };
  assert.equal(body.reason, 'invalid_request_body');
  assert.equal(calls.length, 0);
});

test('PATCH schedule returns 404 when post does not belong to tenant', async () => {
  const { queryable, calls } = buildQueryable({ ownedTenantId: 7, ownedPostId: 42 });
  const response = await handlePatchScheduleSocialContentPost(
    'job-007',
    '42',
    new Request('http://aries.example.test/api/social-content/jobs/job-007/posts/42/schedule', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduled_at: '2026-05-14T09:00:00.000Z', platforms: ['instagram'] }),
    }),
    { tenantContextLoader: tenantLoader(11), queryable, publishApprovalResolver: approvedResolver },
  );
  assert.equal(response.status, 404);
  const body = (await response.json()) as { reason: string };
  assert.equal(body.reason, 'social_content_post_not_found');
  const insertCall = calls.find((call) => call.sql.startsWith('INSERT INTO scheduled_posts'));
  assert.equal(insertCall, undefined, 'must NOT write scheduled_posts on tenant mismatch');
});

test('PATCH schedule returns 404 when postId is not numeric', async () => {
  const { queryable, calls } = buildQueryable();
  const response = await handlePatchScheduleSocialContentPost(
    'job-008',
    'approval:abc',
    new Request('http://aries.example.test/api/social-content/jobs/job-008/posts/approval:abc/schedule', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduled_at: '2026-05-14T09:00:00.000Z', platforms: ['instagram'] }),
    }),
    { tenantContextLoader: tenantLoader(7), queryable, publishApprovalResolver: approvedResolver },
  );
  assert.equal(response.status, 404);
  const body = (await response.json()) as { reason: string };
  assert.equal(body.reason, 'social_content_post_not_found');
  assert.equal(calls.length, 0);
});

test('PATCH schedule rejects unauthenticated requests with 403', async () => {
  const { queryable, calls } = buildQueryable();
  const response = await handlePatchScheduleSocialContentPost(
    'job-009',
    '42',
    new Request('http://aries.example.test/api/social-content/jobs/job-009/posts/42/schedule', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduled_at: '2026-05-14T09:00:00.000Z', platforms: ['instagram'] }),
    }),
    {
      tenantContextLoader: async () => {
        throw new Error('Authentication required.');
      },
      queryable,
    },
  );
  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
});

test('PATCH schedule deduplicates and lowercases platform names', async () => {
  const { queryable, calls } = buildQueryable();
  const response = await handlePatchScheduleSocialContentPost(
    'job-010',
    '42',
    new Request('http://aries.example.test/api/social-content/jobs/job-010/posts/42/schedule', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scheduled_at: '2026-05-14T09:00:00.000Z',
        platforms: ['Instagram', 'instagram', 'FACEBOOK'],
      }),
    }),
    { tenantContextLoader: tenantLoader(7), queryable, publishApprovalResolver: approvedResolver },
  );
  assert.equal(response.status, 200);
  const insertCall = calls.find((call) => call.sql.startsWith('INSERT INTO scheduled_posts'));
  assert.deepEqual(insertCall?.params[3], ['instagram', 'facebook']);
});

// ---------------------------------------------------------------------------
// T15 (R) — RescheduleDrawer mounted with a tz-correct datetime-local input.
// The drawer previously read its datetime-local value in the BROWSER zone via
// `new Date(localValue)`. It now resolves the wall time in the tenant business
// zone via wallTimeToUtc / utcToWallTime. These tests pin that conversion —
// the same helpers the drawer submits and pre-fills with — so the bug
// (browser-zone interpretation) cannot regress.
// ---------------------------------------------------------------------------

test('RescheduleDrawer wall time converts via the tenant zone, not the browser zone', async () => {
  const { wallTimeToUtc } = await import('../lib/format-timestamp');
  // Operator types 2026-08-01 14:30 into the datetime-local input. With the
  // tenant business zone America/New_York (EDT, UTC-4) that is 18:30Z —
  // independent of whatever zone the operator's browser is in.
  const utc = wallTimeToUtc('2026-08-01T14:30', 'America/New_York');
  assert.ok(utc);
  assert.equal(utc.toISOString(), '2026-08-01T18:30:00.000Z');

  // A different tenant zone resolves the SAME wall input to a different
  // instant — proving the conversion is tenant-zone driven.
  const utcLondon = wallTimeToUtc('2026-08-01T14:30', 'Europe/London');
  assert.ok(utcLondon);
  assert.equal(utcLondon.toISOString(), '2026-08-01T13:30:00.000Z');
});

test('RescheduleDrawer pre-fills the datetime-local input in the tenant zone', async () => {
  const { utcToWallTime } = await import('../lib/format-timestamp');
  // A post stored at 2026-08-01T18:30:00Z must pre-fill as 14:30 (EDT), the
  // tenant wall time — not the browser-local rendering of that instant.
  assert.equal(utcToWallTime('2026-08-01T18:30:00.000Z', 'America/New_York'), '2026-08-01T14:30');
});

test('RescheduleDrawer tz round-trip is stable (wall -> UTC -> wall)', async () => {
  const { utcToWallTime, wallTimeToUtc } = await import('../lib/format-timestamp');
  const wall = '2026-11-15T09:00';
  const utc = wallTimeToUtc(wall, 'America/Chicago');
  assert.ok(utc);
  assert.equal(utcToWallTime(utc, 'America/Chicago'), wall);
});

test('RescheduleDrawer module is mountable (exports a default component)', async () => {
  const mod = await import('../frontend/aries-v1/reschedule-drawer');
  assert.equal(typeof mod.default, 'function');
});
