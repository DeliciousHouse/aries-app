/**
 * backend/insights/adapters/reddit/index.ts
 *
 * Reddit insights adapter — backed by Composio (#642 analytics, #643 comments).
 * Mirrors the X adapter (backend/insights/adapters/x/index.ts) one platform over,
 * behind the EXISTING ARIES_REDDIT_ENABLED flag (reused from the #641 Reddit
 * publish path — Reddit insights does NOT add a new flag).
 *
 * Every platform call goes through the Composio gateway (`executeTool`) so the
 * adapter depends on a small, mockable surface; tests inject a fake gateway and
 * never touch the network. The verified Composio action slugs are the defaults,
 * each overridable via `COMPOSIO_REDDIT_<OP>_ACTION` (resolved through
 * `ComposioConfig.actionSlugFor`).
 *
 * Method → action:
 *   fetchPostList     → (DB only — no Composio call) the `posts` table (the
 *                       Reddit posts Aries published). There is NO Composio
 *                       "list my posts" action, exactly like X.
 *   fetchPostMetrics  → REDDIT_RETRIEVE_REDDIT_POST  (per-post; NOT batchable —
 *                       one call per post, ridden by the dispatcher's bounded
 *                       SEQUENTIAL per-post loop, no fan-out)
 *   fetchComments     → REDDIT_RETRIEVE_POST_COMMENTS (top-level post comments)
 *   fetchAccountMetrics → [] (no verified Reddit account-insights action — never
 *                       fabricate an account series)
 *
 * ── t3_ prefix stripping (load-bearing) ────────────────────────────────────────
 * `posts.platform_post_id` for Reddit is the `t3_<base36>` fullname; BOTH Composio
 * actions take the BARE base36 id in their `article` arg. We strip the `t3_`
 * prefix once at the call boundary (`stripFullname`, no-op if already bare) but
 * keep the full `t3_<base36>` as the stored `external_post_id` so it round-trips
 * with the publish path.
 *
 * ── created_utc is epoch SECONDS (load-bearing) ────────────────────────────────
 * Reddit timestamps (`created_utc` on a post or comment) are a Unix epoch in
 * SECONDS, not an ISO string. We use a dedicated `epochToDate(seconds)` helper —
 * the X adapter's `toDate` expects ISO and would mis-date Reddit values, so it is
 * deliberately NOT reused here.
 *
 * ── DOCUMENTED LIMITATION — no impressions/reach ───────────────────────────────
 * REDDIT_RETRIEVE_REDDIT_POST returns `score`, `num_comments`, `upvote_ratio`
 * only — Reddit exposes NO impressions/reach/views metric at all. `score` CAN be
 * negative (net up/downvotes) and is mapped HONESTLY onto `likes` (never clamped).
 * `views` is the FB `views ?? 0` placeholder convention (0 here is a placeholder,
 * NOT a fetched value); the TRUTH (`views_available:false` +
 * `views_unavailable_reason`) lives in rawSource. We NEVER invent a views number.
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
  // Single-post lookup (score / num_comments / upvote_ratio) — engagement source.
  post_insights: 'REDDIT_RETRIEVE_REDDIT_POST',
  // Threaded comments for one post.
  list_comments: 'REDDIT_RETRIEVE_POST_COMMENTS',
  // NOTE: NO list_posts — Reddit has no Composio "list my posts" action; the
  // post universe is sourced from the `posts` table (like X).
};

// ── Reddit-specific helpers ─────────────────────────────────────────────────────

/**
 * Strip Reddit's `t3_` fullname prefix to the BARE base36 id both Composio
 * actions expect in their `article` arg. No-op if the id is already bare.
 */
function stripFullname(id: string): string {
  return id.replace(/^t3_/, '');
}

/**
 * Reddit `created_utc` is a Unix epoch in SECONDS (not ISO). Convert to a Date;
 * fall back to the epoch (new Date(0)) when the value is missing/garbage. Do NOT
 * reuse the X adapter's `toDate` here — it parses ISO strings and would mis-date.
 */
