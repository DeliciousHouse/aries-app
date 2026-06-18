/**
 * backend/insights/adapters/youtube/index.ts
 *
 * YouTube insights adapter — backed by Composio (#637 analytics, #638 comments).
 * Mirrors the verified Facebook adapter (backend/insights/adapters/facebook/
 * index.ts) and the X adapter one platform over, behind the new
 * ARIES_YOUTUBE_ENABLED flag.
 *
 * Every platform call goes through the Composio gateway (`executeTool`) so the
 * adapter depends on a small, mockable surface; tests inject a fake gateway and
 * never touch the network. The verified Composio action slugs are the defaults,
 * each overridable via `COMPOSIO_YOUTUBE_<OP>_ACTION` (resolved through
 * `ComposioConfig.actionSlugFor`).
 *
 * Method → action:
 *   fetchPostList     → YOUTUBE_LIST_CHANNEL_VIDEOS    (the authenticated
 *                       channel's uploads via mine:true) then ONE
 *                       YOUTUBE_GET_VIDEO_DETAILS_BATCH (statistics for every
 *                       listed video, cached on the instance)
 *   fetchPostMetrics  → (cache only — no call; reads fetchPostList's cache)
 *   fetchComments     → YOUTUBE_LIST_COMMENT_THREADS2  (top-level threads)
 *   fetchAccountMetrics → [] (no verified per-day account series — never
 *                       fabricate a channel time series)
 *
 * YouTube list responses nest as `{ data: { items: [...] } }` — the row array is
 * at `.items`, NOT Graph's `.data[]`. The dedicated `unwrapToItems` helper below
 * resolves that shape; it must not be confused with the FB/X `.data[]` unwrap.
 *
 * Engagement model: YouTube exposes per-video statistics (viewCount/likeCount/
 * commentCount) only through GET_VIDEO_DETAILS_BATCH, so fetchPostList captures
 * them once for the whole listing in a single batch call and caches them on the
 * adapter instance (the dispatcher reuses one adapter per sync and calls
 * fetchPostList before fetchPostMetrics). There is NO per-video fan-out.
 */

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
import { resolveComposioConfig } from '@/backend/integrations/composio/composio-config';
import { createComposioGateway } from '@/backend/integrations/composio/composio-client';
import { num } from '@/backend/integrations/composio/analytics-mappers';

// ── Verified default action slugs (env-overridable) ────────────────────────────

const DEFAULT_SLUGS: Partial<Record<ComposioOperation, string>> = {
  // List the authenticated channel's uploads (playlistItems via mine:true).
  list_posts: 'YOUTUBE_LIST_CHANNEL_VIDEOS',
  // Batch video statistics (videos.list?part=statistics&id=…) — engagement source.
  post_insights: 'YOUTUBE_GET_VIDEO_DETAILS_BATCH',
  // Top-level comment threads for one video.
  list_comments: 'YOUTUBE_LIST_COMMENT_THREADS2',
};

// ── Response unwrapping helpers (YouTube nests rows at `.items`) ─────────────────

/**
 * Descend through Composio's `{ data: <toolPayload> }` envelope wrappers until we
 * reach the object that carries YouTube's `items` array (or a leaf). The exact
 * nesting (one vs two `.data` layers) varies by tool/SDK version, so we peel
 * object-with-`data` wrappers, stopping as soon as we hit an `items` carrier.
 */
function unwrap(raw: unknown): unknown {
  let cur = raw;
  for (let i = 0; i < 3; i += 1) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) break;
    const obj = cur as Record<string, unknown>;
    if (Array.isArray(obj.items)) break; // found the YouTube container
    if (!('data' in obj)) break;
    cur = obj.data;
  }
  return cur;
}

/**
 * Resolve a YouTube list response into its row array. Unlike Graph's `.data[]`,
 * YouTube returns `{ items: [...] }`; this reads `.items` after peeling the
 * Composio envelope, and tolerates a bare array if a tool version returns one.
 */
