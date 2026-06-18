/**
 * tests/insights-linkedin-adapter.test.ts
 *
 * Regression coverage for the LinkedIn insights adapter (#647 analytics;
 * #648 documented comments limitation). All tests are self-contained — fake
 * gateway / fake DB / no real Postgres, no network calls.
 *
 * Mirror pattern: tests/insights-x-adapter.test.ts /
 * tests/insights-youtube-adapter.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LinkedInInsightsAdapter } from '@/backend/insights/adapters/linkedin/index';
import {
  hasAdapter,
  getAdapter,
  isLinkedInInsightsEnabled,
  isComposioOnlyAnalyticsPlatform,
} from '@/backend/insights/sync/adapter-factory';
import { platformSupports } from '@/backend/insights/platforms/capabilities';
import type {
  ComposioGateway,
  GatewayToolResult,
} from '@/backend/integrations/composio/composio-client';
import type { Queryable } from '@/backend/integrations/composio/connection-store';
import { fakeConfig } from './composio/helpers';

// ── Test doubles ──────────────────────────────────────────────────────────────

interface RecordedCall {
  slug: string;
  connectedAccountId?: string;
  arguments?: Record<string, unknown>;
}

/** Gateway that routes a canned result per action slug and records every call. */
function routingGateway(
  results: Record<string, GatewayToolResult>,
): ComposioGateway & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async findOrCreateManagedAuthConfig(s: string) { return `ac_${s}`; },
    async initiateConnection() { return { connectionRequestId: 'cr', redirectUrl: null }; },
    async listConnections() { return []; },
    async getConnection() { return null; },
    async deleteConnection() {},
    async executeTool(slug, options) {
      calls.push({
        slug,
        connectedAccountId: options.connectedAccountId,
        arguments: options.arguments,
      });
      // Default: empty LinkedIn reactions collection.
      return results[slug] ?? { data: { elements: [], paging: { total: 0 } }, successful: true, error: null };
    },
    async uploadFile(input) {
      return { name: 'staged', mimetype: 'application/octet-stream', s3key: `s3/${input.toolSlug}` };
    },
  };
}

interface LinkedInPostRow {
  platform_post_id: string;
  published_at: Date | null;
  caption: string | null;
}

interface RecordedDbQuery {
  text: string;
  params: unknown[];
}

/**
 * Fake Queryable whose SELECT on the `posts` table returns the supplied rows.
 * All other statements return empty (no real Postgres needed).
 */
function fakePostsDb(
  rows: LinkedInPostRow[],
): Queryable & { queries: RecordedDbQuery[] } {
  const queries: RecordedDbQuery[] = [];
  return {
    queries,
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      queries.push({ text, params });
      if (/^\s*select/i.test(text) && /FROM\s+posts/i.test(text)) {
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }
      return { rows: [] as T[], rowCount: 0 };
    },
  };
}

/** Standard adapter context shared across non-dormancy tests. */
const ctx = { connectedAccountId: 'ca_li_1', tenantId: 42 };

// ── fetchPostList ─────────────────────────────────────────────────────────────

