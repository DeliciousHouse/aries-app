import assert from 'node:assert/strict';
import test from 'node:test';

import {
  backfillInsightsAttribution,
  parseBackfillArgs,
  type BackfillQueryable,
} from '../scripts/backfill-insights-attribution';

type InsightRow = {
  id: number;
  tenantId: number;
  platform: string;
  externalPostId: string;
  ariesPostId: number | null;
};

type PostRow = {
  id: number;
  tenantId: number;
  platform: string | null;
  platformPostId: string;
  publishedStatus: string;
  publishedAt: string;
};

type ScheduledPostRow = {
  id: number;
  tenantId: number;
  postId: number;
};

type DispatchRow = {
  scheduledPostId: number;
  platform: string;
  platformPostId: string;
  status: string;
  dispatchedAt: string;
};

function normalizePlatform(platform: string | null): string | null {
  if (platform === null) return null;
  const normalized = platform.trim().toLowerCase();
  return normalized === 'meta' ? 'facebook' : normalized;
}

function buildFakeDb(state: {
  insights: InsightRow[];
  posts: PostRow[];
  scheduledPosts: ScheduledPostRow[];
  dispatches: DispatchRow[];
}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db: BackfillQueryable = {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      const normalizedSql = sql.replace(/\s+/g, ' ').trim();

      if (normalizedSql.startsWith('SELECT ip.id AS insights_post_id')) {
        const [cursor, batchSize, tenantFilter] = params as [number, number, number | null];
        const hasScheduledSource = /scheduled_post_dispatches/i.test(sql);
        const scheduledTenantScoped = /sp\.tenant_id\s*=\s*ip\.tenant_id/i.test(sql);
        const scheduledSourceTenantScoped = /JOIN\s+posts\s+scheduled_source[\s\S]*scheduled_source\.tenant_id\s*=\s*sp\.tenant_id/i.test(sql);
        const scheduledPlatformScoped = /lower\(d\.platform\)[\s\S]*lower\(ip\.platform\)/i.test(sql);
        const scheduledExternalIdScoped = /d\.platform_post_id\s*=\s*ip\.external_post_id/i.test(sql);
        const scheduledStatusScoped = /d\.status\s*=\s*'dispatched'/i.test(sql);

        const rows = state.insights
          .filter((insight) => insight.id > cursor && insight.ariesPostId === null)
          .filter((insight) => tenantFilter === null || insight.tenantId === tenantFilter)
          .sort((left, right) => left.id - right.id)
          .flatMap((insight) => {
            const candidates = state.posts
              .filter((post) => post.tenantId === insight.tenantId)
              .filter((post) => post.platformPostId === insight.externalPostId)
              .filter((post) => ['published', 'unverified'].includes(post.publishedStatus))
              .filter((post) => normalizePlatform(post.platform) === normalizePlatform(insight.platform))
              .map((post) => ({
                id: post.id,
                sourcePriority: 2,
                eventAt: post.publishedAt,
              }));

            if (hasScheduledSource) {
              for (const dispatch of state.dispatches) {
                const parent = state.scheduledPosts.find((row) => row.id === dispatch.scheduledPostId);
                if (!parent) continue;
                const sourcePost = state.posts.find((post) => post.id === parent.postId);
                if (scheduledSourceTenantScoped && sourcePost?.tenantId !== parent.tenantId) continue;
                if (scheduledTenantScoped && parent.tenantId !== insight.tenantId) continue;
                if (scheduledPlatformScoped && normalizePlatform(dispatch.platform) !== normalizePlatform(insight.platform)) continue;
                if (scheduledExternalIdScoped && dispatch.platformPostId !== insight.externalPostId) continue;
                if (scheduledStatusScoped && dispatch.status !== 'dispatched') continue;
                candidates.push({ id: parent.postId, sourcePriority: 1, eventAt: dispatch.dispatchedAt });
              }
            }

            candidates.sort((left, right) => {
              if (left.sourcePriority !== right.sourcePriority) {
                return left.sourcePriority - right.sourcePriority;
              }
              const byDate = right.eventAt.localeCompare(left.eventAt);
              return byDate || right.id - left.id;
            });
            const candidate = candidates[0];
            return candidate ? [{
              insights_post_id: insight.id,
              tenant_id: insight.tenantId,
              aries_post_id: candidate.id,
            }] : [];
          })
          .slice(0, batchSize);
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }

      if (normalizedSql.startsWith('UPDATE insights_posts')) {
        const [ariesPostId, insightsPostId, tenantId] = params as [number, number, number];
        const insight = state.insights.find((row) => row.id === insightsPostId && row.tenantId === tenantId);
        if (!insight || insight.ariesPostId !== null) return { rows: [] as T[], rowCount: 0 };
        insight.ariesPostId = ariesPostId;
        return { rows: [{ id: insightsPostId }] as unknown as T[], rowCount: 1 };
      }

      throw new Error(`unexpected query: ${normalizedSql}`);
    },
  };
  return { db, calls };
}

