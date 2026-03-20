import { createTokenHandle } from '../token-store';

type MetaProvider = 'facebook' | 'instagram';

type ConnectRequest = {
  tenant_id?: string;
  provider?: MetaProvider;
  redirect_uri?: string;
};

type ConnectSuccess = {
  status: 'ok';
  tenant_id: string;
  provider: MetaProvider;
  connection_state: 'pending';
  authorization_url: string;
  state: string;
};

type ConnectError = {
  status: 'error';
  reason: 'missing_required_fields' | 'invalid_provider' | 'validation_error' | 'internal_error';
  message?: string;
};

type PendingState = {
  tenant_id: string;
  provider: MetaProvider;
  redirect_uri: string;
  created_at: string;
};

type MetaConnectStore = {
  pending_by_state: Map<string, PendingState>;
};

const ALLOWED_PROVIDERS: MetaProvider[] = ['facebook', 'instagram'];

function normalizeAbsoluteUrl(value: string): string | null {
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

function configuredRedirectUris(): string[] {
  const uris = new Set<string>();
  const explicitRedirect = process.env.META_REDIRECT_URI?.trim();
  const appBaseUrl = process.env.APP_BASE_URL?.trim();

  if (explicitRedirect) {
    const normalized = normalizeAbsoluteUrl(explicitRedirect);
    if (normalized) {
      uris.add(normalized);
    }
  }

  if (appBaseUrl) {
    try {
      uris.add(new URL('/api/integrations/meta/callback', appBaseUrl).toString());
    } catch {
      // Ignore invalid APP_BASE_URL and fall back to the local default below.
    }
  }

  if (uris.size === 0) {
    uris.add('http://localhost:3000/api/integrations/meta/callback');
  }

  return [...uris];
}

function isProvider(value: unknown): value is MetaProvider {
  return typeof value === 'string' && ALLOWED_PROVIDERS.includes(value as MetaProvider);
}

function isAllowedRedirect(uri: string): boolean {
  const normalized = normalizeAbsoluteUrl(uri);
  return normalized !== null && configuredRedirectUris().includes(normalized);
}

function store(): MetaConnectStore {
  const key = '__aries_meta_connect_store_v1__';
  const g = globalThis as Record<string, unknown>;
  if (!g[key]) g[key] = { pending_by_state: new Map<string, PendingState>() } satisfies MetaConnectStore;
  return g[key] as MetaConnectStore;
}

export function connectMeta(payload: ConnectRequest): ConnectSuccess | ConnectError {
  if (!payload.tenant_id || !payload.provider || !payload.redirect_uri) {
    return { status: 'error', reason: 'missing_required_fields', message: 'tenant_id,provider,redirect_uri are required' };
  }
  if (!isProvider(payload.provider)) return { status: 'error', reason: 'invalid_provider' };
  if (!isAllowedRedirect(payload.redirect_uri)) {
    return {
      status: 'error',
      reason: 'validation_error',
      message: `redirect_uri must exactly match one of the configured callback URLs: ${configuredRedirectUris().join(', ')}`,
    };
  }

  const state = createTokenHandle('csrf_token');
  store().pending_by_state.set(state, {
    tenant_id: payload.tenant_id,
    provider: payload.provider,
    redirect_uri: payload.redirect_uri,
    created_at: new Date().toISOString()
  });

  const authUrl = new URL('https://www.facebook.com/v20.0/dialog/oauth');
  authUrl.searchParams.set('client_id', 'meta_app_client_id');
  authUrl.searchParams.set('redirect_uri', payload.redirect_uri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('scope', payload.provider === 'facebook' ? 'pages_show_list,pages_read_engagement' : 'instagram_basic,instagram_content_publish');

  return {
    status: 'ok',
    tenant_id: payload.tenant_id,
    provider: payload.provider,
    connection_state: 'pending',
    authorization_url: authUrl.toString(),
    state
  };
}

export function readMetaPendingState(state: string): PendingState | null {
  return store().pending_by_state.get(state) || null;
}

export function consumeMetaPendingState(state: string): PendingState | null {
  const s = store().pending_by_state.get(state) || null;
  if (s) store().pending_by_state.delete(state);
  return s;
}

export async function handleMetaConnectHttp(req: Request): Promise<Response> {
  let payload: ConnectRequest = {};
  try { payload = (await req.json()) as ConnectRequest; } catch {}
  const out = connectMeta(payload);
  const status = out.status === 'ok' ? 200 : out.reason === 'invalid_provider' || out.reason === 'missing_required_fields' || out.reason === 'validation_error' ? 400 : 500;
  return new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
}