test('fetchPostList: queries tenant LinkedIn posts from DB, issues ZERO gateway calls, returns RawPost with URN preserved as externalPostId and correct permalink', async () => {
  const db = fakePostsDb([
    {
      platform_post_id: 'urn:li:share:7181111111111111111',
      published_at: new Date('2026-06-10'),
      caption: 'Our latest campaign',
    },
    {
      platform_post_id: 'urn:li:ugcPost:7182222222222222222',
      published_at: new Date('2026-06-11'),
      caption: null,
    },
  ]);
  const gateway = routingGateway({});
  const adapter = new LinkedInInsightsAdapter(gateway, fakeConfig({ actions: {} }), db, ctx);

  const posts = await adapter.fetchPostList('li_person_1');

  // LinkedIn has no Composio list-posts action — zero gateway calls.
  assert.equal(gateway.calls.length, 0, 'ZERO gateway calls — DB is the post universe');

  // DB SELECT must be tenant-scoped and platform+status-filtered.
  const dbQuery = db.queries[0];
  assert.match(dbQuery.text, /FROM\s+posts/i);
  assert.match(dbQuery.text, /platform\s*=\s*'linkedin'/i);
  assert.match(dbQuery.text, /published_status\s*=\s*'published'/i);
  assert.match(dbQuery.text, /platform_post_id IS NOT NULL/i);
  assert.deepEqual(dbQuery.params, [42]); // tenant_id=$1

  assert.equal(posts.length, 2);

  // URN is preserved VERBATIM as externalPostId (no prefix stripping/adding).
  assert.equal(posts[0].externalPostId, 'urn:li:share:7181111111111111111');
  assert.equal(posts[0].caption, 'Our latest campaign');
  assert.equal(posts[0].mediaType, 'image', 'LinkedIn feed posts normalised to image');
  assert.equal(
    posts[0].permalink,
    'https://www.linkedin.com/feed/update/urn:li:share:7181111111111111111',
    'permalink embeds the full URN',
  );

  assert.equal(posts[1].externalPostId, 'urn:li:ugcPost:7182222222222222222');
  assert.equal(posts[1].caption, null);
  assert.equal(
    posts[1].permalink,
    'https://www.linkedin.com/feed/update/urn:li:ugcPost:7182222222222222222',
  );
});

test('fetchPostList: returns [] when tenant has no published LinkedIn posts (no gateway calls)', async () => {
  const db = fakePostsDb([]);
  const gateway = routingGateway({});
  const adapter = new LinkedInInsightsAdapter(gateway, fakeConfig({ actions: {} }), db, ctx);

  const posts = await adapter.fetchPostList('li_person_1');

  assert.deepEqual(posts, []);
  assert.equal(gateway.calls.length, 0, 'no gateway calls even when DB is empty');
  assert.equal(db.queries.length, 1, 'one SELECT issued');
});

// ── fetchPostMetrics (#647 analytics) ────────────────────────────────────────

test('fetchPostMetrics (#647): LINKEDIN_LIST_REACTIONS call carries entity=post URN VERBATIM (no prefix); paging.total → likes; rawSource correctly documents analytics scope and limitations', async () => {
  const urn = 'urn:li:share:7181111111111111111';
  const gateway = routingGateway({
    LINKEDIN_LIST_REACTIONS: {
      successful: true,
      error: null,
      data: {
        elements: [
          { reactionType: 'LIKE' },
          { reactionType: 'EMPATHY' },
          { reactionType: 'PRAISE' },
        ],
        paging: { total: 42, count: 3, start: 0 },
      },
    },
  });
  const adapter = new LinkedInInsightsAdapter(
    gateway,
    fakeConfig({ actions: {} }),
    fakePostsDb([]),
    ctx,
  );

  const metrics = await adapter.fetchPostMetrics(urn);

  // One LINKEDIN_LIST_REACTIONS call with entity=URN VERBATIM (no prefix added).
  assert.equal(gateway.calls.length, 1, 'exactly one LINKEDIN_LIST_REACTIONS call');
  const call = gateway.calls[0];
  assert.equal(call.slug, 'LINKEDIN_LIST_REACTIONS');
  assert.equal(call.connectedAccountId, 'ca_li_1');
  assert.equal(
    call.arguments?.entity,
    urn,
    'entity is the URN VERBATIM — no urn:li: prefix added',
  );
  assert.equal(call.arguments?.count, 100, 'requests a page of 100 to detect the floor');

  // paging.total wins (authoritative count, even when elements.length < count).
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].likes, 42, 'paging.total → likes');

  // Personal reactions expose no impressions — 0 is an explicit placeholder, not a fetched value.
  assert.equal(metrics[0].views, 0, 'views=0 placeholder (no impressions for personal accounts)');
  assert.equal(metrics[0].commentsCount, 0, 'commentsCount=0 placeholder (no comment count for personal accounts)');
  assert.equal(metrics[0].shares, 0, 'shares=0 placeholder (no share count for personal accounts)');

  // rawSource documents the analytics scope honestly so consumers can distinguish
  // "genuinely zero" from "metric unavailable".
  const rs = metrics[0].rawSource;
  assert.equal(rs.analytics_scope, 'personal_reactions_only', 'rawSource.analytics_scope must be personal_reactions_only');
  assert.equal(rs.org_stats_unavailable_reason, 'requires_org_admin', 'rawSource.org_stats_unavailable_reason must be requires_org_admin');
  assert.equal(rs.impressions_available, false, 'rawSource.impressions_available must be false');
  assert.equal(rs.reaction_count, 42);
  assert.equal(rs.reaction_count_source, 'paging_total', 'paging.total path → source=paging_total');
  assert.equal(rs.reaction_count_is_floor, false, 'paging.total is the exact count — not a floor');
});

