"use client";

import React, { useState, type FormEvent } from 'react';
import Link from 'next/link';

import type {
  MarketingApiError,
  PostMarketingJobsRequest,
  StartJobAccepted,
} from '@/lib/api/marketing';
import { useMarketingJobCreate, type UseMarketingJobCreateOptions } from '@/hooks/use-marketing-job-create';
import { Button } from '@/components/redesign/primitives/button';
import { Card } from '@/components/redesign/primitives/card';
import { TextInput } from '@/components/redesign/primitives/input';
import StatusBadge from '../components/status-badge';

type CreateJobResult = StartJobAccepted | MarketingApiError;

function isErrorResult(value: CreateJobResult): value is MarketingApiError {
  return typeof (value as MarketingApiError)?.error === 'string';
}

export interface MarketingNewJobScreenProps {
  clientOptions?: UseMarketingJobCreateOptions;
}

export function MarketingNewJobScreen(props: MarketingNewJobScreenProps) {
  const marketingCreate = useMarketingJobCreate(props.clientOptions);

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
      const response = await marketingCreate.createJob(request);
      if (!response) {
        setErrorText('Failed to create marketing job');
        return;
      }

      if (isErrorResult(response)) {
        setErrorText(response.error);
        return;
      }

      setSuccess(response);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rd-workflow-grid rd-workflow-grid--2">
      <Card>
        <form onSubmit={onSubmit} style={{ display: 'grid', gap: '1rem' }}>
          <div>
            <p className="rd-section-label">Brand campaign</p>
            <h1 style={{ margin: '0.8rem 0 0.5rem', fontFamily: 'var(--rd-font-display)', fontSize: '2rem' }}>
              Launch the canonical marketing job
            </h1>
            <p className="rd-section-description">
              Provide the tenant ID, primary brand URL, and competitor reference URL to create the workflow-backed campaign job.
            </p>
          </div>

          <label className="rd-field">
            <span className="rd-label">Tenant ID</span>
            <TextInput value={tenantId} onChange={(event) => setTenantId(event.target.value)} placeholder="tenant_123" required />
          </label>

          <label className="rd-field">
            <span className="rd-label">Brand website URL</span>
            <TextInput value={brandUrl} onChange={(event) => setBrandUrl(event.target.value)} placeholder="https://yourbrand.com" required />
          </label>

          <label className="rd-field">
            <span className="rd-label">Competitor Facebook URL</span>
            <TextInput value={competitorUrl} onChange={(event) => setCompetitorUrl(event.target.value)} placeholder="https://facebook.com/competitor" required />
          </label>

          <Button type="submit" disabled={submitting}>
            {submitting ? 'Starting campaign…' : 'Start brand campaign'}
          </Button>

          {errorText ? <div className="rd-alert rd-alert--danger">{errorText}</div> : null}
        </form>
      </Card>

      <Card>
        <div style={{ display: 'grid', gap: '1rem' }}>
          <p className="rd-section-label">Next steps</p>
          <h2 style={{ margin: '0.8rem 0 0.5rem', fontFamily: 'var(--rd-font-display)', fontSize: '1.6rem' }}>
            Workflow handoff
          </h2>
          <div className="rd-summary-list">
            {[
              'The browser submits only to the Aries internal route.',
              'Aries starts the campaign through the OpenClaw gateway.',
              'You can follow state changes from the status and approval screens.',
            ].map((item) => (
              <div key={item} className="rd-glass" style={{ padding: '1rem', borderRadius: '1rem' }}>{item}</div>
            ))}
          </div>

          {success ? (
            <div className="rd-alert rd-alert--success">
              <div style={{ display: 'grid', gap: '0.75rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                  <strong>Brand campaign accepted</strong>
                  <StatusBadge status="accepted" />
                </div>
                <code>{success.jobId}</code>
                <div className="rd-inline-actions">
                  <Link href={`/marketing/job-status?jobId=${encodeURIComponent(success.jobId)}`} className="rd-button rd-button--secondary">
                    Monitor status
                  </Link>
                  <Link
                    href={`/marketing/job-approve?jobId=${encodeURIComponent(success.jobId)}&tenantId=${encodeURIComponent(success.tenantId)}`}
                    className="rd-button rd-button--ghost"
                  >
                    Approval dashboard
                  </Link>
                </div>
              </div>
            </div>
          ) : (
            <div className="rd-empty" style={{ minHeight: '280px' }}>
              <strong>No active campaign yet</strong>
              <p>Submitting the form will create a new job and surface its job ID here.</p>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

export default MarketingNewJobScreen;
