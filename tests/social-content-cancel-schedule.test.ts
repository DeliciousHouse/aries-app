import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleDeleteScheduleSocialContentPost,
} from '../app/api/social-content/jobs/[jobId]/posts/[postId]/schedule/route';
import {
  handleDeleteSocialContentPost,
} from '../app/api/social-content/jobs/[jobId]/posts/[postId]/route';

type Row = Record<string, unknown>;
type QueryResult = { rows: Row[]; rowCount: number | null };

function tenantLoader(tenantId: number) {
  return async () => ({
    userId: '1001',
    tenantId: String(tenantId),
    tenantSlug: `tenant-${tenantId}`,
    role: 'tenant_admin' as const,
  });
}

// ---- Helpers for DELETE /schedule ----

function buildScheduleQueryable(opts: {
  postExists?: boolean;
  scheduledDispatchStatus?: string | null;
  deleteRowCount?: number;
}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = async (sql: string, params: unknown[]): Promise<QueryResult> => {
    const trimmed = sql.trim();
    calls.push({ sql: trimmed, params });
    if (trimmed.startsWith('SELECT id, tenant_id FROM posts')) {
      if (!opts.postExists) return { rows: [], rowCount: 0 };
      const [postId, tenantId] = params as [number, number];
      return { rows: [{ id: postId, tenant_id: tenantId }], rowCount: 1 };
    }
    if (trimmed.startsWith('SELECT dispatch_status FROM scheduled_posts')) {
      if (opts.scheduledDispatchStatus === null || opts.scheduledDispatchStatus === undefined) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ dispatch_status: opts.scheduledDispatchStatus }], rowCount: 1 };
    }
    if (trimmed.startsWith('DELETE FROM scheduled_posts')) {
      const rowCount = opts.deleteRowCount ?? 1;
      return { rows: [], rowCount };
    }
    throw new Error(`Unexpected SQL: ${trimmed}`);
  };
  return { queryable: { query }, calls };
}

// ---- Helpers for DELETE /post ----

function buildPostQueryable(opts: {
  postExists?: boolean;
  scheduledDispatchStatus?: string | null;
}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = async (sql: string, params: unknown[]): Promise<QueryResult> => {
    const trimmed = sql.trim();
    calls.push({ sql: trimmed, params });
    if (trimmed.startsWith('SELECT id, tenant_id FROM posts')) {
      if (!opts.postExists) return { rows: [], rowCount: 0 };
      const [postId, tenantId] = params as [number, number];
      return { rows: [{ id: postId, tenant_id: tenantId }], rowCount: 1 };
    }
    if (trimmed.startsWith('SELECT dispatch_status FROM scheduled_posts')) {
      if (opts.scheduledDispatchStatus === null || opts.scheduledDispatchStatus === undefined) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ dispatch_status: opts.scheduledDispatchStatus }], rowCount: 1 };
    }
    if (trimmed.startsWith('DELETE FROM scheduled_posts')) {
      const hadRow = opts.scheduledDispatchStatus !== null && opts.scheduledDispatchStatus !== undefined;
      return { rows: [], rowCount: hadRow ? 1 : 0 };
    }
    if (trimmed.startsWith('DELETE FROM posts')) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${trimmed}`);
  };
  return { queryable: { query }, calls };
}

// ---- DELETE /schedule tests ----

test('DELETE schedule happy path: pending row, returns 200 + row gone', async () => {
  const { queryable, calls } = buildScheduleQueryable({ postExists: true, scheduledDispatchStatus: 'pending', deleteRowCount: 1 });
  const response = await handleDeleteScheduleSocialContentPost(
    'job-abc',
    '42',
    {
      tenantContextLoader: tenantLoader(15),
      queryable,
      publishApprovalResolver: async () => true,
    },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.jobId, 'job-abc');
  assert.equal(body.postId, '42');
  assert.ok(typeof body.deletedAt === 'string', 'deletedAt must be a string');
  const deleteCall = calls.find((c) => c.sql.startsWith('DELETE FROM scheduled_posts'));
  assert.ok(deleteCall, 'must issue DELETE FROM scheduled_posts');
});

test('DELETE schedule cross-tenant: returns 404', async () => {
  const { queryable } = buildScheduleQueryable({ postExists: false });
  const response = await handleDeleteScheduleSocialContentPost(
    'job-abc',
    '42',
    {
      tenantContextLoader: tenantLoader(15),
      queryable,
      publishApprovalResolver: async () => true,
    },
  );
  assert.equal(response.status, 404);
});

test('DELETE schedule in_flight: returns 409 with dispatch_in_flight', async () => {
  const { queryable } = buildScheduleQueryable({ postExists: true, scheduledDispatchStatus: 'in_flight' });
  const response = await handleDeleteScheduleSocialContentPost(
    'job-abc',
    '42',
    {
      tenantContextLoader: tenantLoader(15),
      queryable,
      publishApprovalResolver: async () => true,
    },
  );
  assert.equal(response.status, 409);
  const body = (await response.json()) as { reason: string };
  assert.equal(body.reason, 'dispatch_in_flight');
});

test('DELETE schedule no-publish-approval: returns 409 with publish_requires_approval', async () => {
  const { queryable } = buildScheduleQueryable({ postExists: true, scheduledDispatchStatus: 'pending' });
  const response = await handleDeleteScheduleSocialContentPost(
    'job-noapproval',
    '42',
    {
      tenantContextLoader: tenantLoader(15),
      queryable,
      publishApprovalResolver: async () => false,
    },
  );
  assert.equal(response.status, 409);
  const body = (await response.json()) as { reason: string };
  assert.equal(body.reason, 'publish_requires_approval');
});

// ---- DELETE /post tests ----

test('DELETE post cascade: both rows gone, returns 200 with scheduledPostDeleted true', async () => {
  const { queryable, calls } = buildPostQueryable({ postExists: true, scheduledDispatchStatus: 'pending' });
  const response = await handleDeleteSocialContentPost(
    'job-abc',
    '42',
    {
      tenantContextLoader: tenantLoader(15),
      queryable,
      publishApprovalResolver: async () => true,
    },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.scheduledPostDeleted, true);
  assert.equal(body.postDeleted, true);
  const schedDel = calls.find((c) => c.sql.startsWith('DELETE FROM scheduled_posts'));
  assert.ok(schedDel, 'must DELETE scheduled_posts row');
  const postDel = calls.find((c) => c.sql.startsWith('DELETE FROM posts'));
  assert.ok(postDel, 'must DELETE posts row');
});

test('DELETE post idempotent: already-gone post returns 404 not 500', async () => {
  const { queryable } = buildPostQueryable({ postExists: false });
  const response = await handleDeleteSocialContentPost(
    'job-abc',
    '99',
    {
      tenantContextLoader: tenantLoader(15),
      queryable,
      publishApprovalResolver: async () => true,
    },
  );
  assert.equal(response.status, 404);
  const body = (await response.json()) as { reason: string };
  assert.equal(body.reason, 'post_not_found');
});
