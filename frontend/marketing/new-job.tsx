"use client";

import React, { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import type { MarketingApiError, PostMarketingJobsRequest } from '@/lib/api/marketing';
import { useMarketingJobCreate, type UseMarketingJobCreateOptions } from '@/hooks/use-marketing-job-create';
import { Button } from '@/components/redesign/primitives/button';
import { Card } from '@/components/redesign/primitives/card';
import { TextInput } from '@/components/redesign/primitives/input';
import StatusBadge from '../components/status-badge';

function isErrorResult(value: unknown): value is MarketingApiError {
  return typeof (value as MarketingApiError)?.error === 'string';
}

export interface MarketingNewJobScreenProps {
  clientOptions?: UseMarketingJobCreateOptions;
}

export function MarketingNewJobScreen(props: MarketingNewJobScreenProps) {
  const router = useRouter();
  const marketingCreate = useMarketingJobCreate(props.clientOptions);

  const [brandUrl, setBrandUrl] = useState('');
  const [competitorUrl, setCompetitorUrl] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorText(null);

    const trimmedBrandUrl = brandUrl.trim();
    const trimmedCompetitorUrl = competitorUrl.trim();
    if (!trimmedBrandUrl || !trimmedCompetitorUrl) {
      setErrorText('brandUrl and competitorUrl are required');
      return;
    }

    const request: PostMarketingJobsRequest = {
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
        setErrorText(response.message || response.error);
        return;
      }

      router.push(response.jobStatusUrl ?? `/marketing/job-status?jobId=${encodeURIComponent(response.jobId)}`);
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
              Start a workflow-backed brand campaign using your current workspace context and the URLs that define the brief.
            </p>
          </div>

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
              'Aries launches the real OpenClaw-backed Lobster pipeline server-side.',
              'After launch, you land on the campaign status workspace automatically.',
            ].map((item) => (
              <div key={item} className="rd-glass" style={{ padding: '1rem', borderRadius: '1rem' }}>{item}</div>
            ))}
          </div>

          <div className="rd-empty" style={{ minHeight: '280px' }}>
            <strong>{submitting ? 'Launching your campaign...' : 'Ready to launch'}</strong>
            <p>
              {submitting
                ? 'Aries is starting the campaign and will take you straight to the status workspace.'
                : 'Submit the brief to start the pipeline and move into the operational status view.'}
            </p>
            {submitting ? <StatusBadge status="running" /> : null}
          </div>
        </div>
      </Card>
    </div>
  );
}

export default MarketingNewJobScreen;
