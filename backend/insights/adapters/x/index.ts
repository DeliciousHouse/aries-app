/**
 * backend/insights/adapters/x/index.ts
 *
 * X (Twitter) insights adapter — backed by Composio (#632 analytics, #633 comment
 * replies). Mirrors the verified Facebook adapter (backend/insights/adapters/
 * facebook/index.ts) one platform over, behind the existing ARIES_X_ENABLED flag.
 *
 * Every platform call goes through the Composio gateway (`executeTool`) so the
 * adapter depends on a small, mockable surface; tests inject a fake gateway and
 * never touch the network. The verified Composio action slugs are the defaults,
 * each overridable via COMPOSIO_X_<OP>_ACTION (resolved through
 * `ComposioConfig.actionSlugFor`).
 *
 * Method → action:
 *   fetchPostList     → TWITTER_POST_LOOKUP_BY_POST_IDS (batch; source of
 *                       per-post public_metrics + conversation_id, cached)
 *   fetchPostMetrics  → (cache only — no call; reads fetchPostList's cache)
 *   fetchComments     → TWITTER_RECENT_SEARCH (conversation replies)
 *                       + TWITTER_POST_LOOKUP_BY_POST_ID fallback for
 *                       conversation_id when it is not cached
 *   fetchAccountMetrics → [] (no verified X account-insights action — never
 *                       fabricate an account series)
 *
 * X has no Composio "list my posts" action, so the post list is sourced from
 * Aries' own `posts` table (the tweets Aries published) and the batch lookup
 * enriches each with live engagement. This is the engagementCache analogue of
 * the FB adapter (populated in fetchPostList, read in fetchPostMetrics).
 *
 * DOCUMENTED LIMITATION — impressions: `public_metrics.impression_count` needs a
 * paid/elevated X tier; for the entitlements Aries has it is absent (or a tool
 * 402/403). likes/replies/retweets are ALWAYS the real counts. We map the
 * (possibly absent) impressions onto `views` with the FB `views ?? 0` convention
 * (0 is a placeholder, NOT a fetched value) and record the TRUTH in `rawSource`
 * (impression_count + impressions_available + impressions_unavailable_reason).
 * We NEVER write an invented impressions number.
 */

import pool from '@/lib/db';
import type {
  InsightsAdapter,
  InsightsAdapterContext,
  DateRange,
  RawAccountMetricsDay,
  RawPost,
  RawPostMetricsDay,
  RawComment,
} from '../_adapter.types';
import type { ComposioConfig, ComposioOperation } from '@/backend/integrations/composio/composio-config';
import type { ComposioGateway } from '@/backend/integrations/composio/composio-client';
import type { Queryable } from '@/backend/integrations/composio/connection-store';
import { resolveComposioConfig } from '@/backend/integrations/composio/composio-config';
import { createComposioGateway } from '@/backend/integrations/composio/composio-client';
import { num } from '@/backend/integrations/composio/analytics-mappers';

// ── Verified default action slugs (env-overridable) ────────────────────────────

const DEFAULT_SLUGS: Partial<Record<ComposioOperation, string>> = {
  // Batch tweet lookup (GET /2/tweets?ids=…) — the per-post engagement source.
  list_posts: 'TWITTER_POST_LOOKUP_BY_POST_IDS',
  // Single tweet lookup (GET /2/tweets/:id) — conversation_id fallback only.
  post_insights: 'TWITTER_POST_LOOKUP_BY_POST_ID',
  // Recent search (GET /2/tweets/search/recent) — conversation replies.
  list_comments: 'TWITTER_RECENT_SEARCH',
};

/** tweet_fields requested by the batch lookup (engagement + thread root id). */
const X_LOOKUP_FIELDS = 'public_metrics,conversation_id';

// ── Response unwrapping helpers (mirror the FB adapter) ─────────────────────────

/**
 * Descend through Composio's `{ data: <toolPayload> }` envelope wrappers. The
 * exact nesting (one vs two `.data` layers) varies by tool/SDK version, so we
 * peel object-with-`data` wrappers until we hit an array or a leaf object.
 */
function unwrap(raw: unknown): unknown {
  let cur = raw;
  for (let i = 0; i < 3; i += 1) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) break;
    const obj = cur as Record<string, unknown>;
    if (!('data' in obj)) break;
    cur = obj.data;
  }
  return cur;
}

/** Resolve a list response into its row array, however it is nested. */
function unwrapToArray(raw: unknown): Array<Record<string, unknown>> {
  const peeled = unwrap(raw);
  if (Array.isArray(peeled)) return peeled as Array<Record<string, unknown>>;
  if (peeled && typeof peeled === 'object' && Array.isArray((peeled as Record<string, unknown>).data)) {
    return (peeled as Record<string, unknown>).data as Array<Record<string, unknown>>;
  }
  return [];
}

/** Resolve a single-object response (e.g. a single tweet lookup). */
function unwrapToObject(raw: unknown): Record<string, unknown> {
  const peeled = unwrap(raw);
  if (peeled && typeof peeled === 'object' && !Array.isArray(peeled)) {
    return peeled as Record<string, unknown>;
  }
  return {};
}

