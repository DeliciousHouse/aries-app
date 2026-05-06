import {
  dbAuditEvent,
  dbDeletePendingState,
  dbGetPendingState,
  dbUpsertConnection,
} from '../oauth-db';
import { dbInsertOAuthToken } from '../oauth-tokens-db';
import {
  getTenantContext,
  TenantContextError,
  type TenantContext,
} from '@/lib/tenant-context';

type StoredPickerPayload = {
  pages?: Array<{
    id?: string;
    name?: string;
    pageAccessToken?: string;
    instagramBusinessAccountId?: string | null;
  }>;
};

type SelectPageRequestBody = {
  state?: string;
  page_id?: string;
};

type SelectPageSuccess = {
  status: 'ok';
  facebook_connection_id: string;
  instagram_connection_id: string | null;
};

type SelectPageError = {
  status: 'error';
  reason:
    | 'missing_required_fields'
    | 'invalid_state'
    | 'state_expired'
    | 'page_not_found'
    | 'tenant_mismatch'
    | 'not_authenticated'
    | 'internal_error';
  message?: string;
};

export type MetaSelectPageOptions = {
  tenantContextLoader?: () => Promise<TenantContext>;
};

function jsonResponse(payload: SelectPageSuccess | SelectPageError, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function handleMetaSelectPageHttp(
  req: Request,
  options: MetaSelectPageOptions = {},
): Promise<Response> {
  let body: SelectPageRequestBody = {};
  try {
    body = (await req.json()) as SelectPageRequestBody;
  } catch {
    body = {};
  }
  const state = (body.state ?? '').trim();
  const pageId = (body.page_id ?? '').trim();
  if (!state || !pageId) {
    return jsonResponse(
      { status: 'error', reason: 'missing_required_fields', message: 'state and page_id are required' },
      400,
    );
  }

  let tenantContext: TenantContext;
  try {
    const loader = options.tenantContextLoader ?? getTenantContext;
    tenantContext = await loader();
  } catch (error) {
    const reason = error instanceof TenantContextError ? error.reason : 'tenant_context_required';
    return jsonResponse(
      {
        status: 'error',
        reason: 'not_authenticated',
        message: error instanceof Error ? error.message : reason,
      },
      401,
    );
  }

  const pending = await dbGetPendingState(state);
  if (!pending || pending.provider !== 'facebook') {
    return jsonResponse({ status: 'error', reason: 'invalid_state' }, 400);
  }
  if (new Date(pending.expires_at).getTime() <= Date.now()) {
    await dbDeletePendingState(state);
    return jsonResponse({ status: 'error', reason: 'state_expired' }, 400);
  }
  if (String(pending.tenant_id) !== String(tenantContext.tenantId)) {
    return jsonResponse({ status: 'error', reason: 'tenant_mismatch' }, 403);
  }

  const payload = (pending.picker_payload as StoredPickerPayload | null) ?? null;
  const pages = payload?.pages ?? [];
  const selected = pages.find((p) => p.id === pageId);
  if (!selected || !selected.id || !selected.pageAccessToken) {
    return jsonResponse({ status: 'error', reason: 'page_not_found' }, 400);
  }

  try {
    const connectedAt = new Date().toISOString();
    const facebookConnection = await dbUpsertConnection({
      tenantId: pending.tenant_id,
      provider: 'facebook',
      status: 'connected',
      grantedScopes: pending.scopes,
      externalAccountId: selected.id,
      externalAccountName: selected.name ?? selected.id,
      connectedAt,
      disconnectedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    });
    await dbInsertOAuthToken({
      connectionId: facebookConnection.id,
      accessToken: selected.pageAccessToken,
      tokenType: 'page',
      issuedAt: connectedAt,
    });

    let instagramConnectionId: string | null = null;
    if (selected.instagramBusinessAccountId) {
      const instagramConnection = await dbUpsertConnection({
        tenantId: pending.tenant_id,
        provider: 'instagram',
        status: 'connected',
        grantedScopes: pending.scopes,
        externalAccountId: selected.instagramBusinessAccountId,
        externalAccountName: selected.name ?? selected.instagramBusinessAccountId,
        connectedAt,
        disconnectedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
      await dbInsertOAuthToken({
        connectionId: instagramConnection.id,
        accessToken: selected.pageAccessToken,
        tokenType: 'page',
        issuedAt: connectedAt,
      });
      instagramConnectionId = instagramConnection.id;
    }

    await dbDeletePendingState(state);
    await dbAuditEvent({
      tenantId: pending.tenant_id,
      connectionId: facebookConnection.id,
      provider: 'facebook',
      eventType: 'oauth.callback.connected',
      eventStatus: 'ok',
      detail: {
        selected_page_id: selected.id,
        instagram_connection_id: instagramConnectionId,
        flow: 'meta_page_picker',
      },
    });

    return jsonResponse(
      {
        status: 'ok',
        facebook_connection_id: facebookConnection.id,
        instagram_connection_id: instagramConnectionId,
      },
      200,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ status: 'error', reason: 'internal_error', message }, 500);
  }
}
