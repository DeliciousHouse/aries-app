/**
 * Resolve a tenant's Facebook Page id from Composio.
 *
 * The Facebook Page id (needed for analytics/comments) is NOT part of the
 * Composio connection metadata, so connect-time reconciliation can leave
 * connected_accounts.external_account_id null. This helper calls the verified
 * FACEBOOK_LIST_MANAGED_PAGES action (env-overridable via the `list_pages` op)
 * using the connection's connectedAccountId and returns the managed Page.
 *
 * Single-page SMB case = the one Page. When several are managed we pick the
 * first deterministically and report the full set so the caller can log it.
 *
 * Fail-safe: returns null on an unsuccessful tool call or when no Page is
 * returned (e.g. missing pages_show_list scope, which silently returns []).
 * Throwing is the caller's call to make — this never invents a Page.
 *
 * Response shape (verified via Composio MCP 2026-06-17):
 *   { data: { data: [ { id, name, ... } ], paging }, successful, error }
 */

import type { ComposioGateway } from './composio-client';
import type { ComposioConfig } from './composio-config';

export interface ResolvedFacebookPage {
  pageId: string;
  pageName: string | null;
  /** Total managed pages returned (>1 means we picked the first). */
  managedCount: number;
}

/** Default verified slug; overridable via COMPOSIO_FACEBOOK_LIST_PAGES_ACTION. */
export const DEFAULT_LIST_MANAGED_PAGES_SLUG = 'FACEBOOK_LIST_MANAGED_PAGES';

/** Peel Composio's `{ data: <toolPayload> }` wrappers until we hit the row array. */
function unwrapToArray(raw: unknown): Array<Record<string, unknown>> {
  let cur = raw;
  for (let i = 0; i < 3; i += 1) {
    if (Array.isArray(cur)) return cur as Array<Record<string, unknown>>;
    if (!cur || typeof cur !== 'object' || !('data' in (cur as Record<string, unknown>))) break;
    cur = (cur as Record<string, unknown>).data;
  }
  return Array.isArray(cur) ? (cur as Array<Record<string, unknown>>) : [];
}

export async function resolveFacebookManagedPage(
  gateway: ComposioGateway,
  config: ComposioConfig,
  connectedAccountId: string,
): Promise<ResolvedFacebookPage | null> {
  const slug = config.actionSlugFor('facebook', 'list_pages') ?? DEFAULT_LIST_MANAGED_PAGES_SLUG;
  const result = await gateway.executeTool(slug, {
    connectedAccountId,
    arguments: { user_id: 'me', limit: 25, fields: 'id,name' },
  });
  if (!result.successful) return null;

  const pages = unwrapToArray(result.data);
  for (const page of pages) {
    const id = typeof page.id === 'string' && page.id.trim() ? page.id.trim() : null;
    if (!id) continue;
    const name = typeof page.name === 'string' && page.name.trim() ? page.name.trim() : null;
    return { pageId: id, pageName: name, managedCount: pages.length };
  }
  return null;
}
