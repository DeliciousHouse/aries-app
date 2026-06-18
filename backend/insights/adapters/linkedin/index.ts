/**
 * backend/insights/adapters/linkedin/index.ts
 *
 * LinkedIn insights adapter — backed by Composio (#647 analytics). Mirrors the
 * Reddit/X adapters (per-post, DB-sourced post list, no Composio "list my posts"
 * action) behind the EXISTING ARIES_LINKEDIN_ENABLED flag (reused from the LinkedIn
 * connect/publish path #645/#646 — LinkedIn insights does NOT add a new flag).
 *
 * Every platform call goes through the Composio gateway (`executeTool`) so the
 * adapter depends on a small, mockable surface; tests inject a fake gateway and
 * never touch the network. The verified Composio action slug is the default,
 * overridable via `COMPOSIO_LINKEDIN_POST_INSIGHTS_ACTION` (resolved through
 * `ComposioConfig.actionSlugFor`).
 *
 * Method → action:
 *   fetchPostList     → (DB only — no Composio call) the `posts` table (the
 *                       LinkedIn posts Aries published). There is NO Composio
 *                       "list my posts" action, exactly like X/Reddit.
 *   fetchPostMetrics  → LINKEDIN_LIST_REACTIONS  (per-post; NOT batchable — one
 *                       call per post, ridden by the dispatcher's bounded
 *                       SEQUENTIAL per-post loop, no fan-out)
 *   fetchComments     → [] (LinkedIn has NO Composio list-comments action — an
 *                       HONEST empty, never a fabricated comment; see #648)
 *   fetchAccountMetrics → [] (LINKEDIN_GET_SHARE_STATS is organization-admin
 *                       only; #645 captured the person URN, not an org URN — an
 *                       org-stats follow-up, never a fabricated account series)
 *
 * ── ANALYTICS SCOPE — personal reactions only (#647) ───────────────────────────
 * For a PERSONAL LinkedIn account the only verified engagement signal is the
 * reaction list: LINKEDIN_LIST_REACTIONS on the post entity returns the member
 * reactions, from which we derive a reaction count and map it HONESTLY onto
 * `likes`. Organisation-level share stats (impressions / reach / clicks /
 * comments / shares via LINKEDIN_GET_SHARE_STATS) require the
 * `rw_organization_admin` scope + an org URN Aries does not hold for a personal
 * connection, so those metrics are NOT fetched and stay 0 placeholders (the FB
 * `views ?? 0` convention) with the TRUTH recorded in rawSource
 * (`analytics_scope`, `org_stats_unavailable_reason`, `impressions_available`).
 * We NEVER invent an impressions/reach/comment/share number.
 *
 * ── Reaction-count precedence (load-bearing) ───────────────────────────────────
 * LINKEDIN_LIST_REACTIONS returns a collection `{ elements:[…], paging:{ total }}`.
 * We prefer the authoritative `paging.total` (the full reaction count, even when
 * the page only carries `count` elements); when it is absent we fall back to the
 * length of `elements` and flag it as a FLOOR (`reaction_count_is_floor=true`)
 * whenever it equals the page size (100), since the true total may be larger.
 * When NEITHER is present the count is null → NO row is emitted (a measured 0 is
 * real signal and IS emitted; an absent count is never fabricated as 0).
 *
 * ── Post entity URN (load-bearing) ─────────────────────────────────────────────
 * `posts.platform_post_id` for LinkedIn is whatever the publish path (#646)
 * captured from LINKEDIN_CREATE_LINKED_IN_POST. We pass it VERBATIM as the
 * `entity` arg — we do NOT guess or prepend a `urn:li:share:` / `urn:li:ugcPost:`
 * prefix, because a bare id is ambiguous (share vs ugcPost vs activity) and
 * inventing the wrong URN type would silently mis-target the lookup.
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
  // Per-post reaction list — the only verified PERSONAL engagement source.
  post_insights: 'LINKEDIN_LIST_REACTIONS',
  // NOTE: NO list_comments — LinkedIn has no Composio list-comments action (#648).
  // NOTE: NO list_posts — LinkedIn has no Composio "list my posts" action; the
  // post universe is sourced from the `posts` table (like X/Reddit).
};

/** Page size requested from LINKEDIN_LIST_REACTIONS; doubles as the floor marker. */
const REACTIONS_PAGE_SIZE = 100;

// ── Helpers ─────────────────────────────────────────────────────────────────────

