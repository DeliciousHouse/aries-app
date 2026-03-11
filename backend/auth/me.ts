type SessionStatus = 'active' | 'expired' | 'revoked' | 'pending';

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

function resolveSessionId(req: Request): string {
  const authz = req.headers.get('authorization') || '';
  if (authz.startsWith('Bearer ')) {
    const token = authz.slice('Bearer '.length).trim();
    const sid = authStore().accessIndex.get(token);
    if (sid) return sid;
  }
  return parseCookies(req)['__Host-aries_session'] || '';
}

export async function me(req: Request): Promise<GetSessionSuccess | AuthError> {
  const sessionId = resolveSessionId(req);
  if (!sessionId) return error('invalid_session');

  const store = authStore();
  const session = store.sessions.get(sessionId);
  if (!session) return error('session_not_found');
  if (session.session_status === 'revoked') return error('session_revoked', sessionId);
  if (new Date(session.expires_at).getTime() <= Date.now()) return error('session_expired', sessionId);

  session.last_seen_at = new Date().toISOString();
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

export async function handleMeHttp(req: Request): Promise<Response> {
  const result = await me(req);
  const status = result.auth_status === 'ok' ? 200 : (result.reason === 'session_not_found' ? 404 : 401);
  return new Response(JSON.stringify(result), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
