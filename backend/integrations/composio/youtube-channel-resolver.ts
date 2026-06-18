/**
 * Resolve a tenant's YouTube channel id from Composio.
 *
 * The YouTube channel id (needed as insights_accounts.external_account_id, which
 * is NOT NULL) is not part of the Composio connection metadata, so connect-time
 * reconciliation can leave connected_accounts.external_account_id null. This
 * helper calls a channel-listing action with `mine:true` using the connection's
 * connectedAccountId and returns the authenticated channel.
 *
 * The list/insight fetch path itself does NOT need the channel id (fetchPostList
 * uses mine:true) — the id is required only so the bridge can satisfy the NOT
 * NULL enrollment column, exactly mirroring the Facebook Page-id back-heal.
 *
 * Single-channel SMB case = the one channel. When several are returned we pick
 * the first deterministically and report the full count so the caller can log it.
 *
 * Fail-safe: returns null on an unsuccessful tool call or when no channel is
 * returned (e.g. missing scope). Throwing is the caller's call to make — this
 * never invents a channel id and never wedges the worker tick.
 *
 * Response shape (YouTube): { data: { items: [ { id, snippet: { title } } ] } }
 * — the row array is at `.items`, NOT Graph's `.data[]`.
 *
 * OPEN CONTRACT RISK: the exact verified action for "list my channel" was not
 * pinned in the Composio catalog; `YOUTUBE_LIST_CHANNELS` is the default and is
 * env-overridable via COMPOSIO_YOUTUBE_LIST_PAGES_ACTION so an operator can point
 * it at the confirmed slug without a code change.
 */

import type { ComposioGateway } from './composio-client';
import type { ComposioConfig } from './composio-config';

export interface ResolvedYouTubeChannel {
  channelId: string;
  channelName: string | null;
  /** Total channels returned (>1 means we picked the first). */
  managedCount: number;
}

/** Default slug; overridable via COMPOSIO_YOUTUBE_LIST_PAGES_ACTION. */
export const DEFAULT_LIST_CHANNELS_SLUG = 'YOUTUBE_LIST_CHANNELS';

/**
 * Peel Composio's `{ data: <toolPayload> }` wrappers until we reach the YouTube
 * container, then read its `.items` array. Tolerates a bare array if a tool
 * version returns one directly.
 */
function unwrapToItems(raw: unknown): Array<Record<string, unknown>> {
  let cur = raw;
  for (let i = 0; i < 3; i += 1) {
    if (Array.isArray(cur)) return cur as Array<Record<string, unknown>>;
    if (!cur || typeof cur !== 'object') break;
    const obj = cur as Record<string, unknown>;
    if (Array.isArray(obj.items)) return obj.items as Array<Record<string, unknown>>;
    if (!('data' in obj)) break;
    cur = obj.data;
  }
  return Array.isArray(cur) ? (cur as Array<Record<string, unknown>>) : [];
}

export async function resolveYouTubeChannel(
  gateway: ComposioGateway,
  config: ComposioConfig,
  connectedAccountId: string,
): Promise<ResolvedYouTubeChannel | null> {
  const slug = config.actionSlugFor('youtube', 'list_pages') ?? DEFAULT_LIST_CHANNELS_SLUG;
  const result = await gateway.executeTool(slug, {
    connectedAccountId,
    arguments: { mine: true, part: 'snippet', maxResults: 25 },
  });
  if (!result.successful) return null;

  const channels = unwrapToItems(result.data);
  for (const channel of channels) {
    const id = typeof channel.id === 'string' && channel.id.trim() ? channel.id.trim() : null;
    if (!id) continue;
    const snippet =
      channel.snippet && typeof channel.snippet === 'object'
        ? (channel.snippet as Record<string, unknown>)
        : null;
    const name =
      snippet && typeof snippet.title === 'string' && snippet.title.trim()
        ? snippet.title.trim()
        : null;
    return { channelId: id, channelName: name, managedCount: channels.length };
  }
  return null;
}