function asObject(node: unknown): Record<string, unknown> | null {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    return node as Record<string, unknown>;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Descend through Composio's `{ data: <toolPayload> }` envelope wrappers to land
 * on the LinkedIn reactions collection (`{ elements, paging }`). The exact
 * nesting (one vs two `.data` layers) varies by tool/SDK version, so we peel
 * object-with-`data` wrappers until the current object IS the collection (carries
 * `elements`/`paging`) or there is nothing left to peel.
 */
function unwrapToCollection(raw: unknown): Record<string, unknown> {
  let cur: unknown = raw;
  for (let i = 0; i < 4; i += 1) {
    const obj = asObject(cur);
    if (!obj) break;
    // Stop as soon as we reach the collection carrier itself.
    if ('elements' in obj || 'paging' in obj) break;
    if (!('data' in obj)) break;
    cur = obj.data;
  }
  return asObject(cur) ?? {};
}

interface ReactionCount {
  count: number | null;
  source: 'paging_total' | 'elements_length' | null;
  isFloor: boolean;
}

/**
 * Resolve the reaction count from a LINKEDIN_LIST_REACTIONS collection using the
 * documented precedence: authoritative `paging.total` first; else the length of
 * `elements` (flagged a FLOOR when it saturates the page size); else null.
 */
function extractReactionCount(collection: Record<string, unknown>): ReactionCount {
  const paging = asObject(collection.paging);
  const total = paging ? num(paging.total) : null;
  if (total !== null) {
    return { count: total, source: 'paging_total', isFloor: false };
  }
  const elements = collection.elements;
  if (Array.isArray(elements)) {
    const len = elements.length;
    return { count: len, source: 'elements_length', isFloor: len >= REACTIONS_PAGE_SIZE };
  }
  return { count: null, source: null, isFloor: false };
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

// ── Adapter ────────────────────────────────────────────────────────────────────

interface LinkedInPostRow {
  platform_post_id: string;
  published_at: Date | string | null;
  caption: string | null;
}

export class LinkedInInsightsAdapter implements InsightsAdapter {
  readonly platform = 'linkedin' as const;

  constructor(
    private readonly gateway: ComposioGateway,
    private readonly config: ComposioConfig,
    private readonly db: Queryable = pool,
    private readonly ctx: InsightsAdapterContext = {},
  ) {}

  private slugFor(op: ComposioOperation): string {
    const override = this.config.actionSlugFor('linkedin', op);
    const slug = override ?? DEFAULT_SLUGS[op];
    if (!slug) throw new Error(`No Composio LinkedIn action slug configured for "${op}".`);
    return slug;
  }

  private connectedAccountId(): string {
    const id = this.ctx.connectedAccountId?.trim();
    if (!id) {
      throw new Error('LinkedInInsightsAdapter: no Composio connectedAccountId in context.');
    }
    return id;
  }

  private tenantId(): number {
    const id = this.ctx.tenantId;
    if (id === null || id === undefined) {
      throw new Error('LinkedInInsightsAdapter: no tenantId in context.');
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
      throw new Error(result.error ?? `Composio LinkedIn ${op} call reported unsuccessful.`);
    }
    return result.data ?? null;
  }

  /**
   * List the LinkedIn posts Aries published for this tenant (from the `posts`
   * table — LinkedIn has no Composio "list my posts" action, exactly like
   * X/Reddit). ZERO Composio calls here; per-post engagement is fetched lazily in
   * fetchPostMetrics (LinkedIn's reaction lookup is per-post, NOT batchable).
   *
   * `externalAccountId`/`publishedAfter` are part of the InsightsAdapter contract
   * but LinkedIn keys the post list on tenant_id (the DB is the source of truth).
   */
  async fetchPostList(_externalAccountId: string, _publishedAfter?: Date): Promise<RawPost[]> {
    const rows = await this.db.query<LinkedInPostRow>(
      `SELECT platform_post_id, published_at, caption
         FROM posts
        WHERE tenant_id = $1
          AND platform = 'linkedin'
          AND platform_post_id IS NOT NULL
          AND published_status = 'published'`,
      [this.tenantId()],
    );

    const dbRows = rows.rows.filter((r) => typeof r.platform_post_id === 'string' && r.platform_post_id);
    if (dbRows.length === 0) return [];

    return dbRows.map((r) => ({
      // The publish path's captured post URN (share/ugcPost/activity) round-trips
      // as the stored external_post_id and is passed VERBATIM to Composio.
      externalPostId: r.platform_post_id,
      publishedAt: toPublishedAt(r.published_at),
      // Aries publishes single-image feed posts; LinkedIn exposes no media-type
      // axis we request here, so the published surface is normalised to 'image'.
      mediaType: 'image' as const,
      title: null,
      caption: str(r.caption),
      permalink: `https://www.linkedin.com/feed/update/${r.platform_post_id}`,
      thumbnailUrl: null,
      durationSeconds: null,
    }));
  }

  /**
   * LinkedIn personal share stats (LINKEDIN_GET_SHARE_STATS) require an
   * organisation-admin scope + org URN Aries does not hold for a personal
   * connection — never fabricate an account series. Org-level account metrics are
   * a documented follow-up, gated on capturing an org URN at connect.
   */
  async fetchAccountMetrics(
    _externalAccountId: string,
    _range: DateRange,
  ): Promise<RawAccountMetricsDay[]> {
    return [];
  }

  /**
   * One LINKEDIN_LIST_REACTIONS lookup for a single post (NOT batchable). The
   * dispatcher calls this inside its bounded SEQUENTIAL per-post loop, so there is
   * no fan-out. Emits a row only on a measured reaction count (a real 0 included)
   * — never a fabricated zero row when the count is absent.
   */
  async fetchPostMetrics(externalPostId: string, _range?: DateRange): Promise<RawPostMetricsDay[]> {
    // entity is passed VERBATIM — never prepend/guess a urn:li: prefix.
    const data = await this.exec('post_insights', {
      entity: externalPostId,
      count: REACTIONS_PAGE_SIZE,
    });
    const collection = unwrapToCollection(data);
    const { count: reactionCount, source: reactionCountSource, isFloor } =
      extractReactionCount(collection);

    // Only emit a row when there is a measured reaction count — never fabricate a
    // zero row for a post the lookup returned no usable count for (mirror FB/X).
    // A measured 0 IS a real signal and is emitted.
    if (reactionCount === null) return [];

    const date = new Date().toISOString().split('T')[0];
    return [
      {
        date,
        // Personal reactions expose no impressions/reach — 0 is the FB `views ?? 0`
        // placeholder, NOT a fetched value (the truth lives in rawSource below).
        views: 0,
        watchTimeMinutes: 0,
        avgViewDurationSec: 0,
        avgViewPercentage: 0,
        // Reaction count mapped HONESTLY onto likes.
        likes: reactionCount,
        // Personal reactions carry no comment/share count — surface 0, not a
        // fabricated value (the truth lives in rawSource).
        commentsCount: 0,
        shares: 0,
        rawSource: {
          source: 'LINKEDIN_LIST_REACTIONS',
          reaction_count: reactionCount,
          reaction_count_source: reactionCountSource,
          reaction_count_is_floor: isFloor,
          analytics_scope: 'personal_reactions_only',
          org_stats_unavailable_reason: 'requires_org_admin',
          impressions_available: false,
        },
      },
    ];
  }

  /**
   * LinkedIn comments cannot be ingested: there is NO Composio list-comments
   * action for LinkedIn (LINKEDIN_GET_POST_CONTENT returns a post's content, not a
   * comments list). We therefore return an HONEST empty array — never a synthesised
   * or faked comment — and never throw, so the sync run stays 'ok' and the
   * remaining legs (reactions) still complete. This is a genuine platform
   * limitation (#648 documents it), reflected by OMITTING the 'comments' capability
   * for LinkedIn in platforms/capabilities.ts so the product never advertises a
   * LinkedIn comment feature it cannot back.
   */
  async fetchComments(_externalPostId: string, _limit = 100): Promise<RawComment[]> {
    return [];
  }
}

/**
 * Build a context-bound LinkedIn adapter wired to the live Composio gateway.
 * Throws (via createComposioGateway) when Composio is enabled but no API key is
 * configured — the dispatcher catches that and marks the sync run failed.
 */
export function createLinkedInInsightsAdapter(
  ctx: InsightsAdapterContext = {},
  env: NodeJS.ProcessEnv = process.env,
): LinkedInInsightsAdapter {
  const config = resolveComposioConfig(env);
  const gateway = createComposioGateway(config);
  return new LinkedInInsightsAdapter(gateway, config!, pool, ctx);
}
