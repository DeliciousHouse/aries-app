'use client';

import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { ArrowLeft, ArrowRight, Check, ShieldCheck } from 'lucide-react';

import { createMarketingApi } from '@/lib/api/marketing';
import { createAriesV1Api, type UrlPreviewResponse } from '@/lib/api/aries-v1';
import { validateCanonicalCompetitorUrl } from '@/lib/marketing-competitor';
import { useBusinessProfile } from '@/hooks/use-business-profile';

type StepKey = 'welcome' | 'business' | 'brand' | 'channels' | 'goal';

const steps: Array<{ key: StepKey; label: string }> = [
  { key: 'welcome', label: 'Welcome' },
  { key: 'business', label: 'Business' },
  { key: 'brand', label: 'Brand' },
  { key: 'channels', label: 'Channels' },
  { key: 'goal', label: 'Goal' },
];

const goalOptions = [
  'Get more leads',
  'Book more appointments',
  'Increase sales',
  'Stay visible every week',
];

const channelOptions = ['Meta', 'Instagram', 'Google Business', 'LinkedIn'];

function goalFromBusinessProfile(primaryGoal: string | null | undefined): string {
  const normalized = primaryGoal?.trim().toLowerCase() || '';
  if (!normalized) {
    return goalOptions[0];
  }
  if (normalized.includes('appoint')) {
    return 'Book more appointments';
  }
  if (normalized.includes('sale') || normalized.includes('revenue') || normalized.includes('purchase')) {
    return 'Increase sales';
  }
  if (normalized.includes('visible') || normalized.includes('awareness') || normalized.includes('brand')) {
    return 'Stay visible every week';
  }
  return 'Get more leads';
}

