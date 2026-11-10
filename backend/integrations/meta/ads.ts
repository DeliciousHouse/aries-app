import pool from '@/lib/db';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import { dbGetConnection } from '../oauth-db';
import { dbGetLatestOAuthToken } from '../oauth-tokens-db';

export type AdAccount = { id: string; name: string; currency: string | null };
export type AdCampaign = {
  id: string; name: string; status: string; spend: number | null;
  impressions: number | null; clicks: number | null;
};

type GraphRow = Record<string, unknown>;
class AdsError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function object(value: unknown): GraphRow | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as GraphRow : null;
}

/** Only GETs, fixed Graph host, cursor pagination; never follow secret-bearing next URLs. */
async function graphRows(token: string, path: string, params: Record<string, string> = {}): Promise<GraphRow[]> {
  const rows: GraphRow[] = [];
  const cursors = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < 100; page++) {
    const version = (process.env.META_GRAPH_API_VERSION || 'v21.0').trim();
    if (!/^v?\d+\.\d+$/.test(version)) throw new AdsError(503, 'Meta Ads is not configured.');
    const url = new URL(`https://graph.facebook.com/${version.startsWith('v') ? version : `v${version}`}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(15000) });
    } catch { throw new AdsError(502, 'Could not reach Meta Ads. Please retry.'); }
    const body = object(await response.json().catch(() => null));
    if (!response.ok || body?.error) throw new AdsError(response.status === 401 || response.status === 403 ? 409 : 502, 'Could not read Meta Ads. Reconnect or retry.');
    if (!Array.isArray(body?.data) || body.data.some(row => !object(row))) throw new AdsError(502, 'Meta Ads returned incomplete results. Please retry.');
    rows.push(...body.data as GraphRow[]);
    const paging = body.paging == null ? null : object(body.paging);
    if (body.paging != null && !paging) throw new AdsError(502, 'Meta Ads returned incomplete results. Please retry.');
    if (!paging?.next) return rows;
    const cursor = object(paging.cursors)?.after;
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new AdsError(502, 'Meta Ads returned incomplete results. Please retry.');
    cursors.add(cursor);
    after = cursor;
  }
  throw new AdsError(502, 'Meta Ads results exceed the supported limit.');
}

export async function verifyMetaAdsPermissions(token: string): Promise<string[]> {
  const permissions = await graphRows(token, 'me/permissions');
  const scopes = ['ads_read', 'ads_management'];
  if (!scopes.every(scope => permissions.some(row => row.permission === scope && row.status === 'granted'))) {
    throw new AdsError(409, 'Allow ad account access when reconnecting Meta Ads.');
  }
  return scopes;
}

async function adAccounts(token: string): Promise<AdAccount[]> {
  const rows = await graphRows(token, 'me/adaccounts', { fields: 'id,name,currency' });
  const accounts = new Map<string, AdAccount>();
  for (const row of rows) {
    if (typeof row.id !== 'string' || !/^act_\d+$/.test(row.id) || typeof row.name !== 'string' || !row.name.trim()) {
      throw new AdsError(502, 'Meta Ads returned incomplete account choices.');
    }
    accounts.set(row.id, { id: row.id, name: row.name, currency: typeof row.currency === 'string' ? row.currency : null });
  }
  return [...accounts.values()];
}

function metric(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

const DATE_PRESETS: Record<string, string> = { '7day': 'last_7d', '30day': 'last_30d', '90day': 'last_90d' };

export async function handleMetaAds(req: Request, loader?: TenantContextLoader): Promise<Response> {
  const tenantResult = await loadTenantContextOrResponse(loader);
  if ('response' in tenantResult) return tenantResult.response;
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
  if (req.method !== 'GET' && req.method !== 'POST') return json({ message: 'Paid campaign actions are not available.' }, 405);
  try {
    const { tenantId } = tenantResult.tenantContext;
    const connection = await dbGetConnection({ tenantId, provider: 'meta_ads' });
    if (!connection || connection.status !== 'connected') {
      if (req.method === 'POST') throw new AdsError(409, 'Connect Meta Ads before choosing an account.');
      return json({ connected: false, accounts: [], accountId: null, connectionId: null });
    }
    const token = await dbGetLatestOAuthToken(connection.id);
    if (!token?.access_token || token.revoked_at || !token.expires_at || !Number.isFinite(new Date(token.expires_at).getTime()) || new Date(token.expires_at).getTime() <= Date.now()) {
      throw new AdsError(409, 'Reconnect Meta Ads to refresh account access.');
    }
    const accounts = await adAccounts(token.access_token);
    if (req.method === 'POST') {
      const body = object(await req.json().catch(() => null));
      if (typeof body?.accountId !== 'string' || !/^act_\d+$/.test(body.accountId) || typeof body.connectionId !== 'string') throw new AdsError(400, 'Choose an available ad account.');
      const account = accounts.find(account => account.id === body.accountId);
      if (!account || body.connectionId !== connection.id) throw new AdsError(409, 'Account access changed. Reload and choose again.');
      const updated = await pool.query(
        `UPDATE oauth_connections SET external_account_id = $3, external_account_name = $4, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND provider = 'meta_ads' AND status = 'connected'
           AND EXISTS (SELECT 1 FROM oauth_tokens WHERE id = $5 AND connection_id = $2 AND revoked_at IS NULL
             AND expires_at > now() AND id = (SELECT id FROM oauth_tokens WHERE connection_id = $2 ORDER BY created_at DESC LIMIT 1))
         RETURNING id`,
        [tenantId, connection.id, account.id, account.name, token.id],
      );
      if (!updated.rowCount) throw new AdsError(409, 'Connection changed. Reload and choose again.');
      return json({ status: 'ok', accountId: account.id });
    }
    const url = new URL(req.url);
    const selected = accounts.find(account => account.id === connection.external_account_id);
    const result = { connected: true, connectionId: connection.id, accounts, accountId: selected?.id ?? null };
    if (url.searchParams.get('performance') !== '1' || !selected) return json(result);
    const period = url.searchParams.get('period') || '30day';
    const datePreset = DATE_PRESETS[period];
    if (!datePreset) throw new AdsError(400, 'Choose a supported reporting period.');
    const [campaignRows, insights] = await Promise.all([
      graphRows(token.access_token, `${selected.id}/campaigns`, { fields: 'id,name,status' }),
      graphRows(token.access_token, `${selected.id}/insights`, { fields: 'campaign_id,spend,impressions,clicks', level: 'campaign', date_preset: datePreset }),
    ]);
    const campaigns: AdCampaign[] = campaignRows.map(row => {
      if (typeof row.id !== 'string' || !/^\d+$/.test(row.id) || typeof row.name !== 'string' || typeof row.status !== 'string') throw new AdsError(502, 'Meta Ads returned incomplete campaigns.');
      const metrics = insights.filter(insight => insight.campaign_id === row.id);
      const total = (key: string): number | null => {
        const values = metrics.map(insight => metric(insight[key]));
        return values.length && values.every(value => value !== null) ? values.reduce<number>((sum, value) => sum + value!, 0) : null;
      };
      return { id: row.id, name: row.name, status: row.status, spend: total('spend'), impressions: total('impressions'), clicks: total('clicks') };
    });
    return json({ ...result, currency: selected.currency, period, campaigns });
  } catch (error) {
    return json({ message: error instanceof AdsError ? error.message : 'Could not load Meta Ads. Please retry.' }, error instanceof AdsError ? error.status : 500);
  }
}
