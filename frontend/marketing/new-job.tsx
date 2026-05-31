"use client";

import React, { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, FileUp, LoaderCircle, Rocket, Sparkles } from 'lucide-react';

import type { MarketingApiError } from '@/lib/api/marketing';
import { isValidWebsiteUrl } from '@/lib/api/marketing';
import { validateCanonicalCompetitorUrl } from '@/lib/marketing-competitor';
import { useMarketingJobCreate, type UseMarketingJobCreateOptions } from '@/hooks/use-marketing-job-create';
import StatusBadge from '../components/status-badge';
import { MonthDayPicker } from './month-day-picker';

function isErrorResult(value: unknown): value is MarketingApiError {
  return typeof (value as MarketingApiError)?.error === 'string';
}

export function normalizeWebsiteUrlInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
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

export interface MarketingNewJobScreenContentProps extends MarketingNewJobScreenProps {
  router: {
    push: (href: string) => void;
  };
}

const SUBMIT_PROGRESS_MESSAGES = [
  'Saving brief',
  'Uploading brand assets',
  'Preparing workspace',
  'Starting review flow',
  'Starting social content run',
];

const FINAL_SUBMIT_PROGRESS_INDEX = SUBMIT_PROGRESS_MESSAGES.length - 1;

export function MarketingNewJobScreenContent(props: MarketingNewJobScreenContentProps) {
  const router = props.router;
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
  // Client-side validation errors keyed by the same `oneOff.*` keys the server
  // returns from a 422. Merged with marketingCreate.fieldErrors at render time
  // so the inline red error appears under each missing field instead of
  // collapsing into a single top-level alert.
  const [clientFieldErrors, setClientFieldErrors] = useState<Record<string, string>>({});
  // One-off campaigns. Default 'weekly' so the existing flow is untouched for
  // tenants who do not opt in. Switching to 'oneOff' reveals the required
  // campaign-name + end-date + CTA inputs plus optional milestoneDate +
  // milestoneLabel for any kind of one-off (sale, launch, webinar, hackathon,
  // fundraiser). Submit handler sends jobType=one_off_campaign and appends
  // oneOff.* form fields the server converts to UTC.
  const [jobMode, setJobMode] = useState<'weekly' | 'oneOff'>('weekly');
  const [oneOffName, setOneOffName] = useState('');
  const [campaignEndDate, setCampaignEndDate] = useState('');
  const [oneOffCta, setOneOffCta] = useState('');
  const [milestoneDate, setMilestoneDate] = useState('');
  const [milestoneLabel, setMilestoneLabel] = useState('');

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

  useEffect(() => {
    if (marketingCreate.error?.message) {
      setErrorText(marketingCreate.error.message);
    }
  }, [marketingCreate.error]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorText(null);

    const trimmedWebsiteUrl = normalizeWebsiteUrlInput(websiteUrl);
    if (!trimmedWebsiteUrl) {
      setErrorText('website URL is required');
      return;
    }
    if (!isValidWebsiteUrl(trimmedWebsiteUrl)) {
      setErrorText('Website URL must look like https://example.com');
      return;
    }

    // One-off mode: name + campaign end date + CTA are required; milestone
    // date + label are optional but paired. Aggregate every failing field
    // into the same `oneOff.*` keyed shape the server returns from a 422 so
    // every missing field gets an inline red error -- not a single top-level
    // alert that hides which fields the operator needs to fill in. The
    // server re-checks shape and ordering so a malicious or scripted POST
    // cannot bypass these rules.
    setClientFieldErrors({});
    if (jobMode === 'oneOff') {
      const trimmedOneOffName = oneOffName.trim();
      const trimmedCampaignEndDate = campaignEndDate.trim();
      const trimmedOneOffCta = oneOffCta.trim();
      const trimmedMilestoneDate = milestoneDate.trim();
      const trimmedMilestoneLabel = milestoneLabel.trim();
      const errors: Record<string, string> = {};
      if (!trimmedOneOffName) errors['oneOff.name'] = 'Name is required.';
      if (!trimmedCampaignEndDate) errors['oneOff.campaignEndDate'] = 'End date is required.';
      if (!trimmedOneOffCta) errors['oneOff.cta'] = 'CTA is required.';
      if (trimmedMilestoneDate && !trimmedMilestoneLabel) {
        errors['oneOff.milestoneLabel'] = 'Add a label for this date (e.g. "Sale ends" or "Doors open").';
      }
      if (trimmedMilestoneLabel && !trimmedMilestoneDate) {
        errors['oneOff.milestoneDate'] = 'Pick the date this label refers to.';
      }
      if (trimmedMilestoneDate && trimmedMilestoneDate > trimmedCampaignEndDate) {
        errors['oneOff.milestoneDate'] = 'Milestone date must be on or before the end date.';
      }
      if (Object.keys(errors).length > 0) {
        setClientFieldErrors(errors);
        return;
      }
    }

    const formData = new FormData();
    formData.set('jobType', jobMode === 'oneOff' ? 'one_off_campaign' : 'weekly_social_content');
    formData.set('brandUrl', trimmedWebsiteUrl);
    formData.set('websiteUrl', trimmedWebsiteUrl);
    if (jobMode === 'oneOff') {
      // oneOff.* keys are the contract the server's parseCreateJobRequest
      // reads via extractOneOffPayloadFromForm; the server converts the
      // YYYY-MM-DD dates to tenant-local end-of-day UTC ISO strings before
      // they reach the runtime document.
      formData.set('oneOff.name', oneOffName.trim());
      formData.set('oneOff.campaignEndDate', campaignEndDate.trim());
      formData.set('oneOff.cta', oneOffCta.trim());
      if (milestoneDate.trim()) {
        formData.set('oneOff.milestoneDate', milestoneDate.trim());
      }
      if (milestoneLabel.trim()) {
        formData.set('oneOff.milestoneLabel', milestoneLabel.trim());
      }
    }
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
        router.push(`/dashboard/social-content/${encodeURIComponent(response.jobId)}?view=brand`);
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
    : 'Start social content';
  const normalizedWebsiteUrl = normalizeWebsiteUrlInput(websiteUrl);
  const websiteUrlIsValid = isValidWebsiteUrl(normalizedWebsiteUrl);
  // Unified field-error lookup. Client-side errors (set synchronously on
  // submit) take precedence so the operator sees inline feedback before any
  // network round trip; server-side errors (from 422) fill in the same shape
  // after a POST. Both keyspaces are 'oneOff.<fieldName>' to match what the
  // server returns.
  const oneOffFieldError = (key: string): string | undefined =>
    clientFieldErrors[key] ?? marketingCreate.fieldErrors?.[key];

  return (
    <div className={wrapperClassName}>
      <div className={contentClassName}>
        <div className="glass rounded-[2.5rem] p-8 md:p-10">
          <p className="mb-3 text-xs uppercase tracking-[0.3em] text-primary">Aries workflow</p>
          <h2 className="mb-3 text-4xl font-bold">New Social Content</h2>
          <p className="text-white/60">
            Create a real social content brief with brand inputs, review constraints, and uploads that persist into the post workspace.
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
                    <p className="text-xs uppercase tracking-[0.24em] text-white/70">Content intake</p>
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
                  onBlur={() => setWebsiteUrl(normalizeWebsiteUrlInput(websiteUrl))}
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
                <p className="mt-2 text-sm text-white/70">
                  Enter the competitor&apos;s website. Do not paste a Facebook page or Meta Ad Library URL here.
                </p>
              </Field>

              <Field label="Content type">
                <div role="radiogroup" aria-label="Content type" className="flex gap-2">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={jobMode === 'weekly'}
                    onClick={() => setJobMode('weekly')}
                    className={`flex-1 rounded-2xl border px-4 py-3 text-left transition ${
                      jobMode === 'weekly'
                        ? 'border-primary bg-primary/15 text-white'
                        : 'border-white/10 bg-white/5 text-white/70 hover:border-white/30'
                    }`}
                  >
                    <div className="text-sm font-semibold">Weekly social content</div>
                    <div className="mt-1 text-xs text-white/50">Recurring brand pieces, no end date</div>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={jobMode === 'oneOff'}
                    onClick={() => setJobMode('oneOff')}
                    className={`flex-1 rounded-2xl border px-4 py-3 text-left transition ${
                      jobMode === 'oneOff'
                        ? 'border-primary bg-primary/15 text-white'
                        : 'border-white/10 bg-white/5 text-white/70 hover:border-white/30'
                    }`}
                  >
                    <div className="text-sm font-semibold">One-off post</div>
                    <div className="mt-1 text-xs text-white/50">Sale, launch, webinar, hackathon. Auto-stops on the end date.</div>
                  </button>
                </div>
              </Field>

              {jobMode === 'oneOff' ? (
                <div className="space-y-6 rounded-2xl border border-primary/20 bg-primary/5 p-5">
                  <p className="text-sm text-white/70">
                    Aries drives copy toward your end date and stops publishing once it passes. Dates are interpreted in your business timezone (end of day).
                  </p>
                  <Field label="Post name" required>
                    <input
                      value={oneOffName}
                      onChange={(e) => setOneOffName(e.target.value)}
                      placeholder='e.g. "Summer flash sale" or "Aries AI Hackathon"'
                      aria-invalid={oneOffFieldError('oneOff.name') ? true : undefined}
                      className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                    />
                    {oneOffFieldError('oneOff.name') ? (
                      <p className="mt-2 text-sm text-red-300">{oneOffFieldError('oneOff.name')}</p>
                    ) : null}
                  </Field>
                  <Field label="Post end date" required>
                    <MonthDayPicker
                      value={campaignEndDate}
                      onChange={setCampaignEndDate}
                      ariaLabel="Post end date"
                      invalid={!!oneOffFieldError('oneOff.campaignEndDate')}
                    />
                    <p className="mt-2 text-xs text-white/70">Aries stops publishing past end-of-day in your timezone.</p>
                    {oneOffFieldError('oneOff.campaignEndDate') ? (
                      <p className="mt-2 text-sm text-red-300">{oneOffFieldError('oneOff.campaignEndDate')}</p>
                    ) : null}
                  </Field>
                  <Field label="Call to action" required>
                    <input
                      value={oneOffCta}
                      onChange={(e) => setOneOffCta(e.target.value)}
                      placeholder='e.g. "Shop the sale" or "Register at example.com/event"'
                      aria-invalid={oneOffFieldError('oneOff.cta') ? true : undefined}
                      className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                    />
                    {oneOffFieldError('oneOff.cta') ? (
                      <p className="mt-2 text-sm text-red-300">{oneOffFieldError('oneOff.cta')}</p>
                    ) : null}
                  </Field>

                  <div className="border-t border-white/10 pt-5">
                    <p className="text-sm text-white/60 mb-3">
                      Optional key date Aries can reference in copy. Label it however fits your post &mdash; &ldquo;Sale ends&rdquo;, &ldquo;Doors open&rdquo;, &ldquo;Registration deadline&rdquo;, &ldquo;Launch day&rdquo;.
                    </p>
                    <div className="grid sm:grid-cols-2 gap-4">
                      <Field label="Milestone label">
                        <input
                          value={milestoneLabel}
                          onChange={(e) => setMilestoneLabel(e.target.value)}
                          placeholder='e.g. "Sale ends"'
                          aria-invalid={oneOffFieldError('oneOff.milestoneLabel') ? true : undefined}
                          className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
                        />
                        {oneOffFieldError('oneOff.milestoneLabel') ? (
                          <p className="mt-2 text-sm text-red-300">{oneOffFieldError('oneOff.milestoneLabel')}</p>
                        ) : null}
                      </Field>
                      <Field label="Milestone date">
                        <MonthDayPicker
                          value={milestoneDate}
                          onChange={setMilestoneDate}
                          ariaLabel="Milestone date"
                          invalid={!!oneOffFieldError('oneOff.milestoneDate')}
                        />
                        {oneOffFieldError('oneOff.milestoneDate') ? (
                          <p className="mt-2 text-sm text-red-300">{oneOffFieldError('oneOff.milestoneDate')}</p>
                        ) : null}
                      </Field>
                    </div>
                  </div>
                </div>
              ) : null}

              <button
                type="submit"
                disabled={submitting || (jobMode === 'weekly' && !websiteUrlIsValid)}
                className="w-full rounded-full bg-gradient-to-r from-primary to-secondary px-6 py-4 text-white font-semibold shadow-xl shadow-primary/20 disabled:opacity-60 disabled:cursor-not-allowed"
                aria-describedby={jobMode === 'weekly' && !websiteUrlIsValid && !submitting ? 'start-social-content-hint' : undefined}
              >
                <span className="inline-flex items-center justify-center gap-2">
                  {submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
                  {submitButtonLabel}
                </span>
              </button>
              {jobMode === 'weekly' && !websiteUrlIsValid && !submitting && (
                <p id="start-social-content-hint" className="mt-2 text-center text-xs text-white/70">
                  {websiteUrl.trim()
                    ? 'Enter a valid URL like https://example.com to start social content.'
                    : 'Enter a website URL to start social content.'}
                </p>
              )}

              {errorText ? (
                <div
                  role="alert"
                  aria-live="assertive"
                  className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-red-100"
                >
                  {errorText}
                </div>
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
                  <p className="text-xs uppercase tracking-[0.24em] text-white/70">What happens next</p>
                  <h2 className="text-3xl font-bold">Review-first flow</h2>
                </div>
              </div>
              <div className="space-y-3">
                {[
                  'Website brand analysis and uploaded assets feed the brand review.',
                  'Strategy output is surfaced in a readable proposal with comments and approval state.',
                  'Creative assets stay review-gated per asset until every required approval is complete.',
                  'Publish remains blocked until the workflow is explicitly approved.',
                ].map((item, index) => {
                  const [stage, detail] = item.split(' feed ');
                  return (
                    <div key={item} className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 text-white/70">
                      <span className="mr-2 rounded-full border border-primary/25 bg-primary/10 px-2 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
                        Step {index + 1}
                      </span>
                      {stage && detail ? (
                        <>
                          <strong className="text-white">{stage}</strong> feed {detail}
                        </>
                      ) : (
                        <strong className="text-white">{item}</strong>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="min-h-[280px] rounded-[1.5rem] border border-white/10 bg-black/25 p-8 flex flex-col items-center justify-center text-center">
              <strong className="mb-3 text-2xl">{submitting ? 'Creating your social content...' : 'Ready to review for real'}</strong>
              <p className="max-w-md text-white/60">
                {submitting
                  ? 'Aries is saving the brief, storing brand assets, and preparing the post workspace.'
                  : 'When this launches, the next stop is the actual post workspace with brand review, strategy review, creative review, and publish status.'}
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

export function MarketingNewJobScreen(props: MarketingNewJobScreenProps) {
  const router = useRouter();

  return <MarketingNewJobScreenContent {...props} router={router} />;
}

function Field(props: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="text-xs uppercase tracking-[0.22em] text-white/70">
        {props.label}
        {props.required ? ' *' : ''}
      </span>
      {props.children}
    </label>
  );
}

export default MarketingNewJobScreen;
