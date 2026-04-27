'use client';

import { FormEvent, useEffect, useState } from 'react';
import { Eye, Sparkles } from 'lucide-react';

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
  const tenantNotFound = success?.provisioning_status === 'not_found';

  return (
    <div className="min-h-screen bg-background px-6 py-10 md:px-8 lg:px-10">
      <div className="max-w-7xl mx-auto grid gap-6">
        <div className="glass rounded-[2.5rem] p-8 md:p-10">
          <p className="text-xs uppercase tracking-[0.3em] text-primary mb-3">Aries workflow</p>
          <h1 className="text-4xl font-bold mb-3">Onboarding status</h1>
          <p className="text-white/60">Monitor tenant provisioning through the donor-derived shell while staying on Aries internal status routes.</p>
        </div>

        <div className="grid xl:grid-cols-2 gap-6">
      <div className="glass rounded-[2.5rem] p-8">
        <form onSubmit={onSubmit} className="space-y-5">
          <div>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                <Eye className="w-6 h-6 text-primary" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-white/35">Onboarding status</p>
                <h1 className="text-3xl font-bold">Inspect tenant provisioning progress</h1>
              </div>
            </div>
            <p className="text-white/60 leading-relaxed">
              Query the browser-safe status route with a tenant ID and optional signup event ID to inspect current provisioning and validation state.
            </p>
          </div>

          <label className="block space-y-2">
            <span className="text-xs uppercase tracking-[0.22em] text-white/35">Tenant ID</span>
            <input
              value={tenantId}
              onChange={(event) => setTenantId(event.currentTarget.value)}
              placeholder="tenant_alpha"
              required
              className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
            />
          </label>

          <label className="block space-y-2">
            <span className="text-xs uppercase tracking-[0.22em] text-white/35">Signup Event ID (optional)</span>
            <input
              value={signupEventId}
              onChange={(event) => setSignupEventId(event.currentTarget.value)}
              placeholder="signup_evt_123"
              className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
            />
          </label>

          <button
            type="submit"
            disabled={loading || !tenantId.trim()}
            className="w-full px-6 py-4 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold shadow-xl shadow-primary/20 disabled:opacity-60"
          >
            {loading ? 'Checking status…' : 'Check status'}
          </button>

          {loading ? <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-4 text-cyan-100">Loading onboarding status…</div> : null}
          {onboardingStatus.error ? <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-red-100">{onboardingStatus.error.message}</div> : null}
          {response && isStatusError ? (
            <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-red-100">
              Request failed: {(response as OnboardingStatusError).reason}
            </div>
          ) : null}
        </form>
      </div>

      <div className="glass rounded-[2.5rem] p-8">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-2xl bg-secondary/10 border border-secondary/20 flex items-center justify-center">
            <Sparkles className="w-6 h-6 text-secondary" />
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-white/35">Current state</p>
            <h2 className="text-3xl font-bold">Provisioning snapshot</h2>
          </div>
        </div>

        {!success ? (
          <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-8 text-center text-white/60 min-h-[320px] flex flex-col items-center justify-center">
            <strong className="text-white text-lg mb-2">No onboarding snapshot yet</strong>
            <p>Run a status check to see provisioning state, validation state, and artifact availability.</p>
          </div>
        ) : (
          <div className="space-y-5">
            {tenantNotFound ? (
              <div className="rounded-2xl border border-amber-400/25 bg-amber-400/10 p-4 text-amber-100">
                <strong className="block text-white">Tenant not found</strong>
                <p className="mt-1 text-sm text-amber-100/80">
                  The status request succeeded, but Aries could not find onboarding artifacts for this tenant ID yet.
                </p>
              </div>
            ) : null}
            <div className="space-y-3">
              <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-5 py-4 flex items-center justify-between gap-4">
                <strong>tenant_id</strong>
                <span className="text-white/70 break-all text-right">{success.tenant_id}</span>
              </div>
              <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-5 py-4 flex items-center justify-between gap-4">
                <strong>request_status</strong>
                <span className="text-white/70 text-right">Request succeeded</span>
              </div>
              {tenantNotFound ? (
                <div className="rounded-[1.5rem] border border-amber-400/20 bg-amber-400/10 px-5 py-4 flex items-center justify-between gap-4">
                  <strong>tenant_status</strong>
                  <StatusBadge status="not_found" />
                </div>
              ) : (
                <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-5 py-4 flex items-center justify-between gap-4">
                  <strong>onboarding_status</strong>
                  <StatusBadge status={success.onboarding_status} />
                </div>
              )}
              <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-5 py-4 flex items-center justify-between gap-4">
                <strong>provisioning_status</strong>
                <StatusBadge status={success.provisioning_status} />
              </div>
              <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-5 py-4 flex items-center justify-between gap-4">
                <strong>validation_status</strong>
                <StatusBadge status={success.validation_status} />
              </div>
              <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-5 py-4 flex items-center justify-between gap-4">
                <strong>progress_hint</strong>
                <span className="text-white/70 text-right font-mono text-sm">{success.progress_hint}</span>
              </div>
            </div>

            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-white/35 mb-3">Artifact availability</p>
              <div className="flex flex-wrap gap-3">
                <span className={`px-4 py-2 rounded-full border ${success.artifacts.draft ? 'border-primary/30 bg-primary/15 text-white' : 'border-white/10 bg-white/5 text-white/45'}`}>draft</span>
                <span className={`px-4 py-2 rounded-full border ${success.artifacts.validated ? 'border-primary/30 bg-primary/15 text-white' : 'border-white/10 bg-white/5 text-white/45'}`}>validated</span>
                <span className={`px-4 py-2 rounded-full border ${success.artifacts.validation_report ? 'border-primary/30 bg-primary/15 text-white' : 'border-white/10 bg-white/5 text-white/45'}`}>validation report</span>
                <span className={`px-4 py-2 rounded-full border ${success.artifacts.idempotency_marker ? 'border-primary/30 bg-primary/15 text-white' : 'border-white/10 bg-white/5 text-white/45'}`}>idempotency marker</span>
              </div>
            </div>
          </div>
        )}
      </div>
        </div>
      </div>
    </div>
  );
}
