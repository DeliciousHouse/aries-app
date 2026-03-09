"use client";

import { useState, type FormEvent } from 'react';

type SessionStatus = 'active' | 'expired' | 'revoked' | 'pending';
type AuthErrorReason =
  | 'missing_required_fields'
  | 'invalid_credentials'
  | 'invalid_session'
  | 'session_not_found'
  | 'session_expired'
  | 'session_revoked'
  | 'refresh_denied'
  | 'rate_limited'
  | 'internal_error'
  | `missing_required_fields:${string}`
  | `validation_error:${string}`
  | `upstream_error:${string}`;

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
  issued_at?: string;
};

type RevokeSessionSuccess = {
  auth_status: 'ok';
  session_id: string;
  session_status: 'revoked';
  revoked: true;
  revoked_at?: string;
};

type AuthError = {
  auth_status: 'error';
  reason: AuthErrorReason;
  message?: string;
  session_id?: string;
  retry_after_seconds?: number;
};

type LastResponse = GetSessionSuccess | RefreshSessionSuccess | RevokeSessionSuccess | AuthError;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export default function SessionStatusScreen(): JSX.Element {
  const [sessionId, setSessionId] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [revokeReason, setRevokeReason] = useState('manual_revoke');
  const [revokeRefreshToken, setRevokeRefreshToken] = useState(true);

  const [loading, setLoading] = useState(false);
  const [lastResponse, setLastResponse] = useState<LastResponse | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);

  async function loadSession(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoading(true);
    setClientError(null);

    try {
      const response = await fetch(`/api/auth/session/${encodeURIComponent(sessionId.trim())}`, {
        method: 'GET'
      });
      const payload = (await response.json()) as unknown;

      if (!isObject(payload)) {
        setClientError('Invalid non-object response from session lookup endpoint.');
        return;
      }

      setLastResponse(payload as GetSessionSuccess | AuthError);
    } catch (error) {
      setClientError(error instanceof Error ? error.message : 'Unknown client error while loading session status.');
    } finally {
      setLoading(false);
    }
  }

  async function refreshSession(): Promise<void> {
    setLoading(true);
    setClientError(null);

    try {
      const response = await fetch(`/api/auth/session/${encodeURIComponent(sessionId.trim())}/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken.trim() })
      });
      const payload = (await response.json()) as unknown;

      if (!isObject(payload)) {
        setClientError('Invalid non-object response from session refresh endpoint.');
        return;
      }

      setLastResponse(payload as RefreshSessionSuccess | AuthError);
    } catch (error) {
      setClientError(error instanceof Error ? error.message : 'Unknown client error while refreshing session.');
    } finally {
      setLoading(false);
    }
  }

  async function revokeSession(): Promise<void> {
    setLoading(true);
    setClientError(null);

    try {
      const response = await fetch(`/api/auth/session/${encodeURIComponent(sessionId.trim())}/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: revokeReason.trim(), revoke_refresh_token: revokeRefreshToken })
      });
      const payload = (await response.json()) as unknown;

      if (!isObject(payload)) {
        setClientError('Invalid non-object response from session revoke endpoint.');
        return;
      }

      setLastResponse(payload as RevokeSessionSuccess | AuthError);
    } catch (error) {
      setClientError(error instanceof Error ? error.message : 'Unknown client error while revoking session.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section>
      <h1>Session status</h1>
      <p>Scaffold for getAuthSessionById, postAuthSessionRefresh, and postAuthSessionRevoke contracts.</p>

      <form onSubmit={loadSession}>
        <label>
          sessionId
          <input
            type="text"
            name="sessionId"
            value={sessionId}
            onChange={(event) => setSessionId(event.currentTarget.value)}
            required
          />
        </label>

        <button type="submit" disabled={loading || !sessionId.trim()}>
          {loading ? 'Loading…' : 'Load session'}
        </button>
      </form>

      <label>
        refresh_token
        <input
          type="text"
          name="refresh_token"
          value={refreshToken}
          onChange={(event) => setRefreshToken(event.currentTarget.value)}
        />
      </label>
      <button type="button" disabled={loading || !sessionId.trim() || !refreshToken.trim()} onClick={refreshSession}>
        Refresh session
      </button>

      <label>
        revoke reason
        <input
          type="text"
          name="revoke_reason"
          value={revokeReason}
          onChange={(event) => setRevokeReason(event.currentTarget.value)}
          required
        />
      </label>
      <label>
        <input
          type="checkbox"
          name="revoke_refresh_token"
          checked={revokeRefreshToken}
          onChange={(event) => setRevokeRefreshToken(event.currentTarget.checked)}
        />
        revoke_refresh_token
      </label>
      <button type="button" disabled={loading || !sessionId.trim() || !revokeReason.trim()} onClick={revokeSession}>
        Revoke session
      </button>

      {clientError ? <p role="alert">Client error: {clientError}</p> : null}

      {lastResponse?.auth_status === 'error' ? (
        <p role="alert">
          reason: {lastResponse.reason}
          {lastResponse.message ? ` | message: ${lastResponse.message}` : ''}
          {typeof lastResponse.retry_after_seconds === 'number'
            ? ` | retry_after_seconds: ${lastResponse.retry_after_seconds}`
            : ''}
        </p>
      ) : null}

      {lastResponse?.auth_status === 'ok' ? (
        <section>
          <p>session_id: {lastResponse.session_id}</p>
          <p>session_status: {lastResponse.session_status}</p>
          {'expires_at' in lastResponse && lastResponse.expires_at ? <p>expires_at: {lastResponse.expires_at}</p> : null}
          {'issued_at' in lastResponse && lastResponse.issued_at ? <p>issued_at: {lastResponse.issued_at}</p> : null}
          {'last_seen_at' in lastResponse && lastResponse.last_seen_at ? <p>last_seen_at: {lastResponse.last_seen_at}</p> : null}
          {'revoked' in lastResponse ? <p>revoked: {String(lastResponse.revoked)}</p> : null}
        </section>
      ) : null}

      {lastResponse ? (
        <details>
          <summary>Last response payload</summary>
          <pre>{JSON.stringify(lastResponse, null, 2)}</pre>
        </details>
      ) : null}
    </section>
  );
}