/**
 * Resolve a recent-search response into its reply array PLUS the author lookup
 * map from `includes.users`. Unlike `unwrapToArray`, this must stop at the
 * envelope object (`{ data: [tweets], includes: { users } }`) so the sibling
 * `includes` is not peeled away — author_id → username resolution lives there.
 */
function parseSearchEnvelope(raw: unknown): {
  tweets: Array<Record<string, unknown>>;
  users: Map<string, string>;
} {
  let cur = raw;
  for (let i = 0; i < 3; i += 1) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) break;
    const obj = cur as Record<string, unknown>;
    if (Array.isArray(obj.data)) break; // envelope: { data: [tweets], includes }
    if ('data' in obj && obj.data && typeof obj.data === 'object') {
      cur = obj.data;
      continue;
    }
    break;
  }
  const envelope =
    cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Record<string, unknown>) : {};
  const tweets = Array.isArray(envelope.data)
    ? (envelope.data as Array<Record<string, unknown>>)
    : [];
  const users = new Map<string, string>();
  const includes = envelope.includes;
  if (includes && typeof includes === 'object') {
    const usersArr = (includes as Record<string, unknown>).users;
    if (Array.isArray(usersArr)) {
      for (const u of usersArr as Array<Record<string, unknown>>) {
        const uid = typeof u.id === 'string' ? u.id : null;
        const uname = typeof u.username === 'string' ? u.username : null;
        if (uid && uname) users.set(uid, uname);
      }
    }
  }
  return { tweets, users };
}

function publicMetricsOf(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  const pm = (node as Record<string, unknown>).public_metrics;
  if (pm && typeof pm === 'object' && !Array.isArray(pm)) return pm as Record<string, unknown>;
  return null;
}

