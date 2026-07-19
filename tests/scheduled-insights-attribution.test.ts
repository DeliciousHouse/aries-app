import assert from 'node:assert/strict';
import test from 'node:test';

import type { InsightsAdapter } from '@/backend/insights/adapters/_adapter.types';
import { syncAccountForTenant } from '@/backend/insights/sync/dispatcher';

type SourcePost = {
  id: number;
  tenantId: number;
  platform: string | null;
  platformPostId: string | null;
  publishedStatus: 'published' | 'unverified';
};

type ScheduledPost = {
  id: number;
  tenantId: number;
  postId: number;
};

type ScheduledDispatch = {
  id: number;
  scheduledPostId: number;
  platform: string;
  platformPostId: string;
  status: 'dispatched';
};

type InsightPost = {
  tenantId: number;
  platform: string;
  externalPostId: string;
  ariesPostId: number | null;
};

type AttributionState = {
  sourcePosts: SourcePost[];
  scheduledPosts: ScheduledPost[];
  dispatches: ScheduledDispatch[];
  insights: InsightPost[];
};

function normalizePlatform(platform: string | null): string | null {
  if (platform === null) return null;
  const normalized = platform.trim().toLowerCase();
  return normalized === 'meta' ? 'facebook' : normalized;
}

function attributionPool(state: AttributionState) {
  const client = {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      if (/FROM insights_accounts\s+WHERE id/i.test(text)) {
        return {
          rows: [{ id: 7, platform: 'instagram', external_account_id: 'IG_ACCOUNT' }] as unknown as T[],
          rowCount: 1,
        };
      }
      if (/FROM connected_accounts/i.test(text)) {
        return { rows: [] as T[], rowCount: 0 };
      }
      if (/INSERT INTO insights_sync_runs/i.test(text)) {
        return { rows: [{ id: 99 }] as unknown as T[], rowCount: 1 };
      }
      if (/INSERT INTO insights_posts/i.test(text)) {
        const [tenantId, , platform, externalPostId] = params as [number, number, string, string];
        const scheduledLookupOffset = text.indexOf('scheduled_post_dispatches');
        const legacyLookupOffset = text.indexOf('FROM posts p');
        const scheduledTenantScoped = /sp\.tenant_id\s*=\s*\$1/i.test(text);
        const scheduledPlatformScoped = /lower\(d\.platform\)[\s\S]*lower\(\$3::text\)/i.test(text);
        const scheduledExternalIdScoped = /d\.platform_post_id\s*=\s*\$4/i.test(text);
        const scheduledStatusScoped = /d\.status\s*=\s*'dispatched'/i.test(text);
        const legacyTenantScoped = /p\.tenant_id\s*=\s*\$1/i.test(text);
        const legacyPlatformScoped = /lower\(p\.platform\)[\s\S]*lower\(\$3::text\)/i.test(text);
        const legacyExternalIdScoped = /p\.platform_post_id\s*=\s*\$4/i.test(text);

        const scheduled = scheduledLookupOffset >= 0
          ? state.dispatches.find((dispatch) => {
              const parent = state.scheduledPosts.find(
                (scheduledPost) => scheduledPost.id === dispatch.scheduledPostId,
              );
              if (!parent) return false;
              if (scheduledStatusScoped && dispatch.status !== 'dispatched') return false;
              if (scheduledTenantScoped && parent.tenantId !== tenantId) return false;
              if (scheduledPlatformScoped && normalizePlatform(dispatch.platform) !== normalizePlatform(platform)) return false;
              if (scheduledExternalIdScoped && dispatch.platformPostId !== externalPostId) return false;
              return true;
            })
          : undefined;
        const scheduledParent = scheduled
          ? state.scheduledPosts.find((row) => row.id === scheduled.scheduledPostId)
          : undefined;

        const legacy = legacyLookupOffset >= 0
          ? state.sourcePosts.find((post) => {
              if (legacyTenantScoped && post.tenantId !== tenantId) return false;
              if (legacyPlatformScoped && normalizePlatform(post.platform) !== normalizePlatform(platform)) return false;
              if (legacyExternalIdScoped && post.platformPostId !== externalPostId) return false;
              return ['published', 'unverified'].includes(post.publishedStatus);
            })
          : undefined;

        const scheduledFirst = scheduledLookupOffset >= 0
          && (legacyLookupOffset < 0 || scheduledLookupOffset < legacyLookupOffset);
        const resolvedAriesPostId = scheduledFirst
          ? scheduledParent?.postId ?? legacy?.id ?? null
          : legacy?.id ?? scheduledParent?.postId ?? null;
        const existing = state.insights.find(
          (row) =>
            row.tenantId === tenantId
            && row.platform === platform
            && row.externalPostId === externalPostId,
        );
        if (existing) {
          if (/aries_post_id\s*=\s*COALESCE\(\s*insights_posts\.aries_post_id\s*,/i.test(text)) {
            existing.ariesPostId ??= resolvedAriesPostId;
          }
        } else {
          state.insights.push({
            tenantId,
            platform,
            externalPostId,
            ariesPostId: /content_type,\s*aries_post_id\s*\)/i.test(text)
              ? resolvedAriesPostId
              : null,
          });
        }
        return { rows: [] as T[], rowCount: 1 };
      }
      if (/SELECT id, external_post_id\s+FROM insights_posts/i.test(text)) {
        return { rows: [] as T[], rowCount: 0 };
      }
      return { rows: [] as T[], rowCount: 0 };
    },
    release() {},
  };

  return { async connect() { return client; } };
}