test('fetchPostMetrics: paging.total absent + full page (elements.length=100) → reaction_count_is_floor=true', async () => {
  const urn = 'urn:li:ugcPost:7182222222222222222';
  // Saturated page — exactly 100 elements, no paging.total.
  const elements = Array.from({ length: 100 }, (_, i) => ({ reactionType: i % 2 === 0 ? 'LIKE' : 'EMPATHY' }));
  const gateway = routingGateway({
    LINKEDIN_LIST_REACTIONS: {
      successful: true,
      error: null,
      data: {
        elements,
        paging: { count: 100, start: 0 }, // total intentionally absent
      },
    },
  });
  const adapter = new LinkedInInsightsAdapter(
    gateway,
    fakeConfig({ actions: {} }),
    fakePostsDb([]),
    ctx,
  );

  const metrics = await adapter.fetchPostMetrics(urn);

  assert.equal(metrics.length, 1, 'a row is emitted even when paging.total is absent');
  assert.equal(metrics[0].likes, 100, 'falls back to elements.length');
  assert.equal(
    metrics[0].rawSource.reaction_count_source,
    'elements_length',
    'source is elements_length when paging.total is absent',
  );
  assert.equal(
    metrics[0].rawSource.reaction_count_is_floor,
    true,
    'length=100 saturates the page → is_floor must be true',
  );
});

test('fetchPostMetrics: paging.total absent + partial page (elements.length < 100) → is_floor=false (exact count)', async () => {
  const urn = 'urn:li:share:7183333333333333333';
  const gateway = routingGateway({
    LINKEDIN_LIST_REACTIONS: {
      successful: true,
      error: null,
      data: {
        elements: [{ reactionType: 'LIKE' }, { reactionType: 'PRAISE' }],
        paging: { count: 100, start: 0 },
      },
    },
  });
  const adapter = new LinkedInInsightsAdapter(
    gateway,
    fakeConfig({ actions: {} }),
    fakePostsDb([]),
    ctx,
  );

  const metrics = await adapter.fetchPostMetrics(urn);

  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].likes, 2);
  assert.equal(metrics[0].rawSource.reaction_count_is_floor, false, 'partial page is exact, not a floor');
});

test('fetchPostMetrics: unparseable / completely absent elements and paging → [] (no fabricated zero row)', async () => {
  const gateway = routingGateway({
    LINKEDIN_LIST_REACTIONS: {
      successful: true,
      error: null,
      data: {
        // neither elements nor paging.total present → count is null → no row emitted.
        someOtherField: 'garbage',
      },
    },
  });
  const adapter = new LinkedInInsightsAdapter(
    gateway,
    fakeConfig({ actions: {} }),
    fakePostsDb([]),
    ctx,
  );

  const metrics = await adapter.fetchPostMetrics('urn:li:share:9999');

  assert.deepEqual(metrics, [], 'no usable count → empty, never a fabricated zero row');
});

