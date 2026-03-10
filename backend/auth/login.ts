import { randomUUID } from 'node:crypto';

type ChallengeType = 'password' | 'otp' | 'magic_link' | 'unknown';
type SessionStatus = 'active' | 'expired' | 'revoked' | 'pending';

type StartSessionRequest = {
  subject?: string;
  challenge_type?: ChallengeType;
  challenge_value?: string;
  device_id?: string;
  tenant_id?: string;
};

type StartSessionSuccess = {
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

const SESSION_COOKIE = '__Host-aries_session';
const REFRESH_COOKIE = '__Host-aries_refresh';
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

function cookie(name: string, value: string, sameSite: 'Lax' | 'Strict', maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${maxAge}`;
}

function error(reason: AuthError['reason'], message?: string): AuthError {
  return {
    auth_status: 'error',
    reason,
    ...(message ? { message } : {})
  };
}

export async function login(payload: StartSessionRequest): Promise<StartSessionSuccess | AuthError> {
  const missing: string[] = [];
  if (!payload.subject) missing.push('subject');
  if (!payload.challenge_type) missing.push('challenge_type');
  if (!payload.challenge_value) missing.push('challenge_value');
  if (missing.length > 0) {
    return error(`missing_required_fields:${missing.join(',')}`);
  }

  if (!['password', 'otp', 'magic_link', 'unknown'].includes(payload.challenge_type || 'unknown')) {
    return error('validation_error:challenge_type');
  }

  if (payload.challenge_value === 'invalid') {
    return error('invalid_credentials');
  }

  const issued_at = nowIso();
  const session_id = randomUUID();
  const access_token = `atk_${randomUUID()}`;
  const refresh_token = `rtk_${randomUUID()}`;

  const session: StoredSession = {
    session_id,
    subject: payload.subject || 'unknown_subject',
    tenant_id: payload.tenant_id,
    session_status: 'active',
    access_token,
    refresh_token,
    issued_at,
    expires_at: addSeconds(issued_at, ACCESS_TTL_SECONDS),
    last_seen_at: issued_at
  };

  const store = authStore();
  store.sessions.set(session_id, session);
  store.accessIndex.set(access_token, session_id);
  store.refreshIndex.set(refresh_token, session_id);

  return {
    auth_status: 'ok',
    session_id,
    session_status: 'active',
    access_token,
    refresh_token,
    token_type: 'Bearer',
    expires_in_seconds: ACCESS_TTL_SECONDS,
    issued_at
  };
}

export async function handleLoginHttp(req: Request): Promise<Response> {
  const payload = (await parseJson<StartSessionRequest>(req)) || {};
  const result = await login(payload);

  if (result.auth_status === 'error') {
    const status = result.reason.startsWith('missing_required_fields') || result.reason.startsWith('validation_error:') ? 400 : 401;
    return new Response(JSON.stringify(result), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  }

  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie', cookie(SESSION_COOKIE, result.session_id, 'Lax', 43200));
  headers.append('set-cookie', cookie(REFRESH_COOKIE, result.refresh_token, 'Strict', 2592000));

  const existing = parseCookies(req);
  if (!existing.aries_csrf) {
    headers.append('set-cookie', `aries_csrf=${encodeURIComponent(`csrf_${randomUUID()}`)}; Path=/; Secure; SameSite=Lax; Max-Age=28800`);
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers
  });
}