function fixtures() {
  return {
    insights: [
      { id: 1, tenantId: 15, platform: 'facebook', externalPostId: 'fb_first_101', ariesPostId: null },
      { id: 2, tenantId: 15, platform: 'instagram', externalPostId: 'ig_second_101', ariesPostId: null },
      { id: 3, tenantId: 16, platform: 'facebook', externalPostId: 'fb_103', ariesPostId: null },
      { id: 4, tenantId: 15, platform: 'facebook', externalPostId: 'external_only', ariesPostId: null },
      { id: 5, tenantId: 15, platform: 'instagram', externalPostId: 'already_linked', ariesPostId: 777 },
    ] satisfies InsightRow[],
    posts: [
      // Only the first cross-post id is mirrored to the aggregate posts row.
      { id: 101, tenantId: 15, platform: 'meta', platformPostId: 'fb_first_101', publishedStatus: 'published', publishedAt: '2026-07-18T00:00:00Z' },
      { id: 103, tenantId: 16, platform: 'facebook', platformPostId: 'fb_103', publishedStatus: 'published', publishedAt: '2026-07-18T00:00:00Z' },
      { id: 104, tenantId: 15, platform: 'facebook', platformPostId: 'other', publishedStatus: 'published', publishedAt: '2026-07-18T00:00:00Z' },
      // Even a newer direct collision must not outrank the durable scheduled child.
      { id: 105, tenantId: 15, platform: 'instagram', platformPostId: 'ig_second_101', publishedStatus: 'published', publishedAt: '2026-07-22T00:00:00Z' },
    ] satisfies PostRow[],
    scheduledPosts: [
      { id: 71, tenantId: 15, postId: 101 },
      { id: 72, tenantId: 16, postId: 103 },
      { id: 73, tenantId: 15, postId: 104 },
      // Cross-tenant parent/source mismatch: schema lacks a composite FK, so
      // lookup SQL must independently prove the source post belongs to tenant 15.
      { id: 74, tenantId: 15, postId: 103 },
    ] satisfies ScheduledPostRow[],
    dispatches: [
      // Later decoys ensure the lookup really is tenant- and platform-scoped.
      { scheduledPostId: 74, platform: 'instagram', platformPostId: 'ig_second_101', status: 'dispatched', dispatchedAt: '2026-07-23T00:00:00Z' },
      { scheduledPostId: 72, platform: 'instagram', platformPostId: 'ig_second_101', status: 'dispatched', dispatchedAt: '2026-07-21T00:00:00Z' },
      { scheduledPostId: 73, platform: 'facebook', platformPostId: 'ig_second_101', status: 'dispatched', dispatchedAt: '2026-07-20T00:00:00Z' },
      { scheduledPostId: 71, platform: 'facebook', platformPostId: 'fb_first_101', status: 'dispatched', dispatchedAt: '2026-07-18T00:00:00Z' },
      { scheduledPostId: 71, platform: 'instagram', platformPostId: 'ig_second_101', status: 'dispatched', dispatchedAt: '2026-07-19T00:00:00Z' },
    ] satisfies DispatchRow[],
  };
}

