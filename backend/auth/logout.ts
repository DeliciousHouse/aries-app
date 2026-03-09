type SessionStatus = 'active' | 'expired' | 'revoked' | 'pending';

type RevokeSessionRequest = {
  reason?: string;
  revoke_refresh_token?: boolean;
};

type RevokeSessionSuccess = {
  auth_status: 'ok';
  session_id: string;
  session_status: 'revoked';
  revoked: true;
  revoked_at: string;
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

function nowIso(): string {
  return new Date().toISOString();
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

function parseCookies(req: Request): Record<string, string> {
  const raw = req.headers.get('cookie') || '';
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function error(reason: string, session_id?: string): AuthError {
  return {
    auth_status: 'error',
    reason,
    ...(session_id ? { session_id } : {})
  };
}

export async function logout(sessionId: string, payload: RevokeSessionRequest): Promise<RevokeSessionSuccess | AuthError> {
  if (!sessionId) return error('missing_required_fields:sessionId');
  if (!payload.reason) return error('missing_required_fields:reason', sessionId);

  const store = authStore();
  const session = store.sessions.get(sessionId);
  if (!session) return error('session_not_found');

  session.session_status = 'revoked';
  const revoked_at = nowIso();

  store.accessIndex.delete(session.access_token);
  if (payload.revoke_refresh_token !== false) {
    store.refreshIndex.delete(session.refresh_token);
  }

  return {
    auth_status: 'ok',
    session_id: sessionId,
    session_status: 'revoked',
    revoked: true,
    revoked_at
  };
}

export async function handleLogoutHttp(req: Request, sessionId?: string): Promise<Response> {
  const payload = (await parseJson<RevokeSessionRequest>(req)) || {};
  const cookies = parseCookies(req);
  const sid = sessionId || cookies.__Host-aries_session || '';
  const result = await logout(sid, payload);

  const status = result.auth_status === 'ok' ? 200 : (result.reason === 'session_not_found' ? 404 : 400);
  const headers = new Headers({ 'content-type': 'application/json' });
  if (result.auth_status === 'ok') {
    headers.append('set-cookie', '__Host-aries_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    headers.append('set-cookie', '__Host-aries_refresh=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
  }

  return new Response(JSON.stringify(result), { status, headers });
}