test('fetchPostMetrics: real zero reactions (paging.total=0) emits a row with likes=0 (a measured 0 is real signal)', async () => {
  const urn = 'urn:li:share:7184444444444444444';
  const gateway = routingGateway({
    LINKEDIN_LIST_REACTIONS: {
      successful: true,
      error: null,
      data: {
        elements: [],
        paging: { total: 0, count: 100, start: 0 },
      },
    },
  });
  const adapter = new LinkedInInsightsAdapter(
    gateway,
    fakeConfig({ actions: {} }),
    fakePostsDb([]),
    ctx,
  );

  const metrics = await adapter.fetchPostMetrics(urn);

  // A measured 0 is a real signal and IS emitted (mirrors FB/X convention).
  assert.equal(metrics.length, 1, 'measured zero emits a row');
  assert.equal(metrics[0].likes, 0, 'likes=0 — the real reaction count');
  assert.equal(metrics[0].rawSource.reaction_count, 0);
  assert.equal(metrics[0].rawSource.reaction_count_is_floor, false);
});

// ── #648 honesty — fetchComments ──────────────────────────────────────────────

test('#648: fetchComments always returns [], issues ZERO gateway calls, never throws — documented platform limitation', async () => {
  const gateway = routingGateway({});
  const adapter = new LinkedInInsightsAdapter(
    gateway,
    fakeConfig({ actions: {} }),
    fakePostsDb([]),
    ctx,
  );

  let result: unknown[] | undefined;
  let threw = false;
  try {
    result = await adapter.fetchComments('urn:li:share:7181111111111111111', 100);
  } catch {
    threw = true;
  }

  assert.equal(threw, false, 'fetchComments must never throw (sync run stays ok)');
  assert.deepEqual(result, [], 'fetchComments always returns the honest empty array');
  assert.equal(gateway.calls.length, 0, 'ZERO gateway calls — LinkedIn has no list-comments action');
});

// ── fetchAccountMetrics ───────────────────────────────────────────────────────

test('fetchAccountMetrics: always returns [] — org-level share stats require org-admin scope not available for personal accounts', async () => {
  const gateway = routingGateway({});
  const adapter = new LinkedInInsightsAdapter(
    gateway,
    fakeConfig({ actions: {} }),
    fakePostsDb([]),
    ctx,
  );

  const result = await adapter.fetchAccountMetrics('li_person_1', { from: '2026-06-01', to: '2026-06-18' });

  assert.deepEqual(result, []);
  assert.equal(gateway.calls.length, 0, 'no gateway calls — never fabricate an account series');
});

// ── Capabilities (#648 documented limitation) ─────────────────────────────────

test('capabilities: platformSupports("linkedin","comments") is false — documented #648 limitation means no comments capability advertised', () => {
  assert.equal(
    platformSupports('linkedin', 'comments'),
    false,
    'comments capability must be absent for linkedin (#648)',
  );
});

test('capabilities: platformSupports("linkedin","post_daily_metrics") is true — analytics (#647) IS supported', () => {
  assert.equal(
    platformSupports('linkedin', 'post_daily_metrics'),
    true,
    'post_daily_metrics must be present for linkedin (#647)',
  );
});

test('capabilities: platformSupports("linkedin","post_list") is true', () => {
  assert.equal(platformSupports('linkedin', 'post_list'), true);
});

test('capabilities: platformSupports("linkedin","account_daily_metrics") is false — org-admin not available for personal accounts', () => {
  assert.equal(platformSupports('linkedin', 'account_daily_metrics'), false);
});

// ── Dormancy / off-switch ─────────────────────────────────────────────────────

// #679: LinkedIn gates on ARIES_LINKEDIN_ENABLED + COMPOSIO_ENABLED (not ANALYTICS_PROVIDER).
const LI_ENABLED_ENV = {
  ARIES_LINKEDIN_ENABLED: '1',
  COMPOSIO_ENABLED: '1',
} as unknown as NodeJS.ProcessEnv;

// ARIES_LINKEDIN_ENABLED absent — flag off.
const FLAG_OFF_ENV = {
  COMPOSIO_ENABLED: '1',
} as unknown as NodeJS.ProcessEnv;

