'use client';

import { FormEvent, useMemo, useState } from 'react';

import { createOnboardingClient } from '../api/client/onboarding';
import type { OnboardingStatusError, OnboardingStatusSuccess } from '../api/contracts/onboarding';

type OnboardingStatusResponse = OnboardingStatusSuccess | OnboardingStatusError;

type OnboardingStatusSuccessWithOptionalFields = OnboardingStatusSuccess & {
  repair_status?: string;
  next_step?: string;
  latest_message?: string;
};

export interface OnboardingStatusScreenProps {
  baseUrl?: string;
  initialTenantId?: string;
}

export default function OnboardingStatusScreen({
  baseUrl,
  initialTenantId = ''
}: OnboardingStatusScreenProps): JSX.Element {
  const client = useMemo(() => createOnboardingClient({ baseUrl }), [baseUrl]);

  const [tenantId, setTenantId] = useState(initialTenantId);
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<OnboardingStatusResponse | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const normalizedTenantId = tenantId.trim();
    if (!normalizedTenantId) {
      setRequestError('tenant_id is required');
      setResponse(null);
      return;
    }

    setLoading(true);
    setRequestError(null);
    setResponse(null);

    try {
      const result = await client.status(normalizedTenantId);
      setResponse(result);
    } catch {
      setRequestError('Unable to load onboarding status.');
    } finally {
      setLoading(false);
    }
  }

  const isStatusError = response?.onboarding_status === 'error';
  const success = !isStatusError && response ? (response as OnboardingStatusSuccessWithOptionalFields) : null;

  return (
    <section>
      <h1>Onboarding Status</h1>

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

        <button type="submit" disabled={loading}>
          {loading ? 'Checking…' : 'Check status'}
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
            <strong>onboarding_status:</strong> {success.onboarding_status}
          </p>
          <p>
            <strong>provisioning_status:</strong> {success.provisioning_status}
          </p>
          {success.repair_status && (
            <p>
              <strong>repair_status:</strong> {success.repair_status}
            </p>
          )}
          {success.next_step && (
            <p>
              <strong>next_step:</strong> {success.next_step}
            </p>
          )}
          {success.latest_message && (
            <p>
              <strong>latest_message:</strong> {success.latest_message}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
