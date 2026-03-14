"use client";

import React, { useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';

import { createMarketingClient, type MarketingClientOptions } from '../api/client/marketing';
import type { PostMarketingJobsRequest, StartJobAccepted, HardFailureError, UnhandledError } from '../api/contracts/marketing';
import StatusBadge from '../components/status-badge';

type CreateJobResult = StartJobAccepted | HardFailureError | UnhandledError;

function isErrorResult(value: CreateJobResult): value is HardFailureError | UnhandledError {
  return typeof (value as HardFailureError | UnhandledError)?.error === 'string';
}

export interface MarketingNewJobScreenProps {
  clientOptions?: MarketingClientOptions;
}

export function MarketingNewJobScreen(props: MarketingNewJobScreenProps) {
  const client = useMemo(() => createMarketingClient(props.clientOptions), [props.clientOptions]);

  const [tenantId, setTenantId] = useState('');
  const [brandUrl, setBrandUrl] = useState('');
  const [competitorUrl, setCompetitorUrl] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [success, setSuccess] = useState<StartJobAccepted | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorText(null);
    setSuccess(null);

    const trimmedTenantId = tenantId.trim();
    if (!trimmedTenantId) {
      setErrorText('tenantId is required');
      return;
    }

    const trimmedBrandUrl = brandUrl.trim();
    const trimmedCompetitorUrl = competitorUrl.trim();
    if (!trimmedBrandUrl || !trimmedCompetitorUrl) {
      setErrorText('tenantId, brandUrl, and competitorUrl are required');
      return;
    }

    const request: PostMarketingJobsRequest = {
      tenantId: trimmedTenantId,
      jobType: 'brand_campaign',
      payload: {
        brandUrl: trimmedBrandUrl,
        competitorUrl: trimmedCompetitorUrl
      }
    };

    setSubmitting(true);
    try {
      const response = await client.createJob(request);

      if (isErrorResult(response)) {
        setErrorText(response.error);
        return;
      }

      setSuccess(response);
    } catch {
      setErrorText('Failed to create marketing job');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="glass-card max-w-2xl mx-auto p-8 border border-[var(--aries-purple-border)] rounded-2xl bg-[var(--aries-darker-base)] text-[var(--aries-core-text)] shadow-lg shadow-[var(--aries-neon-cyan)]/10">
      <div className="mb-8 border-b border-[var(--aries-core-gray)] pb-6">
        <h1 className="text-3xl font-light mb-2 text-[var(--aries-primary-text)] tracking-tight">Launch Brand Campaign</h1>
        <p className="text-[var(--aries-core-gray)] text-sm">
          This route starts the canonical <code>brand_campaign</code> workflow. Provide the tenant ID, your brand website,
          and a competitor Facebook URL to create a marketing job.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-6">
        <div>
          <label htmlFor="tenantId" className="block text-sm font-medium mb-1.5 text-[var(--aries-core-text)] tracking-wider uppercase text-xs">Tenant ID</label>
          <input
            id="tenantId"
            type="text"
            value={tenantId}
            onChange={(event) => setTenantId(event.target.value)}
            required
            className="w-full bg-[#0F1115] border border-[var(--aries-core-gray)] rounded-lg px-4 py-3 text-[var(--aries-core-text)] focus:outline-none focus:border-[var(--aries-accent)] focus:ring-1 focus:ring-[var(--aries-accent)] transition-colors placeholder:text-[var(--aries-core-gray)]/50"
            placeholder="tenant_123"
          />
        </div>

        <div>
          <label htmlFor="brandUrl" className="block text-sm font-medium mb-1.5 text-[var(--aries-core-text)] tracking-wider uppercase text-xs">Brand Website URL</label>
          <input
            id="brandUrl"
            type="url"
            value={brandUrl}
            onChange={(event) => setBrandUrl(event.target.value)}
            required
            className="w-full bg-[#0F1115] border border-[var(--aries-core-gray)] rounded-lg px-4 py-3 text-[var(--aries-core-text)] focus:outline-none focus:border-[var(--aries-accent)] focus:ring-1 focus:ring-[var(--aries-accent)] transition-colors placeholder:text-[var(--aries-core-gray)]/50"
            placeholder="https://yourbrand.com"
          />
        </div>

        <div>
          <label htmlFor="competitorUrl" className="block text-sm font-medium mb-1.5 text-[var(--aries-core-text)] tracking-wider uppercase text-xs">Competitor Facebook URL</label>
          <input
            id="competitorUrl"
            type="url"
            value={competitorUrl}
            onChange={(event) => setCompetitorUrl(event.target.value)}
            required
            className="w-full bg-[#0F1115] border border-[var(--aries-core-gray)] rounded-lg px-4 py-3 text-[var(--aries-core-text)] focus:outline-none focus:border-[var(--aries-accent)] focus:ring-1 focus:ring-[var(--aries-accent)] transition-colors placeholder:text-[var(--aries-core-gray)]/50"
            placeholder="https://facebook.com/competitor"
          />
        </div>

        <div className="pt-4">
          <button
            type="submit"
            disabled={submitting}
            className="w-full neon-button bg-[var(--aries-brand-deep)] hover:bg-[var(--aries-brand-cyan)] text-[var(--aries-primary-text)] font-medium rounded-lg px-6 py-3.5 transition-all outline-none focus:ring-2 focus:ring-[var(--aries-brand-cyan)] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {submitting ? 'Starting Campaign…' : 'Start Brand Campaign'}
          </button>
        </div>
      </form>

      {errorText ? (
        <div className="mt-6 p-4 rounded-lg bg-red-900/20 border border-red-500/30 text-red-200 text-sm" role="alert">
          {errorText}
        </div>
      ) : null}

      {success ? (
        <div className="mt-8 p-6 rounded-xl border border-[var(--aries-neon-cyan)]/30 bg-[var(--aries-brand-cyan)]/5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-[var(--aries-neon-cyan)]/20 flex items-center justify-center text-[var(--aries-neon-cyan)]">✓</div>
              <h3 className="font-medium text-[var(--aries-primary-text)]">Brand Campaign Accepted</h3>
            </div>
            <StatusBadge status="accepted" />
          </div>

          <p className="text-sm text-[var(--aries-core-gray)] mb-6">
            Job Reference: <span className="font-mono text-[var(--aries-brand-deep)] ml-1">{success.jobId}</span>
          </p>

          <div className="flex gap-4">
            <Link
              href={`/marketing/job-status?jobId=${encodeURIComponent(success.jobId)}`}
              className="flex-1 text-center py-2.5 px-4 rounded-lg border border-[var(--aries-core-gray)] hover:border-[var(--aries-primary-text)] hover:bg-[var(--aries-core-gray)]/10 transition-colors text-sm font-medium"
            >
              Monitor Status
            </Link>
            <Link
              href={`/marketing/job-approve?jobId=${encodeURIComponent(success.jobId)}&tenantId=${encodeURIComponent(success.tenantId)}`}
              className="flex-1 text-center py-2.5 px-4 rounded-lg bg-[var(--aries-core-text)] text-[var(--aries-darker-base)] hover:bg-[var(--aries-primary-text)] transition-colors text-sm font-medium"
            >
              Approval Dashboard
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default MarketingNewJobScreen;
