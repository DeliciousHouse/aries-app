'use client';

import { FormEvent, useEffect, useState } from 'react';

import type { OnboardingStatusError, OnboardingStatusSuccess } from '@/lib/api/onboarding';
import { useOnboardingStatus } from '@/hooks/use-onboarding-status';
import { Button } from '@/components/redesign/primitives/button';
import { Card } from '@/components/redesign/primitives/card';
import { TextInput } from '@/components/redesign/primitives/input';
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
    <div className="rd-workflow-grid rd-workflow-grid--2">
      <Card>
        <form onSubmit={onSubmit} style={{ display: 'grid', gap: '1rem' }}>
          <div>
            <p className="rd-section-label">Onboarding status</p>
            <h1 style={{ margin: '0.8rem 0 0.5rem', fontFamily: 'var(--rd-font-display)', fontSize: '2rem' }}>
              Inspect tenant provisioning progress
            </h1>
            <p className="rd-section-description">
              Query the browser-safe status route with a tenant ID and optional signup event ID to inspect current provisioning and validation state.
            </p>
          </div>

          <label className="rd-field">
            <span className="rd-label">Tenant ID</span>
            <TextInput value={tenantId} onChange={(e) => setTenantId(e.currentTarget.value)} placeholder="tenant_alpha" required />
          </label>

          <label className="rd-field">
            <span className="rd-label">Signup Event ID (optional)</span>
            <TextInput value={signupEventId} onChange={(e) => setSignupEventId(e.currentTarget.value)} placeholder="signup_evt_123" />
          </label>

          <Button type="submit" disabled={loading || !tenantId.trim()}>
            {loading ? 'Checking status…' : 'Check status'}
          </Button>

          {loading ? <div className="rd-alert rd-alert--info">Loading onboarding status…</div> : null}
          {onboardingStatus.error ? <div className="rd-alert rd-alert--danger">{onboardingStatus.error.message}</div> : null}
          {response && isStatusError ? (
            <div className="rd-alert rd-alert--danger">
              Request failed: {(response as OnboardingStatusError).reason}
            </div>
          ) : null}
        </form>
      </Card>

      <Card>
        <div style={{ display: 'grid', gap: '1rem' }}>
          <p className="rd-section-label">Current state</p>

          {!success ? (
            <div className="rd-empty" style={{ minHeight: '320px' }}>
              <strong>No onboarding snapshot yet</strong>
              <p>Run a status check to see provisioning state, validation state, and artifact availability.</p>
            </div>
          ) : (
            <>
              <div className="rd-summary-list">
                <div className="rd-summary-row"><strong>tenant_id</strong><span>{success.tenant_id}</span></div>
                <div className="rd-summary-row"><strong>onboarding_status</strong><StatusBadge status={success.onboarding_status} /></div>
                <div className="rd-summary-row"><strong>provisioning_status</strong><StatusBadge status={success.provisioning_status} /></div>
                <div className="rd-summary-row"><strong>validation_status</strong><StatusBadge status={success.validation_status} /></div>
                <div className="rd-summary-row"><strong>progress_hint</strong><span>{success.progress_hint}</span></div>
              </div>

              <div>
                <p className="rd-label" style={{ marginBottom: '0.75rem' }}>Available artifacts</p>
                <div className="rd-chip-group">
                  <span className="rd-chip" data-active={success.artifacts.draft}>draft</span>
                  <span className="rd-chip" data-active={success.artifacts.validated}>validated</span>
                  <span className="rd-chip" data-active={success.artifacts.validation_report}>validation report</span>
                  <span className="rd-chip" data-active={success.artifacts.idempotency_marker}>idempotency marker</span>
                </div>
              </div>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
