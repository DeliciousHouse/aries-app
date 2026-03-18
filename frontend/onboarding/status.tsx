'use client';

import { FormEvent, useEffect, useState } from 'react';

import type { OnboardingStatusError, OnboardingStatusSuccess } from '@/lib/api/onboarding';
import { useOnboardingStatus } from '@/hooks/use-onboarding-status';
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
  const onboardingStatus = useOnboardingStatus({ baseUrl, autoLoad: false });

  const [tenantId, setTenantId] = useState(initialTenantId);
  const [signupEventId, setSignupEventId] = useState(initialSignupEventId);
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<OnboardingStatusResponse | null>(null);

  async function checkStatus(rawTenantId: string, rawSignupEventId = signupEventId): Promise<void> {
    const normalizedTenantId = rawTenantId.trim();
    if (!normalizedTenantId) {
      setResponse(null);
      onboardingStatus.setError(new Error('tenant_id is required'));
      return;
    }

    setLoading(true);
    onboardingStatus.reset();

    try {
      const normalizedSignupEventId = rawSignupEventId.trim();
      const result = await onboardingStatus.load(normalizedTenantId, normalizedSignupEventId ? {
        signup_event_id: normalizedSignupEventId
      } : undefined);
      setResponse(result);
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

      {onboardingStatus.error && <p role="alert">{onboardingStatus.error.message}</p>}

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
          <p>
            <strong>progress_hint:</strong> {success.progress_hint}
          </p>
          <h3>available artifacts</h3>
          <ul>
            <li>draft: {success.artifacts.draft ? 'yes' : 'no'}</li>
            <li>validated: {success.artifacts.validated ? 'yes' : 'no'}</li>
            <li>validation report: {success.artifacts.validation_report ? 'yes' : 'no'}</li>
            <li>idempotency marker: {success.artifacts.idempotency_marker ? 'yes' : 'no'}</li>
          </ul>
        </div>
      )}
    </section>
  );
}
