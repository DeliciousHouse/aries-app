/**
 * Resolve a tenant's Reddit username from Composio.
 *
 * The Reddit username is used as insights_accounts.external_account_id so the
 * bridge can satisfy the NOT NULL enrollment column. It is NOT part of the
 * Composio connection metadata, so connect-time reconciliation leaves
 * connected_accounts.external_account_id null for legacy or first-time connections.
 * This helper calls the verified REDDIT_GET_REDDIT_USER_ABOUT action (env-overridable
 * via the `account_info` op) using the connection's connectedAccountId and returns
 * the authenticated Redditor's username.
 *
 * IMPORTANT: REDDIT_GET_REDDIT_USER_ABOUT REQUIRES an argument — `{ username: 'me' }`
 * — 'me' is the Reddit-convention token for the authenticated user. The call will
 * fail or return an empty payload without it.
 *
 * Fail-safe: returns null on an unsuccessful tool call, a wrapper response that is
 * not `successful`, or when no username is present. Never invents a username and
 * never throws — the insights-sync worker tick must not wedge.
 *
 * Response shape (Reddit `t2` thing; Composio wraps in one or two `{ data: ... }`
 * envelopes):
 *   Two-level: { data: { data: { name, id, ... } }, successful }
 *   One-level: { data: { name, ... }, successful }
 * The Reddit username is the `name` field of the `t2` user object.
 */

import type { ComposioGateway } from './composio-client';
import type { ComposioConfig } from './composio-config';

export interface ResolvedRedditUser {
  /** The Reddit username (e.g. "sugarleather") — stored verbatim as external_account_id. */
  username: string;
  /** Same as username for Reddit (the `name` field is the display name on t2). */
  name: string | null;
}

/** Default verified slug; overridable via COMPOSIO_REDDIT_ACCOUNT_INFO_ACTION. */
export const DEFAULT_REDDIT_GET_ME_SLUG = 'REDDIT_GET_REDDIT_USER_ABOUT';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Pull the Reddit `name` (username) out of Composio's envelope. The `t2` user
 * object's `name` field is the username. Peels defensive layers:
 *   data.data.name  (two-level envelope: Composio + Reddit API wrapper)
 *   data.name       (one-level: tool version that partially unwraps)
 */
function extractUsername(rawData: unknown): string | null {
  const data = asRecord(rawData);
  if (!data) return null;

  // Two-level: data.data.name (t2 object nested inside Composio + Reddit envelope)
  const inner = asRecord(data.data);
  if (inner) {
    const name = trimmedString(inner.name);
    if (name) return name;
  }

  // One-level: data.name
  return trimmedString(data.name);
}

export async function resolveRedditUser(
  gateway: ComposioGateway,
  config: ComposioConfig,
  connectedAccountId: string,
): Promise<ResolvedRedditUser | null> {
  const slug = config.actionSlugFor('reddit', 'account_info') ?? DEFAULT_REDDIT_GET_ME_SLUG;
  // 'me' is the Reddit-convention argument required by this action for the
  // authenticated user. Without it the action errors or returns nothing.
  const result = await gateway.executeTool(slug, {
    connectedAccountId,
    arguments: { username: 'me' },
  });
  if (!result.successful) return null;

  const username = extractUsername(result.data);
  if (!username) return null; // never invent a username

  // Reddit's `name` field is the Redditor's handle (e.g. "sugarleather");
  // there is no separate display_name on the `t2` object distinct from `name`.
  return { username, name: username };
}
