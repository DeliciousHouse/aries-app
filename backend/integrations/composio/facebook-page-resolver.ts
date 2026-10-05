/**
 * List a tenant's accessible Facebook Pages from Composio.
 *
 * The Facebook Page id (needed for analytics/comments) is NOT part of the
 * Composio connection metadata, so connect-time reconciliation can leave
 * connected_accounts.external_account_id null. This helper calls the verified
 * FACEBOOK_LIST_MANAGED_PAGES action (env-overridable via the `list_pages` op)
 * using the connection's connectedAccountId.
 *
 * Enumerate every granted Page for explicit operator selection. Never return
 * tokens or fetch the Graph API's secret-bearing paging.next URL.
 *
 * Fail-safe: returns null on a THROWN tool call, an unsuccessful tool call, or
 * when pagination cannot be completed. Empty successful responses return [].
 *
 * The thrown-call leg is load-bearing (AA-243): @composio/core throws raw on
 * transport failure (`ComposioToolNotFoundError` from the tool-schema retrieve,
 * `ComposioToolExecutionError` via `handleToolExecutionError`) and
 * `LiveComposioGateway.executeTool` does not catch. Neither class is a
 * recognized never-posted verdict in `publishNeverReachedPlatform`, so a throw
 * leaked out of `publishPost`'s pre-publish page-id fallback used to park a
 * provably-never-posted row as outcome-unknown in manual reconciliation. This
 * call is a read-only page enumeration that cannot create a post, so null (→
 * the caller's own terminal never-posted classification) is always the right
 * verdict — same contract as instagram-account-resolver.ts.
 *
 * Response shape (verified via Composio MCP 2026-06-17):
 *   { data: { data: [ { id, name, ... } ], paging }, successful, error }
 */

import type { ComposioGateway } from './composio-client';
import type { ComposioConfig } from './composio-config';

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

export async function listFacebookManagedPages(
  gateway: ComposioGateway,
  config: ComposioConfig,
  connectedAccountId: string,
): Promise<Array<{ id: string; name: string | null }> | null> {
  const slug = config.actionSlugFor('facebook', 'list_pages') ?? DEFAULT_LIST_MANAGED_PAGES_SLUG;
  const pages = new Map<string, { id: string; name: string | null }>();
  const cursors = new Set<string>();
  let after: string | undefined;
  try {
    do {
      const result = await gateway.executeTool(slug, {
        connectedAccountId,
        arguments: { user_id: 'me', limit: 100, fields: 'id,name', ...(after ? { after } : {}) },
      });
      if (!result.successful) return null;
      for (const page of unwrapToArray(result.data)) {
        if (!page || typeof page.id !== 'string' || !page.id.trim()) continue;
        const id = page.id.trim();
        const name = typeof page.name === 'string' && page.name.trim() ? page.name.trim() : null;
        pages.set(id, { id, name });
      }
      let payload = result.data;
      for (let i = 0; i < 3 && payload && typeof payload === 'object'; i += 1) {
        const envelope = payload as { paging?: { next?: unknown; cursors?: { after?: unknown } }; data?: unknown };
        if (envelope.paging) break;
        payload = envelope.data;
      }
      const paging = (payload as { paging?: { next?: unknown; cursors?: { after?: unknown } } } | null)?.paging;
      after = paging?.next && typeof paging.cursors?.after === 'string' ? paging.cursors.after : undefined;
      if (paging?.next && (!after || cursors.has(after))) return null;
      if (after) cursors.add(after);
    } while (after);
  } catch {
    return null;
  }
  return [...pages.values()];
}