export default function AriesOnboardingFlow() {
  const router = useRouter();
  const businessProfile = useBusinessProfile({ autoLoad: true });
  const ariesApi = useMemo(() => createAriesV1Api(), []);
  const [stepIndex, setStepIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydratedFromProfile, setHydratedFromProfile] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [urlPreview, setUrlPreview] = useState<UrlPreviewResponse | null>(null);
  const [businessName, setBusinessName] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [businessType, setBusinessType] = useState('');
  const [approverName, setApproverName] = useState('');
  const [selectedChannels, setSelectedChannels] = useState<string[]>(['Meta', 'Instagram']);
  const [goal, setGoal] = useState(goalOptions[0]);
  const [offer, setOffer] = useState('');
  const [competitorUrl, setCompetitorUrl] = useState('');
  const deferredWebsiteUrl = useDeferredValue(websiteUrl.trim());

  const profile = businessProfile.profile.data?.profile ?? null;

  useEffect(() => {
    if (!profile || hydratedFromProfile) {
      return;
    }

    setBusinessName(profile.brandKit?.brand_name || profile.businessName || '');
    setWebsiteUrl(profile.websiteUrl || profile.brandKit?.source_url || '');
    setBusinessType(profile.businessType || '');
    setApproverName(profile.launchApproverName || '');
    setGoal(goalFromBusinessProfile(profile.primaryGoal));
    setOffer(profile.offer || '');
    setCompetitorUrl(profile.competitorUrl || '');
    if (profile.channels.length > 0) {
      setSelectedChannels(profile.channels);
    }
    setHydratedFromProfile(true);
  }, [hydratedFromProfile, profile]);

  useEffect(() => {
    if (!deferredWebsiteUrl) {
      setUrlPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const preview = await ariesApi.getUrlPreview(deferredWebsiteUrl);
        if (!cancelled) {
          setUrlPreview(preview);
        }
      } catch (previewFetchError) {
        if (!cancelled) {
          setUrlPreview(null);
          setPreviewError(
            previewFetchError instanceof Error
              ? previewFetchError.message
              : 'Aries could not extract live brand data from this site.',
          );
        }
      } finally {
        if (!cancelled) {
          setPreviewLoading(false);
        }
      }
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [ariesApi, deferredWebsiteUrl]);

  const currentStep = steps[stepIndex];

  async function handleFinish() {
    setSubmitting(true);
    setError(null);

    try {
      const trimmedCompetitorUrl = competitorUrl.trim();
      if (trimmedCompetitorUrl) {
        const competitorValidation = validateCanonicalCompetitorUrl(trimmedCompetitorUrl);
        if (competitorValidation.error) {
          throw new Error(competitorValidation.error);
        }
      }

      const savedProfile = await businessProfile.updateProfile({
        businessName,
        websiteUrl,
        businessType,
        primaryGoal: goal,
        launchApproverName: approverName || null,
        offer: offer || null,
        competitorUrl: trimmedCompetitorUrl || null,
        channels: selectedChannels,
      });
      if (!savedProfile) {
        throw new Error('Unable to save the business profile before starting the campaign.');
      }

      const persistedProfile = savedProfile.profile;
      const normalizedWebsiteUrl = persistedProfile.websiteUrl || websiteUrl.trim();
      const api = createMarketingApi();
      const result = await api.createJob({
        jobType: 'brand_campaign',
        payload: {
          brandUrl: normalizedWebsiteUrl,
          websiteUrl: normalizedWebsiteUrl,
          businessName: persistedProfile.businessName,
          businessType: persistedProfile.businessType || businessType.trim(),
          approverName: persistedProfile.launchApproverName || approverName.trim(),
          competitorUrl: persistedProfile.competitorUrl || competitorUrl.trim(),
          goal: persistedProfile.primaryGoal || goal,
          offer: persistedProfile.offer || offer.trim(),
          notes: persistedProfile.notes || '',
          channels: persistedProfile.channels.length > 0 ? persistedProfile.channels : selectedChannels,
          mode: 'guided',
        },
      });

      if ('error' in result) {
        throw new Error(result.message || result.error || 'Unable to start the first campaign.');
      }

      router.push(`/dashboard/campaigns/${encodeURIComponent(result.jobId)}?welcome=1`);
      return;
    } catch (submissionError) {
      const message =
        submissionError instanceof Error
          ? submissionError.message
          : 'We could not reach the live runtime, so Aries kept you on setup with the real error.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0d1218] text-white">
      <div className="mx-auto max-w-5xl px-6 py-10 lg:px-10">
        <div className="mb-10 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[#dcb58f]">Aries setup</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-[-0.03em] text-white">
              Set up your business once.
            </h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-white/65">
              Aries will use this to show your first campaign plan, prepare review-ready creative,
              and keep every launch approval-safe.
            </p>
          </div>
          <div className="hidden rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-white/65 md:flex md:items-center md:gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-300" />
            Nothing goes live without approval.
          </div>
        </div>

        <div className="mb-8 grid gap-3 md:grid-cols-5">
          {steps.map((step, index) => {
            const active = index === stepIndex;
            const complete = index < stepIndex;
            return (
              <div
                key={step.key}
                className={clsx(
                  'rounded-[1.2rem] border px-4 py-3 text-sm transition',
                  active
                    ? 'border-white/20 bg-white/[0.08] text-white'
                    : complete
                      ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100'
                      : 'border-white/8 bg-white/[0.03] text-white/45',
                )}
              >
                <div className="flex items-center gap-2">
                  {complete ? <Check className="h-4 w-4" /> : <span className="text-xs">0{index + 1}</span>}
                  <span>{step.label}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="rounded-[2.4rem] border border-white/10 bg-white/[0.04] p-6 shadow-[0_30px_90px_rgba(0,0,0,0.28)] backdrop-blur-xl md:p-8">
          {currentStep.key === 'welcome' ? (
            <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr]">
              <div className="space-y-5">
                <p className="text-sm font-semibold uppercase tracking-[0.24em] text-white/35">What Aries does</p>
                <h2 className="text-4xl font-semibold tracking-[-0.03em] text-white">
                  Aries will help you plan, create, approve, launch, and improve marketing from one place.
                </h2>
                <p className="text-base leading-8 text-white/65">
                  You do not need to learn marketing software. Aries will keep the process simple,
                  show what needs your attention, and make sure approval stays visible.
                </p>
              </div>
              <div className="space-y-4">
                {[
                  'Set up your business',
                  'Review your first campaign plan',
                  'Approve the creative before launch',
                  'See what is scheduled next',
                ].map((item) => (
                  <div key={item} className="rounded-[1.5rem] border border-white/8 bg-black/15 px-4 py-4 text-sm text-white/75">
                    {item}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {currentStep.key === 'business' ? (
            <div className="grid gap-5 lg:grid-cols-2">
              <Field label="Business name">
                <input
                  value={businessName}
                  onChange={(event) => setBusinessName(event.target.value)}
                  className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-white/25"
                />
              </Field>
              <Field label="Website">
                <input
                  value={websiteUrl}
                  onChange={(event) => setWebsiteUrl(event.target.value)}
                  className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-white/25"
                />
              </Field>
              <Field label="Business type">
                <input
                  value={businessType}
                  onChange={(event) => setBusinessType(event.target.value)}
                  className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-white/25"
                />
              </Field>
              <Field label="Primary approver">
                <input
                  value={approverName}
                  onChange={(event) => setApproverName(event.target.value)}
                  className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-white/25"
                />
              </Field>
            </div>
          ) : null}

          {currentStep.key === 'brand' ? (
            <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
              <div className="rounded-[1.8rem] border border-white/8 bg-black/15 p-5">
                <p className="text-sm font-semibold uppercase tracking-[0.24em] text-white/35">Website import review</p>
                {previewLoading ? (
                  <p className="mt-4 text-sm text-white/60">Extracting live brand-kit data from the website…</p>
                ) : previewError ? (
                  <div className="mt-4 rounded-[1.25rem] border border-amber-300/20 bg-amber-300/10 px-4 py-4 text-sm text-amber-100">
                    {previewError}
                  </div>
                ) : urlPreview?.brandKitPreview ? (
                  <>
                    <h2 className="mt-4 text-2xl font-semibold text-white">{urlPreview.brandKitPreview.brandName}</h2>
                    <p className="mt-2 text-sm text-white/55">{urlPreview.domain}</p>
                    {urlPreview.brandKitPreview.logoUrls.length > 0 ? (
                      <div className="mt-5 space-y-2">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Logo / wordmark candidates</p>
                        <div className="space-y-2 text-sm text-white/75">
                          {urlPreview.brandKitPreview.logoUrls.map((logoUrl) => (
                            <a
                              key={logoUrl}
                              href={logoUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="block break-all rounded-[1rem] border border-white/8 bg-white/[0.03] px-3 py-3 transition hover:border-white/16 hover:text-white"
                            >
                              {logoUrl}
                            </a>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <p className="mt-4 text-sm text-white/55">No logo or wordmark candidates were extracted from the live site yet.</p>
                    )}
                  </>
                ) : (
                  <p className="mt-4 text-sm text-white/55">Enter a live HTTPS website to review the extracted brand kit.</p>
                )}
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <SummaryTile
                  label="Palette"
                  value={urlPreview?.brandKitPreview?.colors.palette.join('\n') || 'No live palette extracted yet.'}
                />
                <SummaryTile
                  label="Fonts"
                  value={urlPreview?.brandKitPreview?.fontFamilies.join('\n') || 'No live fonts extracted yet.'}
                />
                <SummaryTile
                  label="Brand voice"
                  value={urlPreview?.brandKitPreview?.brandVoiceSummary || 'No real brand voice summary was derived from the site yet.'}
                />
                <SummaryTile
                  label="Offer summary"
                  value={urlPreview?.brandKitPreview?.offerSummary || 'No real offer summary was derived from the site yet.'}
                />
              </div>
            </div>
          ) : null}

          {currentStep.key === 'channels' ? (
            <div className="space-y-5">
              <p className="text-sm leading-7 text-white/65">
                Connect what matters now. You can always add more later.
              </p>
              <div className="grid gap-4 md:grid-cols-2">
                {channelOptions.map((channel) => {
                  const selected = selectedChannels.includes(channel);
                  return (
                    <button
                      key={channel}
                      type="button"
                      onClick={() =>
                        setSelectedChannels((current) =>
                          current.includes(channel)
                            ? current.filter((entry) => entry !== channel)
                            : [...current, channel],
                        )
                      }
                      className={clsx(
                        'rounded-[1.4rem] border px-4 py-4 text-left transition',
                        selected
                          ? 'border-white/20 bg-white/[0.08] text-white'
                          : 'border-white/8 bg-black/15 text-white/65 hover:border-white/15',
                      )}
                    >
                      <p className="font-medium">{channel}</p>
                      <p className="mt-2 text-sm text-white/55">
                        {selected ? 'Included in your first campaign.' : 'Connect later if you prefer.'}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {currentStep.key === 'goal' ? (
            <div className="grid gap-5 lg:grid-cols-2">
              <Field label="Primary goal">
                <div className="grid gap-3">
                  {goalOptions.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setGoal(option)}
                      className={clsx(
                        'rounded-[1.2rem] border px-4 py-3 text-left transition',
                        goal === option
                          ? 'border-white/20 bg-white/[0.08] text-white'
                          : 'border-white/8 bg-black/15 text-white/65 hover:border-white/15',
                      )}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </Field>
              <div className="grid gap-5">
                <Field label="Offer or focus">
                  <input
                    value={offer}
                    onChange={(event) => setOffer(event.target.value)}
                    className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-white/25"
                  />
                </Field>
                <Field label="Competitor website URL">
                  <input
                    value={competitorUrl}
                    onChange={(event) => setCompetitorUrl(event.target.value)}
                    className="w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-white/25"
                  />
                  <p className="text-sm text-white/45">
                    Use the competitor&apos;s website. Facebook pages and Meta Ad Library links belong in override fields, not here.
                  </p>
                </Field>
                <div className="rounded-[1.5rem] border border-white/8 bg-black/15 px-4 py-4 text-sm text-white/65">
                  Aries will create your first campaign plan, then send you to Home with a clear next action.
                </div>
              </div>
            </div>
          ) : null}

          <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-white/8 pt-6">
            <button
              type="button"
              onClick={() => setStepIndex((index) => Math.max(index - 1, 0))}
              disabled={stepIndex === 0 || submitting}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 px-4 py-2.5 text-sm font-medium text-white/70 transition disabled:cursor-not-allowed disabled:opacity-40 hover:border-white/20 hover:text-white"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>

            <div className="flex flex-wrap items-center gap-3">
              {error ? <p className="text-sm text-amber-200">{error}</p> : null}
              {stepIndex < steps.length - 1 ? (
                <button
                  type="button"
                  onClick={() => setStepIndex((index) => Math.min(index + 1, steps.length - 1))}
                  className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#11161c] transition hover:translate-y-[-1px]"
                >
                  Continue
                  <ArrowRight className="h-4 w-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleFinish()}
                  disabled={submitting}
                  className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#11161c] transition hover:translate-y-[-1px] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? 'Starting Aries...' : 'Open Aries'}
                  <ArrowRight className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-2">
      <span className="text-sm font-medium text-white/70">{props.label}</span>
      {props.children}
    </label>
  );
}

function SummaryTile(props: { label: string; value: string }) {
  return (
    <div className="rounded-[1.5rem] border border-white/8 bg-black/15 p-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">{props.label}</p>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-white/75">{props.value}</p>
    </div>
  );
}
