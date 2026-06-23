/**
 * Resolve a tenant's X (Twitter) username from Composio.
 *
 * The X username (Twitter handle) is used as insights_accounts.external_account_id
 * and by the X insights adapter's fetchComments `-from:<username>` filter. It is
 * NOT part of the Composio connection metadata, so connect-time reconciliation
 * leaves connected_accounts.external_account_id null for legacy or first-time
 * connections. This helper calls the verified TWITTER_USER_LOOKUP_ME action
 * (env-overridable via the `account_info` op) using the connection's
 * connectedAccountId and returns the authenticated user's username (handle).
 *
 * Storing the USERNAME (not the numeric id) is CORRECT: the X insights adapter's
 * fetchComments builds a recent-search `-from:<handle>` filter which the X API
 * expects as a handle, not a numeric id. See backend/insights/adapters/x/index.ts
 * fetchComments for the usage site.
 *
 * Fail-safe: returns null on an unsuccessful tool call, a wrapper response that is
 * not `successful`, or when no username is present. Never invents a username and
 * never throws — the insights-sync worker tick must not wedge.
 *
 * Response shape (verified via the live Composio catalog 2026-06-18):
 *   Direct:  { data: { id, name, username, ... }, successful }
 *   Nested:  { data: { data: { id, name, username, ... } }, successful }
 * Some toolkit versions wrap the payload one extra level, so we peel defensively.
 */

import type { ComposioGateway } from './composio-client';
import type { ComposioConfig } from './composio-config';

export interface ResolvedXUser {
  /** The Twitter handle (e.g. "sugarleather") — stored verbatim as external_account_id. */
  username: string;
  /** Best-effort display name; may be null when the profile is minimal. */
  name: string | null;
}

/** Default verified slug; overridable via COMPOSIO_X_ACCOUNT_INFO_ACTION. */
export const DEFAULT_X_GET_ME_SLUG = 'TWITTER_USER_LOOKUP_ME';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Pull the user object out of either the direct shape (`data`) or the nested
 * shape (`data.data`). Tries the nested shape first since Composio often wraps
 * the Twitter API response in an extra envelope.
 */
function extractUser(rawData: unknown): Record<string, unknown> | null {
  const data = asRecord(rawData);
  if (!data) return null;

  // Nested shape: data.data.username (extra Composio envelope around Twitter body)
  const inner = asRecord(data.data);
  if (inner && trimmedString(inner.username)) return inner;

  // Direct shape: data.username (tool version that unwraps for us)
  if (trimmedString(data.username)) return data;

  return null;
}

export async function resolveXUser(
  gateway: ComposioGateway,
  config: ComposioConfig,
  connectedAccountId: string,
): Promise<ResolvedXUser | null> {
  const slug = config.actionSlugFor('x', 'account_info') ?? DEFAULT_X_GET_ME_SLUG;
  const result = await gateway.executeTool(slug, { connectedAccountId, arguments: {} });
  if (!result.successful) return null;

  const user = extractUser(result.data);
  if (!user) return null;

  const username = trimmedString(user.username);
  if (!username) return null; // never invent a username

  return { username, name: trimmedString(user.name) };
}