function instagramAdapter(externalPostId: string): InsightsAdapter {
  return {
    platform: 'instagram',
    fetchPostList: async () => [
      {
        externalPostId,
        publishedAt: new Date('2026-07-19T12:00:00Z'),
        mediaType: 'image',
        title: null,
        caption: 'Later-discovered Instagram analytics row',
        permalink: `https://instagram.example/p/${externalPostId}`,
        durationSeconds: null,
        thumbnailUrl: null,
      },
    ],
    fetchAccountMetrics: async () => [],
    fetchPostMetrics: async () => [],
    fetchComments: async () => [],
  };
}

function scheduledCrossPostState(): AttributionState {
  return {
    sourcePosts: [
      // The aggregate posts row mirrors only the first successful Facebook id.
      { id: 905, tenantId: 42, platform: 'meta', platformPostId: 'fb_first_905', publishedStatus: 'published' },
      // These same-id decoys prove tenant/platform scoping on the legacy path.
      { id: 906, tenantId: 43, platform: 'instagram', platformPostId: 'ig_second_905', publishedStatus: 'published' },
      { id: 907, tenantId: 42, platform: 'facebook', platformPostId: 'ig_second_905', publishedStatus: 'published' },
      // A valid direct collision must still lose to the durable scheduled child.
      { id: 908, tenantId: 42, platform: 'instagram', platformPostId: 'ig_second_905', publishedStatus: 'published' },
    ],
    scheduledPosts: [
      { id: 72, tenantId: 43, postId: 906 },
      { id: 73, tenantId: 42, postId: 907 },
      { id: 71, tenantId: 42, postId: 905 },
    ],
    dispatches: [
      // Same external id in the wrong tenant and on the wrong platform must
      // never win attribution. They come first so an unscoped lookup fails.
      { id: 1, scheduledPostId: 72, platform: 'instagram', platformPostId: 'ig_second_905', status: 'dispatched' },
      { id: 2, scheduledPostId: 73, platform: 'facebook', platformPostId: 'ig_second_905', status: 'dispatched' },
      { id: 3, scheduledPostId: 71, platform: 'facebook', platformPostId: 'fb_first_905', status: 'dispatched' },
      { id: 4, scheduledPostId: 71, platform: 'instagram', platformPostId: 'ig_second_905', status: 'dispatched' },
    ],
    insights: [],
  };
}

test('later Instagram sync attributes a scheduled cross-post from its durable child mapping', async () => {
  const state = scheduledCrossPostState();

  const result = await syncAccountForTenant(42, 7, 'interval', {
    pool: attributionPool(state),
    resolveAdapter: () => instagramAdapter('ig_second_905'),
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.postsSeen, 1);
  assert.equal(state.sourcePosts[0].platformPostId, 'fb_first_905');
  assert.deepEqual(state.insights, [
    {
      tenantId: 42,
      platform: 'instagram',
      externalPostId: 'ig_second_905',
      ariesPostId: 905,
    },
  ]);
});

test('later sync preserves the legacy posts.platform_post_id attribution fallback', async () => {
  const state: AttributionState = {
    sourcePosts: [
      { id: 910, tenantId: 43, platform: 'instagram', platformPostId: 'ig_legacy_909', publishedStatus: 'published' },
      { id: 911, tenantId: 42, platform: 'facebook', platformPostId: 'ig_legacy_909', publishedStatus: 'published' },
      { id: 909, tenantId: 42, platform: 'instagram', platformPostId: 'ig_legacy_909', publishedStatus: 'unverified' },
    ],
    scheduledPosts: [],
    dispatches: [],
    insights: [],
  };

  const result = await syncAccountForTenant(42, 7, 'interval', {
    pool: attributionPool(state),
    resolveAdapter: () => instagramAdapter('ig_legacy_909'),
  });

  assert.equal(result.status, 'ok');
  assert.equal(state.insights[0].ariesPostId, 909);
});

test('later sync never overwrites an existing Aries attribution', async () => {
  const state = scheduledCrossPostState();
  state.insights.push({
    tenantId: 42,
    platform: 'instagram',
    externalPostId: 'ig_second_905',
    ariesPostId: 777,
  });

  const result = await syncAccountForTenant(42, 7, 'interval', {
    pool: attributionPool(state),
    resolveAdapter: () => instagramAdapter('ig_second_905'),
  });

  assert.equal(result.status, 'ok');
  assert.equal(state.insights[0].ariesPostId, 777);
});