// ARIES_LINKEDIN_ENABLED on but COMPOSIO_ENABLED absent — composio infrastructure off.
const COMPOSIO_OFF_ENV = {
  ARIES_LINKEDIN_ENABLED: '1',
} as unknown as NodeJS.ProcessEnv;

test('dormancy: isLinkedInInsightsEnabled requires BOTH ARIES_LINKEDIN_ENABLED=1 AND COMPOSIO_ENABLED=1 (ANALYTICS_PROVIDER is irrelevant for LinkedIn)', () => {
  assert.equal(isLinkedInInsightsEnabled(LI_ENABLED_ENV), true, 'both flags on → enabled');
  assert.equal(isLinkedInInsightsEnabled(FLAG_OFF_ENV), false, 'ARIES_LINKEDIN_ENABLED absent → disabled');
  assert.equal(isLinkedInInsightsEnabled(COMPOSIO_OFF_ENV), false, 'COMPOSIO_ENABLED absent → disabled');
  assert.equal(
    isLinkedInInsightsEnabled({} as unknown as NodeJS.ProcessEnv),
    false,
    'no flags → disabled (default OFF)',
  );
  // #679 (c) proof at adapter level: ANALYTICS_PROVIDER=direct_meta does NOT block LinkedIn.
  assert.equal(
    isLinkedInInsightsEnabled({ ARIES_LINKEDIN_ENABLED: '1', COMPOSIO_ENABLED: '1', ANALYTICS_PROVIDER: 'direct_meta' } as unknown as NodeJS.ProcessEnv),
    true,
    '#679 (c): LinkedIn enabled even when ANALYTICS_PROVIDER=direct_meta',
  );
});

test('dormancy: hasAdapter("linkedin") mirrors isLinkedInInsightsEnabled for all flag combinations', () => {
  assert.equal(hasAdapter('linkedin', LI_ENABLED_ENV), true);
  assert.equal(hasAdapter('linkedin', FLAG_OFF_ENV), false);
  assert.equal(hasAdapter('linkedin', COMPOSIO_OFF_ENV), false);
  assert.equal(hasAdapter('linkedin', {} as unknown as NodeJS.ProcessEnv), false);
  // #679 (c): hasAdapter mirrors the same new-behavior case.
  assert.equal(
    hasAdapter('linkedin', { ARIES_LINKEDIN_ENABLED: '1', COMPOSIO_ENABLED: '1', ANALYTICS_PROVIDER: 'direct_meta' } as unknown as NodeJS.ProcessEnv),
    true,
    '#679 (c): hasAdapter("linkedin") true when ARIES_LINKEDIN_ENABLED+COMPOSIO_ENABLED regardless of ANALYTICS_PROVIDER',
  );
});

test('dormancy: getAdapter("linkedin") throws a diagnostic error mentioning ARIES_LINKEDIN_ENABLED when disabled', () => {
  const prevLi = process.env.ARIES_LINKEDIN_ENABLED;
  const prevComposio = process.env.COMPOSIO_ENABLED;
  // Ensure both axes are off so the REGISTRY guard fires.
  delete process.env.ARIES_LINKEDIN_ENABLED;
  delete process.env.COMPOSIO_ENABLED;
  try {
    assert.throws(
      () => getAdapter('linkedin', { connectedAccountId: 'ca_li', tenantId: 1 }),
      /ARIES_LINKEDIN_ENABLED/,
      'error message must mention the flag name so operators know what to set',
    );
  } finally {
    if (prevLi === undefined) delete process.env.ARIES_LINKEDIN_ENABLED;
    else process.env.ARIES_LINKEDIN_ENABLED = prevLi;
    if (prevComposio === undefined) delete process.env.COMPOSIO_ENABLED;
    else process.env.COMPOSIO_ENABLED = prevComposio;
  }
});

test('#679 isComposioOnlyAnalyticsPlatform: linkedin is in the composio-only set', () => {
  assert.equal(isComposioOnlyAnalyticsPlatform('linkedin'), true);
  assert.equal(isComposioOnlyAnalyticsPlatform('facebook'), false, 'facebook uses ANALYTICS_PROVIDER gate');
});
