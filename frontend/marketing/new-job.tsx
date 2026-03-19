"use client";

import React, { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Rocket, Sparkles } from 'lucide-react';

import type { MarketingApiError, PostMarketingJobsRequest } from '@/lib/api/marketing';
import { useMarketingJobCreate, type UseMarketingJobCreateOptions } from '@/hooks/use-marketing-job-create';
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
    <div className="min-h-screen bg-background px-6 py-10 md:px-8 lg:px-10">
      <div className="max-w-7xl mx-auto grid gap-6">
        <div className="glass rounded-[2.5rem] p-8 md:p-10">
          <p className="text-xs uppercase tracking-[0.3em] text-primary mb-3">Aries workflow</p>
          <h1 className="text-4xl font-bold mb-3">Marketing launch</h1>
          <p className="text-white/60">Donor-style workflow layout running directly against the canonical Aries marketing job API.</p>
        </div>

        <div className="grid xl:grid-cols-2 gap-6">
      <div className="glass rounded-[2.5rem] p-8">
        <form onSubmit={onSubmit} className="space-y-6">
          <div>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                <Rocket className="w-6 h-6 text-primary" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-white/35">Brand campaign</p>
                <h1 className="text-3xl font-bold">Launch the canonical marketing job</h1>
              </div>
            </div>
            <p className="text-white/60 leading-relaxed">
              Start a workflow-backed brand campaign using your current workspace context and the URLs that define the brief.
            </p>
          </div>

          <label className="block space-y-2">
            <span className="text-xs uppercase tracking-[0.22em] text-white/35">Brand website URL</span>
            <input
              value={brandUrl}
              onChange={(event) => setBrandUrl(event.target.value)}
              placeholder="https://yourbrand.com"
              required
              className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
            />
          </label>

          <label className="block space-y-2">
            <span className="text-xs uppercase tracking-[0.22em] text-white/35">Competitor Facebook URL</span>
            <input
              value={competitorUrl}
              onChange={(event) => setCompetitorUrl(event.target.value)}
              placeholder="https://facebook.com/competitor"
              required
              className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
            />
          </label>

          <button
            type="submit"
            disabled={submitting}
            className="w-full px-6 py-4 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold shadow-xl shadow-primary/20 disabled:opacity-60"
          >
            {submitting ? 'Starting campaign…' : 'Start brand campaign'}
          </button>

          {errorText ? <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-red-100">{errorText}</div> : null}
        </form>
      </div>

      <div className="glass rounded-[2.5rem] p-8 space-y-6">
        <div>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-2xl bg-secondary/10 border border-secondary/20 flex items-center justify-center">
              <Sparkles className="w-6 h-6 text-secondary" />
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-white/35">Next steps</p>
              <h2 className="text-3xl font-bold">Workflow handoff</h2>
            </div>
          </div>
          <div className="space-y-3">
            {[
              'The browser submits only to the Aries internal route.',
              'Aries launches the real OpenClaw-backed Lobster pipeline server-side.',
              'After launch, you land on the campaign status workspace automatically.',
            ].map((item) => (
              <div key={item} className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 text-white/70">
                {item}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-[1.5rem] border border-white/10 bg-black/25 p-8 min-h-[280px] flex flex-col items-center justify-center text-center">
          <strong className="text-2xl mb-3">{submitting ? 'Launching your campaign...' : 'Ready to launch'}</strong>
          <p className="text-white/60 max-w-md">
            {submitting
              ? 'Aries is starting the campaign and will take you straight to the status workspace.'
              : 'Submit the brief to start the pipeline and move into the operational status view.'}
          </p>
          {submitting ? <div className="mt-5"><StatusBadge status="running" /></div> : null}
        </div>
      </div>
        </div>
      </div>
    </div>
  );
}

export default MarketingNewJobScreen;