function epochToDate(value: unknown): Date {
  const seconds = num(value);
  if (seconds === null) return new Date(0);
  const d = new Date(seconds * 1000);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

function asObject(node: unknown): Record<string, unknown> | null {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    return node as Record<string, unknown>;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

// ── Response unwrapping helpers ─────────────────────────────────────────────────

/**
 * Descend through Composio's `{ data: <toolPayload> }` envelope wrappers to land
 * on the post-lookup leaf object. The exact nesting (one vs two `.data` layers)
 * varies by tool/SDK version, so we peel object-with-`data` wrappers until we hit
 * an array or a leaf object.
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

/** Resolve a single-post lookup response into its leaf object, however nested. */
function unwrapToObject(raw: unknown): Record<string, unknown> {
  const peeled = unwrap(raw);
  return asObject(peeled) ?? {};
}

/**
 * Resolve the TOP-LEVEL comment array out of a REDDIT_RETRIEVE_POST_COMMENTS
 * response. Reddit's native listing for a post is a TWO-element array
 * `[postListing, commentsListing]`; each Listing is `{ kind:'Listing', data:{
 * children: [ { kind:'t1', data: <comment> }, ... ] } }`. Composio may wrap that
 * in one or more `{ data: ... }` envelopes and/or hand back the comments listing
 * directly. This unwrap is deliberately tolerant: it peels envelopes, picks the
 * comments listing (the 2nd element of a `[post, comments]` pair, else the lone
 * listing), and returns its `data.children` array. Nested replies
 * (`comment.replies.data.children`) are intentionally LEFT for a follow-up — v1
 * surfaces top-level comments only.
 */
function unwrapToCommentChildren(raw: unknown): Array<Record<string, unknown>> {
  // Peel pure `{ data: ... }` envelope wrappers, but STOP as soon as we reach an
  // array (the [post, comments] pair) or a Listing carrier (`{ data: { children }}`).
  let cur: unknown = raw;
  for (let i = 0; i < 4; i += 1) {
    if (Array.isArray(cur)) break;
    const obj = asObject(cur);
    if (!obj) break;
    // A Listing object carries its rows at `.data.children`; don't peel past it.
    const inner = asObject(obj.data);
    if (inner && Array.isArray(inner.children)) break;
    if (!('data' in obj)) break;
    cur = obj.data;
  }

  // Reddit returns `[postListing, commentsListing]`; the comments are the LAST
  // listing. Some tool versions return just the comments listing object.
  let listing: Record<string, unknown> | null = null;
  if (Array.isArray(cur)) {
    const arr = cur as unknown[];
    listing = asObject(arr[arr.length - 1]) ?? null;
  } else {
    listing = asObject(cur);
  }
  if (!listing) return [];

  const listingData = asObject(listing.data);
  const children = listingData?.children;
  if (Array.isArray(children)) return children as Array<Record<string, unknown>>;
  return [];
}

// ── Adapter ────────────────────────────────────────────────────────────────────

interface RedditPostRow {
  platform_post_id: string;
  published_at: Date | string | null;
  caption: string | null;
}

export class RedditInsightsAdapter implements InsightsAdapter {
  readonly platform = 'reddit' as const;

  constructor(
    private readonly gateway: ComposioGateway,
    private readonly config: ComposioConfig,
    private readonly db: Queryable = pool,
    private readonly ctx: InsightsAdapterContext = {},
  ) {}

  private slugFor(op: ComposioOperation): string {
    const override = this.config.actionSlugFor('reddit', op);
    const slug = override ?? DEFAULT_SLUGS[op];
    if (!slug) throw new Error(`No Composio Reddit action slug configured for "${op}".`);
    return slug;
  }

  private connectedAccountId(): string {
    const id = this.ctx.connectedAccountId?.trim();
    if (!id) {
      throw new Error('RedditInsightsAdapter: no Composio connectedAccountId in context.');
    }
    return id;
  }

  private tenantId(): number {
    const id = this.ctx.tenantId;
    if (id === null || id === undefined) {
      throw new Error('RedditInsightsAdapter: no tenantId in context.');
    }
    return id;
  }

  /** Execute a tool; throw on a hard (successful=false) failure so the sync run
   * surfaces the leg error while already-committed rows are preserved (partial
   * progress is never discarded). */
  private async exec(op: ComposioOperation, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.gateway.executeTool(this.slugFor(op), {
      connectedAccountId: this.connectedAccountId(),
      arguments: args,
    });
    if (!result.successful) {
      throw new Error(result.error ?? `Composio Reddit ${op} call reported unsuccessful.`);
    }
    return result.data ?? null;
  }

  /**
   * List the Reddit posts Aries published for this tenant (from the `posts`
   * table — Reddit has no Composio "list my posts" action, exactly like X). ZERO
   * Composio calls here; per-post engagement is fetched lazily in fetchPostMetrics
   * (Reddit's post lookup is per-post, NOT batchable, so there is no cache to
   * populate up front).
   *
   * `externalAccountId`/`publishedAfter` are part of the InsightsAdapter contract
   * but Reddit keys the post list on tenant_id (the DB is the source of truth).
   */
  async fetchPostList(_externalAccountId: string, _publishedAfter?: Date): Promise<RawPost[]> {
    const rows = await this.db.query<RedditPostRow>(
      `SELECT platform_post_id, published_at, caption
         FROM posts
        WHERE tenant_id = $1
          AND platform = 'reddit'
          AND platform_post_id IS NOT NULL
          AND published_status = 'published'`,
      [this.tenantId()],
    );

    const dbRows = rows.rows.filter((r) => typeof r.platform_post_id === 'string' && r.platform_post_id);
    if (dbRows.length === 0) return [];

    return dbRows.map((r) => ({
      // Keep the full t3_<base36> fullname as the stored external_post_id so it
      // round-trips with the publish path; only the Composio `article` arg is
      // stripped to bare base36 (in fetchPostMetrics / fetchComments).
      externalPostId: r.platform_post_id,
      // `published_at` is a Postgres timestamp (ISO), NOT Reddit epoch_utc — parse
      // it as ISO (epochToDate is only for Reddit's created_utc on posts/comments).
      publishedAt: toPublishedAt(r.published_at),
      // Aries publishes single-image feed posts; Reddit exposes no media-type axis
      // we request here, so the published surface is normalised to 'image'.
      mediaType: 'image' as const,
      title: null,
      caption: str(r.caption),
      permalink: `https://www.reddit.com/comments/${stripFullname(r.platform_post_id)}`,
      thumbnailUrl: null,
      durationSeconds: null,
    }));
  }

  /** Reddit exposes no verified account-insights action — never fabricate a series. */
  async fetchAccountMetrics(
    _externalAccountId: string,
    _range: DateRange,
  ): Promise<RawAccountMetricsDay[]> {
    return [];
  }

  /**
   * One REDDIT_RETRIEVE_REDDIT_POST lookup for a single post (NOT batchable). The
   * dispatcher calls this inside its bounded SEQUENTIAL per-post loop, so there is
   * no fan-out. Emits a row only on a real signal — never a fabricated zero row.
   */
  async fetchPostMetrics(externalPostId: string, _range?: DateRange): Promise<RawPostMetricsDay[]> {
    const data = await this.exec('post_insights', { article: stripFullname(externalPostId) });
    const post = unwrapToObject(data);

    // score / num_comments / upvote_ratio are the only signals Reddit exposes.
    const score = num(post.score);
    const numComments = num(post.num_comments);
    const upvoteRatio = num(post.upvote_ratio);

    // Only emit a row when there is a real signal — never fabricate a zero row for
    // a post the lookup returned nothing useful for (mirror FB/X).
    if (score === null && numComments === null && upvoteRatio === null) return [];

    const date = new Date().toISOString().split('T')[0];
    return [
      {
        date,
        // Reddit has NO impressions/reach/views metric — 0 is the FB `views ?? 0`
        // placeholder, NOT a fetched value (the truth lives in rawSource below).
        views: 0,
        watchTimeMinutes: 0,
        avgViewDurationSec: 0,
        avgViewPercentage: 0,
        // score CAN be negative (net up/downvotes); map it HONESTLY, never clamp.
        likes: score ?? 0,
        commentsCount: numComments ?? 0,
        // Reddit posts expose no share count — surface 0, not a fabricated value.
        shares: 0,
        rawSource: {
          source: 'REDDIT_RETRIEVE_REDDIT_POST',
          score,
          num_comments: numComments,
          upvote_ratio: upvoteRatio,
          views_available: false,
          views_unavailable_reason: 'reddit_no_impressions_metric',
        },
      },
    ];
  }

  /**
   * One REDDIT_RETRIEVE_POST_COMMENTS call for a single post → TOP-LEVEL comments
   * only (nested `replies.data.children` are intentionally a follow-up). Author /
   * body / timestamp come straight off each `t1` comment; the stable comment id is
   * the `name` fullname (`t1_<base36>`), falling back to the bare `id`.
   */
  async fetchComments(externalPostId: string, limit = 100): Promise<RawComment[]> {
    const data = await this.exec('list_comments', { article: stripFullname(externalPostId) });

    const out: RawComment[] = [];
    for (const child of unwrapToCommentChildren(data)) {
      // Each child is `{ kind:'t1', data: <comment> }`; tolerate a bare comment.
      const comment = asObject(child.data) ?? child;
      const externalCommentId = str(comment.name) ?? str(comment.id);
      if (!externalCommentId) continue;
      // Skip the synthetic "load more comments" stub Reddit appends (kind 'more').
      if (str(child.kind) === 'more') continue;
      out.push({
        externalCommentId,
        receivedAt: epochToDate(comment.created_utc),
        authorHandle: str(comment.author),
        bodyText: str(comment.body) ?? '',
      });
      if (out.length >= limit) break;
    }
    return out;
  }
}

/** Resolve the DB `published_at` (Postgres ISO timestamp) to a Date. */
function toPublishedAt(value: Date | string | null): Date {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? new Date(0) : value;
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(0);
}

/**
 * Build a context-bound Reddit adapter wired to the live Composio gateway. Throws
 * (via createComposioGateway) when Composio is enabled but no API key is
 * configured — the dispatcher catches that and marks the sync run failed.
 */
export function createRedditInsightsAdapter(
  ctx: InsightsAdapterContext = {},
  env: NodeJS.ProcessEnv = process.env,
): RedditInsightsAdapter {
  const config = resolveComposioConfig(env);
  const gateway = createComposioGateway(config);
  return new RedditInsightsAdapter(gateway, config!, pool, ctx);
}