const silent = () => {};

test('dry-run recovers the non-first scheduled platform id without writing', async () => {
  const state = fixtures();
  const { db, calls } = buildFakeDb(state);

  const result = await backfillInsightsAttribution(db, {
    tenantId: null,
    log: silent,
    batchSize: 2,
  });

  assert.deepEqual(result, { mode: 'dry-run', candidates: 3, updated: 0, batches: 2 });
  assert.equal(calls.filter((call) => /UPDATE insights_posts/i.test(call.sql)).length, 0);
  assert.deepEqual(state.insights.map((row) => row.ariesPostId), [null, null, null, null, 777]);
  const candidateSql = calls.find((call) => /FROM insights_posts ip/i.test(call.sql))?.sql ?? '';
  assert.match(
    candidateSql,
    /lower\(p\.platform\)[\s\S]*lower\(ip\.platform\)/i,
    'direct legacy candidates must remain tenant + platform scoped',
  );
  assert.doesNotMatch(candidateSql, /p\.platform\s+IS\s+NULL/i);
});

test('write mode attributes direct and scheduled candidates and is idempotent', async () => {
  const state = fixtures();
  const { db, calls } = buildFakeDb(state);

  const first = await backfillInsightsAttribution(db, {
    tenantId: null,
    write: true,
    log: silent,
    batchSize: 2,
  });
  const second = await backfillInsightsAttribution(db, {
    tenantId: null,
    write: true,
    log: silent,
    batchSize: 2,
  });

  assert.deepEqual(first, { mode: 'write', candidates: 3, updated: 3, batches: 2 });
  assert.deepEqual(state.insights.map((row) => row.ariesPostId), [101, 101, 103, null, 777]);
  assert.deepEqual(second, { mode: 'write', candidates: 0, updated: 0, batches: 0 });
  assert.ok(
    calls.filter((call) => /UPDATE insights_posts/i.test(call.sql)).every((call) => /aries_post_id\s+IS\s+NULL/i.test(call.sql)),
  );
});

test('tenant scope limits scheduled recovery and writes', async () => {
  const state = fixtures();
  const { db } = buildFakeDb(state);

  const result = await backfillInsightsAttribution(db, {
    tenantId: 15,
    write: true,
    log: silent,
  });

  assert.equal(result.candidates, 2);
  assert.equal(result.updated, 2);
  assert.deepEqual(state.insights.map((row) => row.ariesPostId), [101, 101, null, null, 777]);
});

test('CLI defaults an explicit scope to dry-run and requires scope plus --write for mutations', () => {
  assert.deepEqual(parseBackfillArgs(['--tenant', '15']), {
    write: false,
    tenantId: 15,
    batchSize: 500,
  });
  assert.deepEqual(parseBackfillArgs(['--all', '--dry-run', '--batch-size', '25']), {
    write: false,
    tenantId: null,
    batchSize: 25,
  });
  assert.deepEqual(parseBackfillArgs(['--tenant', '15', '--write']), {
    write: true,
    tenantId: 15,
    batchSize: 500,
  });
  assert.deepEqual(parseBackfillArgs(['--all', '--write']), {
    write: true,
    tenantId: null,
    batchSize: 500,
  });
  assert.throws(() => parseBackfillArgs([]), /explicit scope/i);
  assert.throws(() => parseBackfillArgs(['--write']), /explicit scope/i);
  assert.throws(() => parseBackfillArgs(['--write', '--dry-run', '--all']), /mutually exclusive/i);
  assert.throws(() => parseBackfillArgs(['--tenant', '15', '--all']), /mutually exclusive/i);
  assert.throws(() => parseBackfillArgs(['--tenant', 'nope']), /positive integer/i);
});