function unwrapToItems(raw: unknown): Array<Record<string, unknown>> {
  const peeled = unwrap(raw);
  if (Array.isArray(peeled)) return peeled as Array<Record<string, unknown>>;
  if (peeled && typeof peeled === 'object') {
    const items = (peeled as Record<string, unknown>).items;
    if (Array.isArray(items)) return items as Array<Record<string, unknown>>;
  }
  return [];
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

function toDate(value: unknown): Date {
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(0);
}

/** Pull the videoId out of a playlistItem snippet (`snippet.resourceId.videoId`). */
function videoIdOf(snippet: Record<string, unknown> | null): string | null {
  const resourceId = asObject(snippet?.resourceId);
  return str(resourceId?.videoId);
}

/** Pull the best available thumbnail url (`snippet.thumbnails.high.url`). */
function thumbnailUrlOf(snippet: Record<string, unknown> | null): string | null {
  const thumbnails = asObject(snippet?.thumbnails);
  const high = asObject(thumbnails?.high);
  return str(high?.url);
}

// ── Adapter ────────────────────────────────────────────────────────────────────

interface CachedStats {
  views: number | null;
  likes: number | null;
  comments: number | null;
  /** The raw statistics object, preserved for rawSource provenance. */
  statistics: Record<string, unknown> | null;
}

export class YouTubeInsightsAdapter implements InsightsAdapter {
  readonly platform = 'youtube' as const;

  /** Per-video statistics captured in fetchPostList, read in fetchPostMetrics. */
  private readonly engagementCache = new Map<string, CachedStats>();

  constructor(
    private readonly gateway: ComposioGateway,
    private readonly config: ComposioConfig,
    private readonly ctx: InsightsAdapterContext = {},
  ) {}

  private slugFor(op: ComposioOperation): string {
    const override = this.config.actionSlugFor('youtube', op);
    const slug = override ?? DEFAULT_SLUGS[op];
    if (!slug) throw new Error(`No Composio YouTube action slug configured for "${op}".`);
    return slug;
  }

  private connectedAccountId(): string {
    const id = this.ctx.connectedAccountId?.trim();
    if (!id) {
      throw new Error('YouTubeInsightsAdapter: no Composio connectedAccountId in context.');
    }
    return id;
  }

  /** Execute a tool; throw on a hard (successful=false) failure so the sync run
   * surfaces the leg error while already-committed rows are preserved. */
  private async exec(op: ComposioOperation, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.gateway.executeTool(this.slugFor(op), {
      connectedAccountId: this.connectedAccountId(),
      arguments: args,
    });
    if (!result.successful) {
      throw new Error(result.error ?? `Composio YouTube ${op} call reported unsuccessful.`);
    }
    return result.data ?? null;
  }

  /**
   * List the authenticated channel's uploads (mine:true — no channelId needed)
   * and enrich every listed video with live statistics via ONE batch call. The
   * batch response populates the engagementCache; the returned RawPost list is
   * sourced from the listing so a video is tracked even if the batch transiently
   * omits its statistics.
   *
   * `externalAccountId`/`publishedAfter` are part of the InsightsAdapter contract
   * but YouTube keys the listing on the authenticated channel (mine:true).
   */
  async fetchPostList(_externalAccountId: string, _publishedAfter?: Date): Promise<RawPost[]> {
    const listData = await this.exec('list_posts', {
      mine: true,
      part: 'snippet',
      maxResults: 50,
    });

    const posts: RawPost[] = [];
    const videoIds: string[] = [];
    for (const item of unwrapToItems(listData)) {
      const snippet = asObject(item.snippet);
      const videoId = videoIdOf(snippet);
      if (!videoId) continue;
      videoIds.push(videoId);
      posts.push({
        externalPostId: videoId,
        publishedAt: toDate(snippet?.publishedAt),
        // YouTube uploads are videos.
        mediaType: 'video',
        title: str(snippet?.title),
        caption: str(snippet?.description),
        permalink: `https://youtube.com/watch?v=${videoId}`,
        thumbnailUrl: thumbnailUrlOf(snippet),
        durationSeconds: null,
      });
    }

    // ONE batch statistics call for every listed video (no per-video fan-out).
    // YouTube caps id at 50/request; the action auto-splits if needed.
    if (videoIds.length > 0) {
      const detailsData = await this.exec('post_insights', {
        id: videoIds,
        parts: ['statistics'],
      });
      for (const item of unwrapToItems(detailsData)) {
        const id = str(item.id);
        if (!id) continue;
        const statistics = asObject(item.statistics);
        this.engagementCache.set(id, {
          views: num(statistics?.viewCount),
          likes: num(statistics?.likeCount),
          comments: num(statistics?.commentCount),
          statistics,
        });
      }
    }

    return posts;
  }

  /** YouTube exposes no verified per-day account series — never fabricate one. */
  async fetchAccountMetrics(
    _externalAccountId: string,
    _range: DateRange,
  ): Promise<RawAccountMetricsDay[]> {
    return [];
  }

  async fetchPostMetrics(externalPostId: string, _range?: DateRange): Promise<RawPostMetricsDay[]> {
    const cached = this.engagementCache.get(externalPostId) ?? null;

    // Only emit a row when there is a real cached signal — never fabricate a zero
    // row for a video whose statistics we never fetched (mirror FB/X).
    if (!cached) return [];

    const date = new Date().toISOString().split('T')[0];
    return [
      {
        date,
        views: cached.views ?? 0,
        watchTimeMinutes: 0,
        avgViewDurationSec: 0,
        avgViewPercentage: 0,
        likes: cached.likes ?? 0,
        commentsCount: cached.comments ?? 0,
        // YouTube statistics expose no share count — surface 0, not a fabricated
        // value (the truth lives in rawSource.statistics).
        shares: 0,
        rawSource: {
          source: 'YOUTUBE_GET_VIDEO_DETAILS_BATCH',
          statistics: cached.statistics,
        },
      },
    ];
  }

  async fetchComments(externalPostId: string, limit = 100): Promise<RawComment[]> {
    const data = await this.exec('list_comments', {
      videoId: externalPostId,
      // YouTube commentThreads caps maxResults at [1, 100].
      maxResults: Math.min(Math.max(limit, 1), 100),
    });

    const out: RawComment[] = [];
    for (const thread of unwrapToItems(data)) {
      const threadSnippet = asObject(thread.snippet);
      const topLevel = asObject(threadSnippet?.topLevelComment);
      if (!topLevel) continue;
      const externalCommentId = str(topLevel.id);
      if (!externalCommentId) continue;
      const commentSnippet = asObject(topLevel.snippet);
      out.push({
        externalCommentId,
        receivedAt: toDate(commentSnippet?.publishedAt),
        authorHandle: str(commentSnippet?.authorDisplayName),
        bodyText: str(commentSnippet?.textOriginal) ?? str(commentSnippet?.textDisplay) ?? '',
      });
    }
    return out;
  }
}

/**
 * Build a context-bound YouTube adapter wired to the live Composio gateway.
 * Throws (via createComposioGateway) when Composio is enabled but no API key is
 * configured — the dispatcher catches that and marks the sync run failed.
 */
export function createYouTubeInsightsAdapter(
  ctx: InsightsAdapterContext = {},
  env: NodeJS.ProcessEnv = process.env,
): YouTubeInsightsAdapter {
  const config = resolveComposioConfig(env);
  const gateway = createComposioGateway(config);
  return new YouTubeInsightsAdapter(gateway, config!, ctx);
}
