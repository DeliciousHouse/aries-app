'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';

import { createOnboardingClient } from '../api/client/onboarding';
import type { OnboardingStatusError, OnboardingStatusSuccess } from '../api/contracts/onboarding';
import StatusBadge from '../components/status-badge';

type OnboardingStatusResponse = OnboardingStatusSuccess | OnboardingStatusError;

export interface OnboardingStatusScreenProps {
  baseUrl?: string;
  initialTenantId?: string;
  initialSignupEventId?: string;
}

export default function OnboardingStatusScreen({
  baseUrl,
  initialTenantId = '',
  initialSignupEventId = ''
}: OnboardingStatusScreenProps): JSX.Element {
  const client = useMemo(() => createOnboardingClient({ baseUrl }), [baseUrl]);

  const [tenantId, setTenantId] = useState(initialTenantId);
  const [signupEventId, setSignupEventId] = useState(initialSignupEventId);
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<OnboardingStatusResponse | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  async function checkStatus(rawTenantId: string, rawSignupEventId = signupEventId): Promise<void> {
    const normalizedTenantId = rawTenantId.trim();
    if (!normalizedTenantId) {
      setRequestError('tenant_id is required');
      setResponse(null);
      return;
    }

    setLoading(true);
    setRequestError(null);

    try {
      const normalizedSignupEventId = rawSignupEventId.trim();
      const result = await client.status(normalizedTenantId, normalizedSignupEventId ? {
        signup_event_id: normalizedSignupEventId
      } : undefined);
      setResponse(result);
    } catch {
      setResponse(null);
      setRequestError('Unable to load onboarding status.');
    } finally {
      setLoading(false);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await checkStatus(tenantId);
  }

  useEffect(() => {
    setTenantId(initialTenantId);
    setSignupEventId(initialSignupEventId);

    if (!initialTenantId.trim()) {
      return;
    }

    void checkStatus(initialTenantId, initialSignupEventId);
  }, [initialSignupEventId, initialTenantId]);

  const isStatusError = response?.onboarding_status === 'error';
  const success = !isStatusError && response ? (response as OnboardingStatusSuccess) : null;

  return (
    <section>
      <h1>Onboarding Status</h1>
      <p>Enter a tenant ID to check current onboarding, provisioning, and validation states.</p>

      <form onSubmit={onSubmit}>
        <label>
          tenant_id
          <input
            name="tenant_id"
            value={tenantId}
            onChange={(e) => setTenantId(e.currentTarget.value)}
            placeholder="acme"
            required
          />
        </label>

        <label>
          signup_event_id (optional)
          <input
            name="signup_event_id"
            value={signupEventId}
            onChange={(e) => setSignupEventId(e.currentTarget.value)}
            placeholder="signup_evt_..."
          />
        </label>

        <button type="submit" disabled={loading || !tenantId.trim()}>
          {loading ? 'Checking status…' : 'Check status'}
        </button>
      </form>

      {loading && <p>Loading onboarding status…</p>}

      {requestError && <p role="alert">{requestError}</p>}

      {response && isStatusError && (
        <div>
          <h2>Request failed</h2>
          <p>
            <strong>reason:</strong> {(response as OnboardingStatusError).reason}
          </p>
        </div>
      )}

      {success && (
        <div>
          <h2>Current status</h2>
          <p>
            <strong>tenant_id:</strong> {success.tenant_id}
          </p>
          <p>
            <strong>onboarding_status:</strong> {success.onboarding_status}{' '}
            <StatusBadge status={success.onboarding_status} />
          </p>
          <p>
            <strong>provisioning_status:</strong> {success.provisioning_status}{' '}
            <StatusBadge status={success.provisioning_status} />
          </p>
          <p>
            <strong>validation_status:</strong> {success.validation_status}{' '}
            <StatusBadge status={success.validation_status} />
          </p>
          <h3>paths</h3>
          <pre>{JSON.stringify(success.paths, null, 2)}</pre>
        </div>
      )}
    </section>
  );
}
