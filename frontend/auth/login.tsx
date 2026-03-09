"use client";

import { useState, type FormEvent } from 'react';

type AuthFlowState = 'idle' | 'submitting' | 'challenge_required' | 'authenticated' | 'error';
type AuthErrorCode =
  | 'invalid_credentials'
  | 'mfa_required'
  | 'mfa_invalid'
  | 'session_expired'
  | 'rate_limited'
  | 'auth_service_unavailable'
  | 'unknown';
type MfaMethod = 'totp' | 'sms' | 'email';

type SignInRequest = {
  email: string;
  password: string;
  remember_me?: boolean;
};

type SignInSuccess = {
  status: 'ok';
  auth_flow_state: 'authenticated' | 'challenge_required';
  session?: {
    session_id: string;
    expires_at: string;
  };
  challenge?: {
    challenge_id: string;
    mfa_method: MfaMethod;
    masked_destination?: string;
  };
};

type SignInError = {
  status: 'error';
  auth_flow_state: 'error';
  error: {
    code: Extract<AuthErrorCode, 'invalid_credentials' | 'rate_limited' | 'auth_service_unavailable' | 'unknown'>;
    message: string;
    retry_after_seconds?: number;
  };
};

type VerifyMfaRequest = {
  challenge_id: string;
  verification_code: string;
};

type VerifyMfaSuccess = {
  status: 'ok';
  auth_flow_state: 'authenticated';
  session: {
    session_id: string;
    expires_at: string;
  };
};

type VerifyMfaError = {
  status: 'error';
  auth_flow_state: 'error';
  error: {
    code: Extract<AuthErrorCode, 'mfa_invalid' | 'session_expired' | 'rate_limited' | 'auth_service_unavailable' | 'unknown'>;
    message: string;
  };
};

