import { randomUUID } from 'node:crypto';

type SessionStatus = 'active' | 'expired' | 'revoked' | 'pending';

type RefreshSessionRequest = {
  refresh_token?: string;
};

type GetSessionSuccess = {
  auth_status: 'ok';
  session_id: string;
  session_status: SessionStatus;
  subject?: string;
  tenant_id?: string;
  issued_at?: string;
  expires_at?: string;
  last_seen_at?: string;
};

type RefreshSessionSuccess = {
  auth_status: 'ok';
  session_id: string;
  session_status: SessionStatus;
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in_seconds: number;
  issued_at: string;
};

type AuthError = {
  auth_status: 'error';
  reason: string;
  message?: string;
  session_id?: string;
  retry_after_seconds?: number;
};

type StoredSession = {
  session_id: string;
  subject: string;
  tenant_id?: string;
  session_status: SessionStatus;
  access_token: string;
  refresh_token: string;
  issued_at: string;
  expires_at: string;
  last_seen_at: string;
};

type AuthStore = {
  sessions: Map<string, StoredSession>;
  accessIndex: Map<string, string>;
  refreshIndex: Map<string, string>;
};

const ACCESS_TTL_SECONDS = 900;

function nowIso(): string {
  return new Date().toISOString();
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

function authStore(): AuthStore {
  const key = '__aries_auth_store_v1__';
  const g = globalThis as Record<string, unknown>;
  if (!g[key]) {
    g[key] = {
      sessions: new Map<string, StoredSession>(),
      accessIndex: new Map<string, string>(),
      refreshIndex: new Map<string, string>()
    } satisfies AuthStore;
  }
  return g[key] as AuthStore;
}

function parseJson<T>(req: Request): Promise<T | null> {
  return req
    .json()
    .then((v) => v as T)
    .catch(() => null);
}

function error(reason: string, session_id?: string): AuthError {
  return {
    auth_status: 'error',
    reason,
    ...(session_id ? { session_id } : {})
  };
}

export async function getSessionById(sessionId: string): Promise<GetSessionSuccess | AuthError> {
  if (!sessionId) {
    return error('missing_required_fields:sessionId');
  }

  const store = authStore();
  const session = store.sessions.get(sessionId);
  if (!session) {
    return error('session_not_found');
  }

  if (session.session_status === 'revoked') {
    return error('session_revoked', sessionId);
  }

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    session.session_status = 'expired';
    return error('session_expired', sessionId);
  }

  session.last_seen_at = nowIso();
  return {
    auth_status: 'ok',
    session_id: session.session_id,
    session_status: session.session_status,
    subject: session.subject,
    tenant_id: session.tenant_id,
    issued_at: session.issued_at,
    expires_at: session.expires_at,
    last_seen_at: session.last_seen_at
  };
}

export async function refreshSession(sessionId: string, payload: RefreshSessionRequest): Promise<RefreshSessionSuccess | AuthError> {
  if (!sessionId) {
    return error('missing_required_fields:sessionId');
  }
  if (!payload.refresh_token) {
    return error('missing_required_fields:refresh_token', sessionId);
  }

  const store = authStore();
  const session = store.sessions.get(sessionId);
  if (!session) return error('session_not_found');
  if (session.session_status === 'revoked') return error('session_revoked', sessionId);

  if (session.refresh_token !== payload.refresh_token) {
    return error('refresh_denied', sessionId);
  }

  const oldRefresh = session.refresh_token;
  const oldAccess = session.access_token;
  const issued_at = nowIso();

  session.access_token = `atk_${randomUUID()}`;
  session.refresh_token = `rtk_${randomUUID()}`;
  session.issued_at = issued_at;
  session.expires_at = addSeconds(issued_at, ACCESS_TTL_SECONDS);
  session.last_seen_at = issued_at;

  store.refreshIndex.delete(oldRefresh);
  store.accessIndex.delete(oldAccess);
  store.refreshIndex.set(session.refresh_token, sessionId);
  store.accessIndex.set(session.access_token, sessionId);

  return {
    auth_status: 'ok',
    session_id: sessionId,
    session_status: 'active',
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    token_type: 'Bearer',
    expires_in_seconds: ACCESS_TTL_SECONDS,
    issued_at
  };
}

export async function handleGetSessionHttp(req: Request, sessionId: string): Promise<Response> {
  const result = await getSessionById(sessionId);
  const status = result.auth_status === 'ok' ? 200 : (result.reason === 'session_not_found' ? 404 : 400);
  return new Response(JSON.stringify(result), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

export async function handleRefreshSessionHttp(req: Request, sessionId: string): Promise<Response> {
  const payload = (await parseJson<RefreshSessionRequest>(req)) || {};
  const result = await refreshSession(sessionId, payload);
  const status = result.auth_status === 'ok'
    ? 200
    : (result.reason === 'session_not_found' ? 404 : (result.reason === 'refresh_denied' || result.reason === 'session_revoked' ? 401 : 400));

  const headers = new Headers({ 'content-type': 'application/json' });
  if (result.auth_status === 'ok') {
    headers.append('set-cookie', `__Host-aries_refresh=${encodeURIComponent(result.refresh_token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`);
  }

  return new Response(JSON.stringify(result), { status, headers });
}
