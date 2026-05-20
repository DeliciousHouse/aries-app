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
