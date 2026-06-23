/**
 * Resolve a tenant's Instagram user id and username from Composio.
 *
 * The IG user id (numeric) is stored as insights_accounts.external_account_id so
 * the INSTAGRAM_GET_IG_USER_MEDIA and INSTAGRAM_GET_IG_MEDIA_INSIGHTS calls can
 * pass it as `ig_user_id`. It is NOT part of the Composio connection metadata, so
 * connect-time reconciliation leaves connected_accounts.external_account_id null
 * for legacy or first-time connections. This helper calls the verified
 * INSTAGRAM_GET_USER_INFO action (env-overridable via the `account_info` op) with
 * `ig_user_id: 'me'` using the connection's connectedAccountId and returns the
 * authenticated account's { igUserId, username }.
 *
 * NOTE: the `'me'` resolution is UNVERIFIED live (IG is not connected yet as of
 * #692/#693). If it fails on first live connect, the documented fallback is to read
 * the FB page's `instagram_business_account.id` edge from the Facebook page
 * resolver — but the fail-safe null return here just skips this IG tenant and
 * never wedges the FB/X sync or the worker tick.
 *
 * Fail-safe: returns null on an unsuccessful tool call, a wrapper response without
 * a valid `id` field, or when the call errors. Never invents a user id and never
 * throws — the insights-sync worker tick must not wedge.
 *
 * Response shape (Composio wraps the IG user object in one or two `{ data: ... }`
 * envelopes):
 *   One-level:  { data: { id, username, followers_count }, successful }
 *   Two-level:  { data: { data: { id, username, followers_count } }, successful }
 */

import type { ComposioGateway } from './composio-client';
import type { ComposioConfig } from './composio-config';

export interface ResolvedInstagramAccount {
  /** The numeric IG user id — stored verbatim as external_account_id. */
  igUserId: string;
  /** The Instagram @username (handle). */
  username: string | null;
}

/** Default verified slug; overridable via COMPOSIO_INSTAGRAM_ACCOUNT_INFO_ACTION. */
export const DEFAULT_INSTAGRAM_GET_ME_SLUG = 'INSTAGRAM_GET_USER_INFO';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Pull the IG user object out of Composio's envelope. Tries the nested shape
 * first since Composio often wraps the Graph response in an extra envelope.
 *   data.data.id  (two-level: Composio outer + Graph API body)
 *   data.id       (one-level: tool version that partially unwraps)
 */
function extractAccount(rawData: unknown): Record<string, unknown> | null {
  const data = asRecord(rawData);
  if (!data) return null;

  // Two-level: data.data.id
  const inner = asRecord(data.data);
  if (inner && trimmedString(inner.id)) return inner;

  // One-level: data.id
  if (trimmedString(data.id)) return data;

  return null;
}

export async function resolveInstagramAccount(
  gateway: ComposioGateway,
  config: ComposioConfig,
  connectedAccountId: string,
): Promise<ResolvedInstagramAccount | null> {
  const slug = config.actionSlugFor('instagram', 'account_info') ?? DEFAULT_INSTAGRAM_GET_ME_SLUG;
  let result;
  try {
    result = await gateway.executeTool(slug, {
      connectedAccountId,
      arguments: { ig_user_id: 'me', fields: 'id,username,followers_count' },
    });
  } catch {
    return null;
  }
  if (!result.successful) return null;

  const account = extractAccount(result.data);
  if (!account) return null;

  const igUserId = trimmedString(account.id);
  if (!igUserId) return null; // never invent a user id

  return { igUserId, username: trimmedString(account.username) };
}
