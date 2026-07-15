"use client";

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, FileUp, LoaderCircle, Rocket, Sparkles } from 'lucide-react';

import type { MarketingApiError } from '@/lib/api/marketing';
import { isValidWebsiteUrl } from '@/lib/api/marketing';
import { validateCanonicalCompetitorUrl } from '@/lib/marketing-competitor';
import { humanizeMarketingCreateMessage } from '@/lib/marketing-create-errors';
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

/**
 * Field-error keys this form renders inline (red box + one-line message under
 * the input). A server fieldError for any OTHER key (e.g. businessType, which
 * has no input here) falls back to the top-level alert so it is never
 * silently dropped.
 */
const RENDERED_FIELD_KEYS = new Set([
  'websiteUrl',
  'competitorUrl',
  'oneOff.name',
  'oneOff.campaignEndDate',
  'oneOff.cta',
  'oneOff.milestoneDate',
  'oneOff.milestoneLabel',
]);

const INPUT_BASE_CLASSNAME =
  'w-full rounded-2xl border px-4 py-3 text-white placeholder:text-white/30 focus:outline-none';

/** Red box treatment for an input that needs the operator's attention. */
function inputClassName(hasError: boolean): string {
  return hasError
    ? `${INPUT_BASE_CLASSNAME} border-red-500/60 bg-red-500/10 focus:border-red-400`
    : `${INPUT_BASE_CLASSNAME} border-white/10 bg-white/5 focus:border-primary/50`;
}

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
  // Bumped on every submit attempt so the scroll-to-first-error effect re-runs
  // even when the same field fails twice in a row.
  const [submitAttempt, setSubmitAttempt] = useState(0);
  // Field keys whose error the operator has started fixing (edited since the
  // last submit); their red box is hidden until the next submit re-validates.
  const [dismissedFields, setDismissedFields] = useState<ReadonlySet<string>>(new Set());
  const formRef = useRef<HTMLFormElement | null>(null);

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
    if (!marketingCreate.error) {
      return;
    }
    // A fresh server failure must never be hidden by an earlier
    // dismiss-on-edit: clear dismissals so its field errors render.
    setDismissedFields(new Set());
    // When the server pinned the failure to specific fields, the inline red
    // boxes carry the message — the top-level alert only shows copy for
    // fields this form does not render, so nothing is ever silently dropped.
    // "Rendered" means actually MOUNTED: oneOff.* inputs only exist in
    // one-off mode, so their errors fall back to the alert if the operator
    // toggled back to Weekly while the request was in flight (jobMode is a
    // dependency so a later toggle re-evaluates this split).
    const serverFieldErrors = marketingCreate.fieldErrors ?? {};
    const isMounted = (key: string) =>
      RENDERED_FIELD_KEYS.has(key) && (jobMode === 'oneOff' || !key.startsWith('oneOff.'));
    const unrendered = Object.entries(serverFieldErrors).filter(([key]) => !isMounted(key));
    const hasRendered = Object.keys(serverFieldErrors).some(isMounted);
    if (unrendered.length > 0) {
      setErrorText([...new Set(unrendered.map(([, copy]) => copy))].join(' '));
    } else if (hasRendered) {
      setErrorText(null);
    } else if (marketingCreate.error.message) {
      setErrorText(humanizeMarketingCreateMessage(marketingCreate.error.message));
    }
  }, [marketingCreate.error, marketingCreate.fieldErrors, jobMode]);

  // Field errors from either side (client pre-submit validation or a server
  // 4xx) scroll the first offending input into view and focus it, so the
  // operator lands on the exact red box that explains what is missing. The
  // attempt guard fires this at most once per submit — when the errors first
  // appear — never again while the operator is editing fields (a re-fire
  // would steal focus mid-typing).
  const clientErrorCount = Object.keys(clientFieldErrors).length;
  const serverErrorCount = Object.keys(marketingCreate.fieldErrors ?? {}).length;
  const lastScrolledAttempt = useRef(0);
  useEffect(() => {
    if (clientErrorCount === 0 && serverErrorCount === 0) {
      return;
    }
    if (lastScrolledAttempt.current === submitAttempt) {
      return;
    }
    const firstInvalid = formRef.current?.querySelector<HTMLElement>(
      '[aria-invalid="true"], [data-field-invalid="true"]',
    );
    if (!firstInvalid) {
      return;
    }
    lastScrolledAttempt.current = submitAttempt;
    firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
    firstInvalid.focus({ preventScroll: true });
    // dismissedFields is a dependency because a server-error arrival clears
    // dismissals one render later — the red box only becomes queryable then.
  }, [submitAttempt, clientErrorCount, serverErrorCount, dismissedFields]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorText(null);
    setSubmitAttempt((current) => current + 1);
    setDismissedFields(new Set());

    // Aggregate every failing field into the same keyed shape the server
    // returns from a 4xx so each missing input gets its own inline red box +
    // one-line message -- not a single top-level alert that hides which
    // fields the operator needs to fill in. The server re-checks shape and
    // ordering so a malicious or scripted POST cannot bypass these rules.
    const errors: Record<string, string> = {};

    const trimmedWebsiteUrl = normalizeWebsiteUrlInput(websiteUrl);
    if (!trimmedWebsiteUrl) {
      errors.websiteUrl = 'Website URL is required.';
    } else if (!isValidWebsiteUrl(trimmedWebsiteUrl)) {
      errors.websiteUrl = 'Website URL must look like https://example.com.';
    }

    const trimmedCompetitorUrl = competitorUrl.trim();
    let normalizedCompetitorUrl: string | null = null;
    if (trimmedCompetitorUrl) {
      const validation = validateCanonicalCompetitorUrl(trimmedCompetitorUrl);
      if (validation.error) {
        errors.competitorUrl = validation.error;
      } else {
        normalizedCompetitorUrl = validation.normalized ?? trimmedCompetitorUrl;
      }
    }

    // One-off mode: name + campaign end date + CTA are required; milestone
    // date + label are optional but paired.
    if (jobMode === 'oneOff') {
      const trimmedOneOffName = oneOffName.trim();
      const trimmedCampaignEndDate = campaignEndDate.trim();
      const trimmedOneOffCta = oneOffCta.trim();
      const trimmedMilestoneDate = milestoneDate.trim();
      const trimmedMilestoneLabel = milestoneLabel.trim();
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
    }

    setClientFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
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
    if (normalizedCompetitorUrl) {
      formData.set('competitorUrl', normalizedCompetitorUrl);
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
        // The error effect above renders the failure from fresh hook state
        // (inline red boxes when the server pinned fields, alert otherwise);
        // reading marketingCreate.error here would see a stale closure.
        return;
      }

      if (isErrorResult(response)) {
        setErrorText(humanizeMarketingCreateMessage(response.message || response.error));
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
  // network round trip; server-side errors (from a 4xx) fill in the same
  // shape after a POST. Editing a field dismisses its error until the next
  // submit so the red box does not linger while the operator is fixing it.
  const fieldErrorFor = (key: string): string | undefined =>
    dismissedFields.has(key)
      ? undefined
      : clientFieldErrors[key] ?? marketingCreate.fieldErrors?.[key];
  const dismissFieldError = (key: string) => {
    setDismissedFields((current) => {
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
  };

  return (
    <div className={wrapperClassName}>
      <div className={contentClassName}>
        <div className="glass rounded-[2.5rem] p-8 md:p-10">
          <p className="mb-3 text-xs uppercase tracking-[0.3em] text-violet-300">Aries workflow</p>
          <h2 className="mb-3 text-4xl font-bold">New Social Content</h2>
          <p className="text-white/60">
            Create a real social content brief with brand inputs, review constraints, and uploads that persist into the post workspace.
          </p>
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="glass rounded-[2.5rem] p-8">
            <form ref={formRef} onSubmit={onSubmit} className="space-y-6">
              <div>
                <div className="mb-4 flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10">
                    <Rocket className="h-6 w-6 text-violet-300" />
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
                  onChange={(event) => {
                    setWebsiteUrl(event.target.value);
                    dismissFieldError('websiteUrl');
                  }}
                  onBlur={() => setWebsiteUrl(normalizeWebsiteUrlInput(websiteUrl))}
                  placeholder="https://yourbrand.com"
                  required
                  aria-invalid={fieldErrorFor('websiteUrl') ? true : undefined}
                  aria-describedby={fieldErrorFor('websiteUrl') ? 'website-url-error' : undefined}
                  className={inputClassName(!!fieldErrorFor('websiteUrl'))}
                />
                {fieldErrorFor('websiteUrl') ? (
                  <p id="website-url-error" className="mt-2 text-sm text-red-300">
                    {fieldErrorFor('websiteUrl')}
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
                  onChange={(event) => {
                    setCompetitorUrl(event.target.value);
                    dismissFieldError('competitorUrl');
                  }}
                  placeholder="Optional competitor website, e.g. https://competitor.com"
                  aria-invalid={fieldErrorFor('competitorUrl') ? true : undefined}
                  aria-describedby={fieldErrorFor('competitorUrl') ? 'competitor-url-error' : undefined}
                  className={inputClassName(!!fieldErrorFor('competitorUrl'))}
                />
                {fieldErrorFor('competitorUrl') ? (
                  <p id="competitor-url-error" className="mt-2 text-sm text-red-300">
                    {fieldErrorFor('competitorUrl')}
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
                      onChange={(e) => {
                        setOneOffName(e.target.value);
                        dismissFieldError('oneOff.name');
                      }}
                      placeholder='e.g. "Summer flash sale" or "Aries AI Hackathon"'
                      aria-invalid={fieldErrorFor('oneOff.name') ? true : undefined}
                      aria-describedby={fieldErrorFor('oneOff.name') ? 'one-off-name-error' : undefined}
                      className={inputClassName(!!fieldErrorFor('oneOff.name'))}
                    />
                    {fieldErrorFor('oneOff.name') ? (
                      <p id="one-off-name-error" className="mt-2 text-sm text-red-300">{fieldErrorFor('oneOff.name')}</p>
                    ) : null}
                  </Field>
                  <Field label="Post end date" required>
                    <div
                      data-field-invalid={fieldErrorFor('oneOff.campaignEndDate') ? 'true' : undefined}
                      tabIndex={-1}
                    >
                      <MonthDayPicker
                        value={campaignEndDate}
                        onChange={(next) => {
                          setCampaignEndDate(next);
                          dismissFieldError('oneOff.campaignEndDate');
                        }}
                        ariaLabel="Post end date"
                        invalid={!!fieldErrorFor('oneOff.campaignEndDate')}
                      />
                    </div>
                    <p className="mt-2 text-xs text-white/70">Aries stops publishing past end-of-day in your timezone.</p>
                    {fieldErrorFor('oneOff.campaignEndDate') ? (
                      <p id="one-off-end-date-error" className="mt-2 text-sm text-red-300">{fieldErrorFor('oneOff.campaignEndDate')}</p>
                    ) : null}
                  </Field>
                  <Field label="Call to action" required>
                    <input
                      value={oneOffCta}
                      onChange={(e) => {
                        setOneOffCta(e.target.value);
                        dismissFieldError('oneOff.cta');
                      }}
                      placeholder='e.g. "Shop the sale" or "Register at example.com/event"'
                      aria-invalid={fieldErrorFor('oneOff.cta') ? true : undefined}
                      aria-describedby={fieldErrorFor('oneOff.cta') ? 'one-off-cta-error' : undefined}
                      className={inputClassName(!!fieldErrorFor('oneOff.cta'))}
                    />
                    {fieldErrorFor('oneOff.cta') ? (
                      <p id="one-off-cta-error" className="mt-2 text-sm text-red-300">{fieldErrorFor('oneOff.cta')}</p>
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
                          onChange={(e) => {
                            setMilestoneLabel(e.target.value);
                            dismissFieldError('oneOff.milestoneLabel');
                          }}
                          placeholder='e.g. "Sale ends"'
                          aria-invalid={fieldErrorFor('oneOff.milestoneLabel') ? true : undefined}
                          aria-describedby={fieldErrorFor('oneOff.milestoneLabel') ? 'one-off-milestone-label-error' : undefined}
                          className={inputClassName(!!fieldErrorFor('oneOff.milestoneLabel'))}
                        />
                        {fieldErrorFor('oneOff.milestoneLabel') ? (
                          <p id="one-off-milestone-label-error" className="mt-2 text-sm text-red-300">{fieldErrorFor('oneOff.milestoneLabel')}</p>
                        ) : null}
                      </Field>
                      <Field label="Milestone date">
                        <div
                          data-field-invalid={fieldErrorFor('oneOff.milestoneDate') ? 'true' : undefined}
                          tabIndex={-1}
                        >
                          <MonthDayPicker
                            value={milestoneDate}
                            onChange={(next) => {
                              setMilestoneDate(next);
                              dismissFieldError('oneOff.milestoneDate');
                            }}
                            ariaLabel="Milestone date"
                            invalid={!!fieldErrorFor('oneOff.milestoneDate')}
                          />
                        </div>
                        {fieldErrorFor('oneOff.milestoneDate') ? (
                          <p id="one-off-milestone-date-error" className="mt-2 text-sm text-red-300">{fieldErrorFor('oneOff.milestoneDate')}</p>
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
                      <span className="mr-2 rounded-full border border-primary/25 bg-primary/10 px-2 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-violet-300">
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
