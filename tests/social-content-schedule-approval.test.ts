import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handlePatchScheduleSocialContentPost,
  type ScheduleRouteQueryable,
} from '../app/api/social-content/jobs/[jobId]/posts/[postId]/schedule/route';

type Captured = { sql: string; params: unknown[] };

function buildQueryable(): { queryable: ScheduleRouteQueryable; calls: Captured[] } {
  const calls: Captured[] = [];
  let nextScheduledId = 901;
  const query = (async (sql: string, params: unknown[]) => {
    const trimmed = sql.trim();
    calls.push({ sql: trimmed, params });
    if (trimmed.startsWith('SELECT id, tenant_id FROM posts')) {
      const [postId, tenantId] = params as [number, number];
      return { rows: [{ id: postId, tenant_id: tenantId }], rowCount: 1 };
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
            updated_at: '2026-05-20T12:00:00.000Z',
          },
        ],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected SQL in test fixture: ${trimmed}`);
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

test('PATCH schedule rejects a post with no approved publish approval (409)', async () => {
  const { queryable, calls } = buildQueryable();
  const response = await handlePatchScheduleSocialContentPost(
    'job-noapproval',
    '42',
    new Request('http://aries.example.test/api/social-content/jobs/job-noapproval/posts/42/schedule', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduled_at: '2026-05-21T09:00:00.000Z', platforms: ['instagram'] }),
    }),
    {
      tenantContextLoader: tenantLoader(7),
      queryable,
      publishApprovalResolver: async () => false,
    },
  );

  assert.equal(response.status, 409);
  const body = (await response.json()) as { reason: string };
  assert.equal(body.reason, 'publish_requires_approval');

  const insertCall = calls.find((call) => call.sql.startsWith('INSERT INTO scheduled_posts'));
  assert.equal(insertCall, undefined, 'must NOT write scheduled_posts without an approval');
});

test('PATCH schedule allows a post with an approved publish approval (200 + row written)', async () => {
  const { queryable, calls } = buildQueryable();
  const resolverCalls: Array<{ jobId: string; tenantId: string }> = [];
  const response = await handlePatchScheduleSocialContentPost(
    'job-approved',
    '42',
    new Request('http://aries.example.test/api/social-content/jobs/job-approved/posts/42/schedule', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduled_at: '2026-05-21T09:00:00.000Z', platforms: ['instagram'] }),
    }),
    {
      tenantContextLoader: tenantLoader(7),
      queryable,
      publishApprovalResolver: async (input) => {
        resolverCalls.push(input);
        return true;
      },
    },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.jobId, 'job-approved');

  const insertCall = calls.find((call) => call.sql.startsWith('INSERT INTO scheduled_posts'));
  assert.ok(insertCall, 'INSERT INTO scheduled_posts must run once approved');

  assert.deepEqual(resolverCalls, [{ jobId: 'job-approved', tenantId: '7' }]);
});