type AnyAuthResponse = SignInSuccess | SignInError | VerifyMfaSuccess | VerifyMfaError;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export default function LoginScreen(): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);

  const [challengeId, setChallengeId] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [mfaMethod, setMfaMethod] = useState<MfaMethod | null>(null);
  const [maskedDestination, setMaskedDestination] = useState<string | null>(null);

  const [authFlowState, setAuthFlowState] = useState<AuthFlowState>('idle');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [authError, setAuthError] = useState<{ code: AuthErrorCode; message: string; retry_after_seconds?: number } | null>(null);
  const [lastResponse, setLastResponse] = useState<AnyAuthResponse | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);

  async function onSignInSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setClientError(null);
    setAuthError(null);
    setAuthFlowState('submitting');

    const requestBody: SignInRequest = {
      email: email.trim(),
      password,
      remember_me: rememberMe
    };

    try {
      const response = await fetch('/api/auth/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      const payload = (await response.json()) as unknown;
      if (!isObject(payload)) {
        setAuthFlowState('error');
        setClientError('Invalid non-object response from /api/auth/sign-in');
        return;
      }

      const typed = payload as SignInSuccess | SignInError;
      setLastResponse(typed);

      if (typed.status === 'ok' && typed.auth_flow_state === 'authenticated' && typed.session) {
        setSessionId(typed.session.session_id);
        setExpiresAt(typed.session.expires_at);
        setAuthFlowState('authenticated');
        return;
      }

      if (typed.status === 'ok' && typed.auth_flow_state === 'challenge_required' && typed.challenge) {
        setChallengeId(typed.challenge.challenge_id);
        setMfaMethod(typed.challenge.mfa_method);
        setMaskedDestination(typed.challenge.masked_destination ?? null);
        setAuthFlowState('challenge_required');
        return;
      }

      if (typed.status === 'error') {
        setAuthError(typed.error);
        setAuthFlowState('error');
        return;
      }

      setAuthFlowState('error');
      setClientError('Response did not match expected auth UI contract state transitions.');
    } catch (error) {
      setAuthFlowState('error');
      setClientError(error instanceof Error ? error.message : 'Unknown client error while signing in.');
    }
  }

  async function onMfaSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setClientError(null);
    setAuthError(null);
    setAuthFlowState('submitting');

    const requestBody: VerifyMfaRequest = {
      challenge_id: challengeId.trim(),
      verification_code: verificationCode.trim()
    };

    try {
      const response = await fetch('/api/auth/mfa/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      const payload = (await response.json()) as unknown;
      if (!isObject(payload)) {
        setAuthFlowState('error');
        setClientError('Invalid non-object response from /api/auth/mfa/verify');
        return;
      }

      const typed = payload as VerifyMfaSuccess | VerifyMfaError;
      setLastResponse(typed);

      if (typed.status === 'ok' && typed.auth_flow_state === 'authenticated') {
        setSessionId(typed.session.session_id);
        setExpiresAt(typed.session.expires_at);
        setAuthFlowState('authenticated');
        return;
      }

      if (typed.status === 'error') {
        setAuthError(typed.error);
        setAuthFlowState('error');
        return;
      }

      setAuthFlowState('error');
      setClientError('MFA verify response did not match expected contract.');
    } catch (error) {
      setAuthFlowState('error');
      setClientError(error instanceof Error ? error.message : 'Unknown client error while verifying MFA.');
    }
  }

  return (
    <section>
      <h1>Sign in</h1>
      <p>Implements auth.sign_in and auth.mfa_challenge scaffolding from frozen Wave 1 contracts.</p>

      <form onSubmit={onSignInSubmit}>
        <label>
          Email
          <input
            type="email"
            name="email"
            value={email}
            onChange={(event) => setEmail(event.currentTarget.value)}
            required
            minLength={3}
          />
        </label>

        <label>
          Password
          <input
            type="password"
            name="password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            required
            minLength={8}
          />
        </label>

        <label>
          <input
            type="checkbox"
            name="remember_me"
            checked={rememberMe}
            onChange={(event) => setRememberMe(event.currentTarget.checked)}
          />
          Remember me
        </label>

        <button type="submit" disabled={authFlowState === 'submitting'}>
          {authFlowState === 'submitting' ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      {authFlowState === 'challenge_required' ? (
        <section>
          <h2>MFA challenge required</h2>
          <p>method: {mfaMethod}</p>
          {maskedDestination ? <p>destination: {maskedDestination}</p> : null}

          <form onSubmit={onMfaSubmit}>
            <label>
              Challenge ID
              <input
                type="text"
                name="challenge_id"
                value={challengeId}
                onChange={(event) => setChallengeId(event.currentTarget.value)}
                required
              />
            </label>

            <label>
              Verification code
              <input
                type="text"
                name="verification_code"
                value={verificationCode}
                onChange={(event) => setVerificationCode(event.currentTarget.value)}
                pattern="^[0-9]{4,10}$"
                required
              />
            </label>

            <button type="submit" disabled={authFlowState === 'submitting'}>
              {authFlowState === 'submitting' ? 'Verifying…' : 'Verify code'}
            </button>
          </form>
        </section>
      ) : null}

      {authFlowState === 'authenticated' ? (
        <section>
          <h2>Authenticated</h2>
          {sessionId ? <p>session_id: {sessionId}</p> : null}
          {expiresAt ? <p>expires_at: {expiresAt}</p> : null}
        </section>
      ) : null}

      {authError ? (
        <p role="alert">
          {authError.code}: {authError.message}
          {typeof authError.retry_after_seconds === 'number' ? ` (retry_after_seconds=${authError.retry_after_seconds})` : ''}
        </p>
      ) : null}

      {clientError ? <p role="alert">Client error: {clientError}</p> : null}

      <p>auth_flow_state: {authFlowState}</p>

      {lastResponse ? (
        <details>
          <summary>Last response payload</summary>
          <pre>{JSON.stringify(lastResponse, null, 2)}</pre>
        </details>
      ) : null}
    </section>
  );
}
