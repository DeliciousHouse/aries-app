"use client";

import React, { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, FileUp, LoaderCircle, Rocket, Sparkles } from 'lucide-react';

import type { MarketingApiError } from '@/lib/api/marketing';
import { isValidWebsiteUrl } from '@/lib/api/marketing';
import { validateCanonicalCompetitorUrl } from '@/lib/marketing-competitor';
import { useMarketingJobCreate, type UseMarketingJobCreateOptions } from '@/hooks/use-marketing-job-create';
import StatusBadge from '../components/status-badge';

function isErrorResult(value: unknown): value is MarketingApiError {
  return typeof (value as MarketingApiError)?.error === 'string';
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export interface MarketingNewJobScreenProps {
  clientOptions?: UseMarketingJobCreateOptions;
  embedded?: boolean;
  redirectMode?: 'status' | 'dashboard';
}

const SUBMIT_PROGRESS_MESSAGES = [
  'Saving brief',
  'Uploading brand assets',
  'Preparing workspace',
  'Starting review flow',
  'Starting campaign',
];

const FINAL_SUBMIT_PROGRESS_INDEX = SUBMIT_PROGRESS_MESSAGES.length - 1;

export function MarketingNewJobScreen(props: MarketingNewJobScreenProps) {
  const router = useRouter();
  const marketingCreate = useMarketingJobCreate(props.clientOptions);

  const [websiteUrl, setWebsiteUrl] = useState('');
  const [brandVoice, setBrandVoice] = useState('');
  const [styleVibe, setStyleVibe] = useState('');
  const [visualReferences, setVisualReferences] = useState('');
  const [mustUseCopy, setMustUseCopy] = useState('');
  const [mustAvoidAesthetics, setMustAvoidAesthetics] = useState('');
  const [notes, setNotes] = useState('');
  const [competitorUrl, setCompetitorUrl] = useState('');
  const [brandAssets, setBrandAssets] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitProgress, setSubmitProgress] = useState({ stepIndex: 0, dotCount: 0 });
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    if (!submitting) {
      setSubmitProgress({ stepIndex: 0, dotCount: 0 });
      return;
    }

    const intervalId = window.setInterval(() => {
      setSubmitProgress((current) => {
        if (current.stepIndex < FINAL_SUBMIT_PROGRESS_INDEX) {
          return { stepIndex: current.stepIndex + 1, dotCount: 0 };
        }

        return {
          stepIndex: current.stepIndex,
          dotCount: (current.dotCount % 3) + 1,
        };
      });
    }, 1300);

    return () => window.clearInterval(intervalId);
  }, [submitting]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorText(null);

    const trimmedWebsiteUrl = websiteUrl.trim();
    if (!trimmedWebsiteUrl) {
      setErrorText('website URL is required');
      return;
    }
    if (!isValidWebsiteUrl(trimmedWebsiteUrl)) {
      setErrorText('Website URL must look like https://example.com');
      return;
    }

    const formData = new FormData();
    formData.set('jobType', 'brand_campaign');
    formData.set('brandUrl', trimmedWebsiteUrl);
    formData.set('websiteUrl', trimmedWebsiteUrl);
    const trimmedCompetitorUrl = competitorUrl.trim();
    if (trimmedCompetitorUrl) {
      const validation = validateCanonicalCompetitorUrl(trimmedCompetitorUrl);
      if (validation.error) {
        setErrorText(validation.error);
        return;
      }
      formData.set('competitorUrl', validation.normalized ?? trimmedCompetitorUrl);
    }
    if (brandVoice.trim()) {
      formData.set('brandVoice', brandVoice.trim());
    }
    if (styleVibe.trim()) {
      formData.set('styleVibe', styleVibe.trim());
    }
    for (const entry of splitLines(visualReferences)) {
      formData.append('visualReferences', entry);
    }
    if (mustUseCopy.trim()) {
      formData.set('mustUseCopy', mustUseCopy.trim());
    }
    if (mustAvoidAesthetics.trim()) {
      formData.set('mustAvoidAesthetics', mustAvoidAesthetics.trim());
    }
    if (notes.trim()) {
      formData.set('notes', notes.trim());
    }
    for (const file of brandAssets) {
      formData.append('brandAssets', file);
    }

    setSubmitting(true);
    let shouldResetSubmitting = true;
    try {
      const response = await marketingCreate.createJob(formData);
      if (!response) {
        setErrorText(
          marketingCreate.error?.message || 'Failed to create marketing job'
        );
        return;
      }

      if (isErrorResult(response)) {
        setErrorText(response.message || response.error);
        return;
      }

      if (props.redirectMode === 'dashboard') {
        setSubmitProgress({ stepIndex: FINAL_SUBMIT_PROGRESS_INDEX, dotCount: 1 });
        shouldResetSubmitting = false;
        router.push(`/dashboard/campaigns/${encodeURIComponent(response.jobId)}?view=brand`);
        return;
      }

      setSubmitProgress({ stepIndex: FINAL_SUBMIT_PROGRESS_INDEX, dotCount: 1 });
      shouldResetSubmitting = false;
      router.push(response.jobStatusUrl ?? `/marketing/job-status?jobId=${encodeURIComponent(response.jobId)}`);
    } finally {
      if (shouldResetSubmitting) {
        setSubmitting(false);
      }
    }
  }

  const wrapperClassName = props.embedded
    ? 'space-y-6'
    : 'min-h-screen bg-background px-6 py-10 md:px-8 lg:px-10';
  const contentClassName = props.embedded ? 'grid gap-6' : 'max-w-7xl mx-auto grid gap-6';
  const isFinalSubmitMessage = submitting && submitProgress.stepIndex === FINAL_SUBMIT_PROGRESS_INDEX;
  const submitButtonLabel = submitting
    ? `${SUBMIT_PROGRESS_MESSAGES[submitProgress.stepIndex]}${isFinalSubmitMessage ? '.'.repeat(Math.max(submitProgress.dotCount, 1)) : ''}`
    : 'Start campaign';

  return (
    <div className={wrapperClassName}>
      <div className={contentClassName}>
        <div className="glass rounded-[2.5rem] p-8 md:p-10">
          <p className="mb-3 text-xs uppercase tracking-[0.3em] text-primary">Aries workflow</p>
          <h1 className="mb-3 text-4xl font-bold">New Campaign</h1>
          <p className="text-white/60">
            Create a real campaign brief with brand inputs, review constraints, and uploads that persist into the campaign workspace.
          </p>
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="glass rounded-[2.5rem] p-8">
            <form onSubmit={onSubmit} className="space-y-6">
              <div>
                <div className="mb-4 flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10">
                    <Rocket className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.24em] text-white/35">Campaign intake</p>
                    <h2 className="text-3xl font-bold">Capture the brief once</h2>
                  </div>
                </div>
                <p className="text-white/60 leading-relaxed">
                  Aries uses this brief as the user-visible source of truth for brand review, strategy review, creative review, and publish gating.
                </p>
              </div>

              <Field label="Website URL" required>
                <input
                  value={websiteUrl}
                  onChange={(event) => setWebsiteUrl(event.target.value)}
                  placeholder="https://yourbrand.com"
                  required
                  aria-invalid={marketingCreate.fieldErrors?.websiteUrl ? true : undefined}
                  aria-describedby={marketingCreate.fieldErrors?.websiteUrl ? 'website-url-error' : undefined}
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
                {marketingCreate.fieldErrors?.websiteUrl ? (
                  <p id="website-url-error" className="mt-2 text-sm text-red-300">
                    {marketingCreate.fieldErrors.websiteUrl}
                  </p>
                ) : null}
              </Field>

              <Field label="Brand voice">
                <textarea
                  value={brandVoice}
                  onChange={(event) => setBrandVoice(event.target.value)}
                  rows={3}
                  placeholder="Proof-led, practical, calm, founder-close..."
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
              </Field>

              <Field label="Style / vibe">
                <textarea
                  value={styleVibe}
                  onChange={(event) => setStyleVibe(event.target.value)}
                  rows={3}
                  placeholder="Editorial, warm neutrals, tactile photography, understated luxury..."
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
              </Field>

              <Field label="Visual references">
                <textarea
                  value={visualReferences}
                  onChange={(event) => setVisualReferences(event.target.value)}
                  rows={4}
                  placeholder="Paste one reference per line"
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
              </Field>

              <Field label="Logo uploads / brand assets">
                <label className="flex cursor-pointer flex-col gap-3 rounded-[1.75rem] border border-dashed border-white/15 bg-white/[0.03] px-5 py-5 text-white/70 transition hover:border-white/25 hover:text-white">
                  <span className="inline-flex items-center gap-2 text-sm font-medium">
                    <FileUp className="h-4 w-4" />
                    Add brand files
                  </span>
                  <span className="text-sm text-white/50">Upload logos, lockups, style guides, or other source assets.</span>
                  <input
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(event) => setBrandAssets(Array.from(event.target.files || []))}
                  />
                </label>
                {brandAssets.length > 0 ? (
                  <div className="rounded-[1.5rem] border border-white/10 bg-black/20 px-4 py-4 text-sm text-white/70">
                    {brandAssets.map((file) => (
                      <div key={`${file.name}-${file.size}`} className="truncate">
                        {file.name}
                      </div>
                    ))}
                  </div>
                ) : null}
              </Field>

              <Field label="Must-use copy">
                <textarea
                  value={mustUseCopy}
                  onChange={(event) => setMustUseCopy(event.target.value)}
                  rows={3}
                  placeholder="Required phrases, legal copy, CTA language..."
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
              </Field>

              <Field label="Must-avoid aesthetics">
                <textarea
                  value={mustAvoidAesthetics}
                  onChange={(event) => setMustAvoidAesthetics(event.target.value)}
                  rows={3}
                  placeholder="Avoid loud gradients, stock-smile imagery, crowded layouts..."
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
              </Field>

              <Field label="Extra notes / instructions">
                <textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  rows={4}
                  placeholder="Anything the team should know before analysis or production begins"
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
              </Field>

              <Field label="Competitor website URL">
                <input
                  value={competitorUrl}
                  onChange={(event) => setCompetitorUrl(event.target.value)}
                  placeholder="Optional competitor website, e.g. https://competitor.com"
                  aria-invalid={marketingCreate.fieldErrors?.competitorUrl ? true : undefined}
                  aria-describedby={marketingCreate.fieldErrors?.competitorUrl ? 'competitor-url-error' : undefined}
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                />
                {marketingCreate.fieldErrors?.competitorUrl ? (
                  <p id="competitor-url-error" className="mt-2 text-sm text-red-300">
                    {marketingCreate.fieldErrors.competitorUrl}
                  </p>
                ) : null}
                <p className="mt-2 text-sm text-white/45">
                  Enter the competitor&apos;s website. Do not paste a Facebook page or Meta Ad Library URL here.
                </p>
              </Field>

              <button
                type="submit"
                disabled={submitting || !isValidWebsiteUrl(websiteUrl)}
                className="w-full rounded-full bg-gradient-to-r from-primary to-secondary px-6 py-4 text-white font-semibold shadow-xl shadow-primary/20 disabled:opacity-60 disabled:cursor-not-allowed"
                aria-describedby={!isValidWebsiteUrl(websiteUrl) && !submitting ? 'start-campaign-hint' : undefined}
              >
                <span className="inline-flex items-center justify-center gap-2">
                  {submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
                  {submitButtonLabel}
                </span>
              </button>
              {!isValidWebsiteUrl(websiteUrl) && !submitting && (
                <p id="start-campaign-hint" className="mt-2 text-center text-xs text-white/45">
                  {websiteUrl.trim()
                    ? 'Enter a valid URL like https://example.com to start the campaign.'
                    : 'Enter a website URL to start the campaign.'}
                </p>
              )}

              {errorText ? (
                <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-red-100">{errorText}</div>
              ) : null}
            </form>
          </div>

          <div className="glass rounded-[2.5rem] p-8 space-y-6">
            <div>
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-secondary/20 bg-secondary/10">
                  <Sparkles className="h-6 w-6 text-secondary" />
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.24em] text-white/35">What happens next</p>
                  <h2 className="text-3xl font-bold">Review-first flow</h2>
                </div>
              </div>
              <div className="space-y-3">
                {[
                  'Website brand analysis and uploaded assets feed the brand review.',
                  'Strategy output is surfaced in a readable proposal with comments and approval state.',
                  'Creative assets stay review-gated per asset until every required approval is complete.',
                  'Publish remains blocked until the workflow is explicitly approved.',
                ].map((item) => (
                  <div key={item} className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 text-white/70">
                    {item}
                  </div>
                ))}
              </div>
            </div>

            <div className="min-h-[280px] rounded-[1.5rem] border border-white/10 bg-black/25 p-8 flex flex-col items-center justify-center text-center">
              <strong className="mb-3 text-2xl">{submitting ? 'Creating your campaign...' : 'Ready to review for real'}</strong>
              <p className="max-w-md text-white/60">
                {submitting
                  ? 'Aries is saving the brief, storing brand assets, and preparing the campaign workspace.'
                  : 'When this launches, the next stop is the actual campaign workspace with brand review, strategy review, creative review, and publish status.'}
              </p>
              {submitting ? (
                <div className="mt-5">
                  <StatusBadge status="running" />
                </div>
              ) : (
                <div className="mt-5 inline-flex items-center gap-2 text-sm text-white/55">
                  Review-gated workflow
                  <ArrowRight className="h-4 w-4" />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field(props: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="text-xs uppercase tracking-[0.22em] text-white/35">
        {props.label}
        {props.required ? ' *' : ''}
      </span>
      {props.children}
    </label>
  );
}

export default MarketingNewJobScreen;
