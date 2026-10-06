import type { ComposioGateway } from './composio-client';
import type { ComposioConfig } from './composio-config';
import { DEFAULT_LIST_MANAGED_PAGES_SLUG } from './facebook-page-resolver';
import { resolveInstagramAccount } from './instagram-account-resolver';
import { ComposioError } from './errors';
import { resolveLinkedInAuthorUrn } from './linkedin-author-resolver';
import { resolveXUser } from './x-user-resolver';

export type MetaAccountChoice = { id: string; name: string; hasInstagram: boolean };

function unavailable(): never {
  throw new ComposioError('account_choices_unavailable', 'Could not load complete account choices. Please retry or reconnect.', { status: 502, retryable: true });
}

/** Never return a partial list or provider credentials to the picker. */
export async function listMetaAccountChoices(
  gateway: ComposioGateway,
  config: ComposioConfig,
  connectedAccountId: string,
  platform: 'facebook' | 'instagram' | 'linkedin' | 'x',
): Promise<MetaAccountChoice[]> {
  if (platform === 'linkedin' || platform === 'x') {
    try {
      if (platform === 'linkedin') {
        const author = await resolveLinkedInAuthorUrn(gateway, config, connectedAccountId);
        if (!author?.name) return unavailable();
        return [{ id: author.urn, name: author.name, hasInstagram: false }];
      }
      const user = await resolveXUser(gateway, config, connectedAccountId);
      if (!user) return unavailable();
      return [{ id: user.username, name: user.name ? `${user.name} (@${user.username})` : `@${user.username}`, hasInstagram: false }];
    } catch { return unavailable(); }
  }
  if (platform === 'instagram') {
    // Instagram Login grants one authenticated business account per connection.
    const account = await resolveInstagramAccount(gateway, config, connectedAccountId);
    if (!account?.username) return unavailable();
    return [{ id: account.igUserId, name: account.username, hasInstagram: true }];
  }
  const choices = new Map<string, MetaAccountChoice>();
  const cursors = new Set<string>();
  let after: string | undefined;
  // Bounded enumeration fails closed rather than hiding additional Pages.
  for (let batch = 0; batch < 100; batch++) {
    let result;
    try {
      result = await gateway.executeTool(config.actionSlugFor('facebook', 'list_pages') ?? DEFAULT_LIST_MANAGED_PAGES_SLUG, {
        connectedAccountId,
        arguments: { user_id: 'me', limit: 100, fields: 'id,name,instagram_business_account', ...(after ? { after } : {}) },
      });
    } catch { return unavailable(); }
    if (!result.successful || result.error) return unavailable();
    let body: any = result.data;
    for (let depth = 0; depth < 3 && body && !Array.isArray(body) && !Array.isArray(body.data); depth++) body = body.data;
    const rows = Array.isArray(body) ? body : body?.data;
    if (!Array.isArray(rows)) return unavailable();
    if (body?.paging != null && (typeof body.paging !== 'object' || Array.isArray(body.paging))) return unavailable();
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || !row.id.trim() || typeof row.name !== 'string' || !row.name.trim()) return unavailable();
      if (choices.has(row.id) && choices.get(row.id)!.name !== row.name) return unavailable();
      choices.set(row.id, { id: row.id, name: row.name, hasInstagram: typeof row.instagram_business_account?.id === 'string' });
    }
    if (!body?.paging?.next) return [...choices.values()];
    const cursor = body.paging.cursors?.after;
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) return unavailable();
    cursors.add(cursor);
    after = cursor;
  }
  return unavailable();
}