function conversationIdOf(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const v = (node as Record<string, unknown>).conversation_id;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function toDate(value: unknown): Date {
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(0);
}

// ── Adapter ────────────────────────────────────────────────────────────────────

interface XPostRow {
  platform_post_id: string;
  published_at: Date | string | null;
  caption: string | null;
}

interface CachedTweet {
  publicMetrics: Record<string, unknown> | null;
  conversationId: string | null;
}

export class XInsightsAdapter implements InsightsAdapter {
  readonly platform = 'x' as const;

  /** Per-tweet public_metrics + conversation_id captured in fetchPostList,
   * read in fetchPostMetrics (engagement) and fetchComments (thread root). */
  private readonly engagementCache = new Map<string, CachedTweet>();

  constructor(
    private readonly gateway: ComposioGateway,
    private readonly config: ComposioConfig,
    private readonly db: Queryable = pool,
    private readonly ctx: InsightsAdapterContext = {},
  ) {}

  private slugFor(op: ComposioOperation): string {
    const override = this.config.actionSlugFor('x', op);
    const slug = override ?? DEFAULT_SLUGS[op];
    if (!slug) throw new Error(`No Composio X action slug configured for "${op}".`);
    return slug;
  }

  private connectedAccountId(): string {
    const id = this.ctx.connectedAccountId?.trim();
    if (!id) {
      throw new Error('XInsightsAdapter: no Composio connectedAccountId in context.');
    }
    return id;
  }

  private tenantId(): number {
    const id = this.ctx.tenantId;
    if (id === null || id === undefined) {
      throw new Error('XInsightsAdapter: no tenantId in context.');
    }
    return id;
  }

  /** Execute a tool; throw on a hard (successful=false) failure so the sync run
   * surfaces the leg error (e.g. a 402/403 entitlement) while already-committed
   * rows are preserved. */
  private async exec(op: ComposioOperation, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.gateway.executeTool(this.slugFor(op), {
      connectedAccountId: this.connectedAccountId(),
      arguments: args,
    });
    if (!result.successful) {
      throw new Error(result.error ?? `Composio X ${op} call reported unsuccessful.`);
    }
    return result.data ?? null;
  }

  /**
   * List the tweets Aries published for this tenant (from the `posts` table — X
   * has no Composio "list my tweets" action) and enrich each with live
   * public_metrics + conversation_id via ONE batch lookup. The lookup response
   * populates the engagementCache; the returned RawPost list is sourced from the
   * DB rows so a post is tracked even if the batch lookup transiently omits it.
   *
   * `externalAccountId`/`publishedAfter` are part of the InsightsAdapter contract
   * but X keys the post list on tenant_id (the DB is the source of truth).
   */
  async fetchPostList(_externalAccountId: string, _publishedAfter?: Date): Promise<RawPost[]> {
    const rows = await this.db.query<XPostRow>(
      `SELECT platform_post_id, published_at, caption
         FROM posts
        WHERE tenant_id = $1
          AND platform = 'x'
          AND platform_post_id IS NOT NULL
          AND published_status = 'published'`,
      [this.tenantId()],
    );

    const dbRows = rows.rows.filter((r) => typeof r.platform_post_id === 'string' && r.platform_post_id);
    if (dbRows.length === 0) return [];

    // ONE batch gateway call for engagement + conversation_id (no fan-out).
    const ids = dbRows.map((r) => r.platform_post_id);
    const data = await this.exec('list_posts', {
      ids: ids.join(','),
      tweet_fields: X_LOOKUP_FIELDS,
    });
    for (const tweet of unwrapToArray(data)) {
      const id = typeof tweet.id === 'string' ? tweet.id : null;
      if (!id) continue;
      this.engagementCache.set(id, {
        publicMetrics: publicMetricsOf(tweet),
        conversationId: conversationIdOf(tweet),
      });
    }

    return dbRows.map((r) => ({
      externalPostId: r.platform_post_id,
      publishedAt: toDate(r.published_at),
      // Aries publishes single-image feed posts; X exposes no media-type axis we
      // request here, so the published surface is normalised to 'image'.
      mediaType: 'image' as const,
      title: null,
      caption: typeof r.caption === 'string' ? r.caption : null,
      permalink: `https://x.com/i/web/status/${r.platform_post_id}`,
      thumbnailUrl: null,
      durationSeconds: null,
    }));
  }

  /** X exposes no verified account-insights action — never fabricate a series. */
  async fetchAccountMetrics(
    _externalAccountId: string,
    _range: DateRange,
  ): Promise<RawAccountMetricsDay[]> {
    return [];
  }

  async fetchPostMetrics(externalPostId: string, _range?: DateRange): Promise<RawPostMetricsDay[]> {
    const cached = this.engagementCache.get(externalPostId) ?? null;
    const pm = cached?.publicMetrics ?? null;

    // Only emit a row when there is a real signal — never fabricate a zero row
    // for a tweet we have no public_metrics for (mirror FB).
    if (!pm) return [];

    const likes = num(pm.like_count);
    const commentsCount = num(pm.reply_count);
    const shares = num(pm.retweet_count);
    // impression_count is paid-tier-gated → null/absent for Aries' entitlements.
    const impressionCount = num(pm.impression_count);
    const impressionsAvailable = impressionCount !== null;

    const date = new Date().toISOString().split('T')[0];
    return [
      {
        date,
        // FB `views ?? 0` convention: 0 here is a placeholder, NOT a fetched
        // impressions value (the truth lives in rawSource below).
        views: impressionCount ?? 0,
        watchTimeMinutes: 0,
        avgViewDurationSec: 0,
        avgViewPercentage: 0,
        likes: likes ?? 0,
        commentsCount: commentsCount ?? 0,
        shares: shares ?? 0,
        rawSource: {
          source: 'TWITTER_POST_LOOKUP_BY_POST_ID',
          public_metrics: pm,
          impression_count: impressionCount,
          impressions_available: impressionsAvailable,
          impressions_unavailable_reason: impressionsAvailable ? null : 'x_tier_not_entitled',
        },
      },
    ];
  }

  async fetchComments(externalPostId: string, limit = 100): Promise<RawComment[]> {
    // Thread root: a tweet's conversation_id == its own id for our own tweets,
    // so the cached value (or a single-lookup fallback) anchors the reply search.
    let conversationId = this.engagementCache.get(externalPostId)?.conversationId ?? null;
    if (!conversationId) {
      const lookup = unwrapToObject(
        await this.exec('post_insights', { id: externalPostId, tweet_fields: 'conversation_id' }),
      );
      conversationId = conversationIdOf(lookup);
    }
    if (!conversationId) conversationId = externalPostId;

    // Exclude our own tweets (the root + any self-replies) from "comments".
    // pageId stores the X username/handle (e.g. "sugarleather"); the X recent
    // search `-from:<handle>` operator requires the handle, not the numeric id.
    const ownUsername = this.ctx.pageId?.trim() || null;
    const query = `conversation_id:${conversationId}` + (ownUsername ? ` -from:${ownUsername}` : '');

    const data = await this.exec('list_comments', {
      query,
      // X recent search requires max_results in [10, 100].
      max_results: Math.min(Math.max(limit, 10), 100),
      tweet_fields: 'created_at,author_id',
      expansions: 'author_id',
      user_fields: 'username',
    });

    const { tweets, users } = parseSearchEnvelope(data);
    const out: RawComment[] = [];
    for (const tweet of tweets) {
      const externalCommentId = typeof tweet.id === 'string' ? tweet.id : null;
      if (!externalCommentId) continue;
      const authorId = typeof tweet.author_id === 'string' ? tweet.author_id : null;
      out.push({
        externalCommentId,
        receivedAt: toDate(tweet.created_at),
        authorHandle: authorId ? users.get(authorId) ?? null : null,
        bodyText: typeof tweet.text === 'string' ? tweet.text : '',
      });
    }
    return out;
  }
}

/**
 * Build a context-bound X adapter wired to the live Composio gateway. Throws
 * (via createComposioGateway) when Composio is enabled but no API key is
 * configured — the dispatcher catches that and marks the sync run failed.
 */
export function createXInsightsAdapter(
  ctx: InsightsAdapterContext = {},
  env: NodeJS.ProcessEnv = process.env,
): XInsightsAdapter {
  const config = resolveComposioConfig(env);
  const gateway = createComposioGateway(config);
  return new XInsightsAdapter(gateway, config!, pool, ctx);
}
