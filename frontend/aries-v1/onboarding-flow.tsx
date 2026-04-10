'use client';

import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import clsx from 'clsx';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ShieldCheck,
} from 'lucide-react';

import { useBusinessProfile } from '@/hooks/use-business-profile';
import { createAriesV1Api, type UrlPreviewBrandKitPreview, type UrlPreviewResponse } from '@/lib/api/aries-v1';
import { validateCanonicalCompetitorUrl } from '@/lib/marketing-competitor';

type StepKey = 'business' | 'website' | 'brand' | 'channels' | 'goal';

type StepDefinition = {
  key: StepKey;
  label: string;
  title: string;
  description: string;
};

type ChannelOption = {
  id: string;
  label: string;
  description: string;
};

type GoalOption = {
  label: string;
  description: string;
};

const STEP_DEFINITIONS: StepDefinition[] = [
  {
    key: 'business',
    label: 'Business',
    title: 'Start with the business Aries will represent.',
    description: 'Set the operating basics once so every campaign starts from the same clear foundation.',
  },
  {
    key: 'website',
    label: 'Website',
    title: 'Use the live website as the current source of truth.',
    description: 'Aries uses the website to understand the offer, the conversion path, and the visible brand cues before any campaign work begins.',
  },
  {
    key: 'brand',
    label: 'Brand identity',
    title: 'Review the brand snapshot before the first campaign opens.',
    description: 'This is the client-facing preview Aries will use to frame voice, offer, and visual direction.',
  },
  {
    key: 'channels',
    label: 'Channels',
    title: 'Choose where the first campaign should show up.',
    description: 'Start with the channels that matter now. The rest can be added later without rebuilding the profile.',
  },
  {
    key: 'goal',
    label: 'Goal',
    title: 'What outcome matters most right now?',
    description: 'Tell Aries what your business needs so the first campaign is built around a real objective.',
  },
];

const CHANNEL_OPTIONS: ChannelOption[] = [
  {
    id: 'meta-ads',
    label: 'Meta',
    description: 'Paid social for demand capture, retargeting, and direct-response offers.',
  },
  {
    id: 'instagram',
    label: 'Instagram',
    description: 'High-visibility social touchpoints for brand presence, proof, and offer awareness.',
  },
  {
    id: 'google-business',
    label: 'Google Business',
    description: 'Local discovery and intent capture for service-led businesses that need qualified traffic.',
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    description: 'Professional reach for higher-trust offers, partnerships, and longer consideration cycles.',
  },
];

const GOAL_OPTIONS: GoalOption[] = [
  {
    label: 'Get leads',
    description: 'Collect contact info, sign-ups, consultation requests, or quote inquiries.',
  },
  {
    label: 'Sell a product or service',
    description: 'Drive direct purchases, bookings, or paid sign-ups.',
  },
  {
    label: 'Increase social media presence',
    description: 'Grow followers, engagement, and brand visibility across platforms.',
  },
  {
    label: 'Gather information',
    description: 'Run quizzes, surveys, or polls to learn about your audience.',
  },
  {
    label: 'Other',
    description: 'Define a custom business outcome.',
  },
];

function goalFromBusinessProfile(primaryGoal: string | null | undefined): string {
  const normalized = primaryGoal?.trim().toLowerCase() || '';
  if (!normalized) {
    return '';
  }
  if (normalized.includes('lead') || normalized.includes('enquir') || normalized.includes('sign-up') || normalized.includes('contact')) {
    return 'Get leads';
  }
  if (
    normalized.includes('sell') ||
    normalized.includes('sale') ||
    normalized.includes('revenue') ||
    normalized.includes('purchase') ||
    normalized.includes('buy') ||
    normalized.includes('book')
  ) {
    return 'Sell a product or service';
  }
  if (normalized.includes('social') || normalized.includes('follower') || normalized.includes('visible') || normalized.includes('awareness') || normalized.includes('brand') || normalized.includes('engag')) {
    return 'Increase social media presence';
  }
  if (normalized.includes('quiz') || normalized.includes('survey') || normalized.includes('poll') || normalized.includes('gather') || normalized.includes('research')) {
    return 'Gather information';
  }
  const knownLabels = GOAL_OPTIONS.map((option) => option.label);
  if (knownLabels.includes(primaryGoal?.trim() || '')) {
    return primaryGoal!.trim();
  }
  return primaryGoal?.trim() || '';
}

function isValidHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function hostnameFromUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function firstPresent(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function joinedLineList(values: string[]): string {
  return values.filter(Boolean).join('\n');
}

function genericPreviewErrorMessage(): string {
  return 'We could not prepare a polished website preview from this address yet. You can continue and refine the profile inside Aries.';
}

function brandPreviewSummary(
  preview: UrlPreviewBrandKitPreview | null,
  urlPreview: UrlPreviewResponse | null,
): string {
  return (
    firstPresent(
      urlPreview?.description,
      preview?.brandVoiceSummary,
      preview?.offerSummary,
      'Aries will build the brand snapshot from the live website once the source address is ready.',
    ) || ''
  );
}

function stepReady(stepKey: StepKey, values: {
  businessName: string;
  businessType: string;
  websiteUrl: string;
  selectedChannels: string[];
  goal: string;
  customGoal: string;
}): boolean {
  if (stepKey === 'business') {
    return values.businessName.trim().length > 0 && values.businessType.trim().length > 0;
  }
  if (stepKey === 'website' || stepKey === 'brand') {
    return isValidHttpsUrl(values.websiteUrl);
  }
  if (stepKey === 'channels') {
    return values.selectedChannels.length > 0;
  }
  if (stepKey === 'goal') {
    if (values.goal === 'Other') {
      return values.customGoal.trim().length > 0;
    }
    return values.goal.trim().length > 0;
  }
  return true;
}

function stepValidationMessage(stepKey: StepKey): string {
  if (stepKey === 'business') {
    return 'Add the business name and business type before continuing.';
  }
  if (stepKey === 'website') {
    return 'Enter a valid HTTPS website before continuing.';
  }
  if (stepKey === 'brand') {
    return 'Enter a valid HTTPS website before reviewing the brand snapshot.';
  }
  if (stepKey === 'channels') {
    return 'Select at least one channel before continuing.';
  }
  if (stepKey === 'goal') {
    return 'Choose a business outcome before continuing.';
  }
  return 'Complete the current step before continuing.';
}

function authRedirectHref(input: { draftId: string; businessName: string }): string {
  const callbackUrl = `/onboarding/resume?draft=${encodeURIComponent(input.draftId)}`;
  const params = new URLSearchParams({
    callbackUrl,
    draftSaved: '1',
  });
  if (input.businessName.trim()) {
    params.set('businessName', input.businessName.trim());
  }
  return `/login?${params.toString()}`;
}

export default function AriesOnboardingFlow(props: { initialAuthenticated?: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const ariesApi = useMemo(() => createAriesV1Api(), []);
  const draftParam = searchParams.get('draft')?.trim() || '';
  const {
    load: loadBusinessProfile,
    profile: businessProfileState,
  } = useBusinessProfile({ autoLoad: false });

  const [stepIndex, setStepIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [urlPreview, setUrlPreview] = useState<UrlPreviewResponse | null>(null);
  const [draftId, setDraftId] = useState(draftParam);
  const [creatingDraft, setCreatingDraft] = useState(false);
  const [loadedDraftId, setLoadedDraftId] = useState<string | null>(null);
  const [profileHydrated, setProfileHydrated] = useState(false);
  const [businessName, setBusinessName] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [businessType, setBusinessType] = useState('');
  const [approverName, setApproverName] = useState('');
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
  const [goal, setGoal] = useState('');
  const [customGoal, setCustomGoal] = useState('');
  const [offer, setOffer] = useState('');
  const [competitorUrl, setCompetitorUrl] = useState('');
  const deferredWebsiteUrl = useDeferredValue(websiteUrl.trim());

  const profile = businessProfileState.data?.profile ?? null;
  const currentStep = STEP_DEFINITIONS[stepIndex];
  const preview = urlPreview?.brandKitPreview ?? null;
  const previewBrandName =
    firstPresent(
      preview?.brandName,
      businessName,
      props.initialAuthenticated && !draftId ? profile?.businessName : null,
      hostnameFromUrl(websiteUrl),
    ) || 'Brand preview';
  const previewDomain = hostnameFromUrl(preview?.canonicalUrl || websiteUrl) || urlPreview?.domain || 'Website preview';
  const previewColors = Array.from(new Set(preview?.colors.palette.filter(Boolean) || []));
  const previewFonts = preview?.fontFamilies.filter(Boolean) || [];
  const canFinish = STEP_DEFINITIONS.every((step) =>
    stepReady(step.key, {
      businessName,
      businessType,
      websiteUrl,
      selectedChannels,
      goal,
      customGoal,
    }),
  );
  const fieldInputClassName =
    'w-full rounded-[1rem] border border-white/12 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] px-4 py-3 text-white outline-none transition duration-200 placeholder:text-white/24 focus:border-[#b36cff] focus:shadow-[0_0_0_1px_rgba(179,108,255,0.24),0_0_24px_rgba(179,108,255,0.14)]';

  useEffect(() => {
    setDraftId(draftParam);
  }, [draftParam]);

  useEffect(() => {
    if (draftId || creatingDraft) {
      return;
    }

    let cancelled = false;
    setCreatingDraft(true);

    void ariesApi.createOnboardingDraft()
      .then((response) => {
        if (cancelled) {
          return;
        }
        const nextDraftId = response.draft.draftId;
        setDraftId(nextDraftId);
        router.replace(`/onboarding/start?draft=${encodeURIComponent(nextDraftId)}`);
      })
      .catch(() => {
        if (!cancelled) {
          setError('We could not prepare a saved onboarding session right now.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setCreatingDraft(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [ariesApi, creatingDraft, draftId, router]);

  useEffect(() => {
    if (!draftId || loadedDraftId === draftId) {
      return;
    }

    let cancelled = false;

    void ariesApi.getOnboardingDraft(draftId)
      .then((response) => {
        if (cancelled) {
          return;
        }

        const draft = response.draft;
        setBusinessName(draft.businessName);
        setWebsiteUrl(draft.websiteUrl);
        setBusinessType(draft.businessType);
        setApproverName(draft.approverName);
        setSelectedChannels(draft.channels);
        const knownGoalLabels = GOAL_OPTIONS.map((o) => o.label);
        if (draft.goal && !knownGoalLabels.includes(draft.goal)) {
          setGoal('Other');
          setCustomGoal(draft.goal);
        } else {
          setGoal(draft.goal);
          setCustomGoal('');
        }
        setOffer(draft.offer);
        setCompetitorUrl(draft.competitorUrl);
        setUrlPreview(draft.preview);
        setPreviewError(null);
        setLoadedDraftId(draft.draftId);
      })
      .catch(() => {
        if (!cancelled) {
          setError('We could not restore the saved onboarding draft.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [ariesApi, draftId, loadedDraftId]);

  useEffect(() => {
    if (!props.initialAuthenticated || draftId || profileHydrated) {
      return;
    }

    let cancelled = false;

    void loadBusinessProfile()
      .then((result) => {
        if (cancelled || !result?.profileResponse.profile) {
          return;
        }

        const nextProfile = result.profileResponse.profile;
        setBusinessName(nextProfile.businessName || nextProfile.brandKit?.brand_name || '');
        setWebsiteUrl(nextProfile.websiteUrl || nextProfile.brandKit?.source_url || '');
        setBusinessType(nextProfile.businessType || '');
        setApproverName(nextProfile.launchApproverName || '');
        setGoal(goalFromBusinessProfile(nextProfile.primaryGoal));
        setOffer(nextProfile.offer || nextProfile.brandIdentity?.offer || nextProfile.brandKit?.offer_summary || '');
        setCompetitorUrl(nextProfile.competitorUrl || '');
        setSelectedChannels(nextProfile.channels.length > 0 ? nextProfile.channels : []);
        setProfileHydrated(true);
      })
      .catch(() => {
        if (!cancelled) {
          setProfileHydrated(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [draftId, loadBusinessProfile, profileHydrated, props.initialAuthenticated]);

  useEffect(() => {
    if (!draftId) {
      return;
    }

    const timer = window.setTimeout(() => {
      void ariesApi.updateOnboardingDraft(draftId, {
        websiteUrl,
        businessName,
        businessType,
        approverName,
        channels: selectedChannels,
        goal,
        offer,
        competitorUrl,
        preview: urlPreview,
        provenance: {
          source_url: websiteUrl,
          canonical_url: urlPreview?.canonicalUrl || null,
          source_fingerprint: urlPreview?.canonicalUrl || websiteUrl || null,
        },
      }).catch(() => {});
    }, 250);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    approverName,
    ariesApi,
    businessName,
    businessType,
    competitorUrl,
    draftId,
    goal,
    offer,
    selectedChannels,
    urlPreview,
    websiteUrl,
  ]);

  useEffect(() => {
    if (!draftId || !deferredWebsiteUrl || !isValidHttpsUrl(deferredWebsiteUrl)) {
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
        const nextPreview = await ariesApi.getUrlPreview(deferredWebsiteUrl, draftId);
        if (!cancelled) {
          setUrlPreview(nextPreview);
        }
      } catch {
        if (!cancelled) {
          setUrlPreview(null);
          setPreviewError(genericPreviewErrorMessage());
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
  }, [ariesApi, deferredWebsiteUrl, draftId]);

  function toggleChannel(channelId: string) {
    setSelectedChannels((current) =>
      current.includes(channelId)
        ? current.filter((value) => value !== channelId)
        : [...current, channelId],
    );
  }

  function handleContinue() {
    if (!stepReady(currentStep.key, { businessName, businessType, websiteUrl, selectedChannels, goal, customGoal })) {
      setError(stepValidationMessage(currentStep.key));
      return;
    }
    setError(null);
    setStepIndex((index) => Math.min(index + 1, STEP_DEFINITIONS.length - 1));
  }

  async function handleFinish() {
    if (!canFinish) {
      setError(stepValidationMessage(currentStep.key));
      return;
    }

    setSubmitting(true);
    setError(null);

    let activeDraftId = draftId;
    if (!activeDraftId) {
      try {
        const response = await ariesApi.createOnboardingDraft();
        activeDraftId = response.draft.draftId;
        setDraftId(activeDraftId);
        router.replace(`/onboarding/start?draft=${encodeURIComponent(activeDraftId)}`);
      } catch {
        setError('We could not create an onboarding session. Please reload and try again.');
        setSubmitting(false);
        return;
      }
    }

    try {
      const trimmedCompetitorUrl = competitorUrl.trim();
      if (trimmedCompetitorUrl) {
        const competitorValidation = validateCanonicalCompetitorUrl(trimmedCompetitorUrl);
        if (competitorValidation.error) {
          throw new Error(competitorValidation.error);
        }
      }

      const resolvedGoal = goal === 'Other' ? customGoal.trim() : goal;
      await ariesApi.updateOnboardingDraft(activeDraftId, {
        status: 'ready_for_auth',
        websiteUrl,
        businessName,
        businessType,
        approverName,
        channels: selectedChannels,
        goal: resolvedGoal,
        offer,
        competitorUrl: trimmedCompetitorUrl || null,
        preview: urlPreview,
        provenance: {
          source_url: websiteUrl,
          canonical_url: urlPreview?.canonicalUrl || null,
          source_fingerprint: urlPreview?.canonicalUrl || websiteUrl || null,
        },
      });

      if (props.initialAuthenticated) {
        router.push(`/onboarding/resume?draft=${encodeURIComponent(activeDraftId)}`);
        return;
      }

      router.push(
        authRedirectHref({
          draftId: activeDraftId,
          businessName: businessName || hostnameFromUrl(websiteUrl) || 'your business',
        }),
      );
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : 'We could not save setup for the first campaign.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen overflow-hidden bg-[#07080d] text-white">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-[-8%] top-0 h-[26rem] w-[26rem] rounded-full bg-[radial-gradient(circle,rgba(127,76,255,0.18),transparent_72%)] blur-3xl" />
      </div>

      <div className="relative mx-auto mt-10 max-w-[1320px] px-4 py-5 sm:mt-12 sm:px-6 lg:mt-14 lg:px-8">
        <div className="pointer-events-none absolute left-[-5.5rem] top-[-6rem] hidden h-[17rem] w-[17rem] lg:block">
          <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle,rgba(146,88,255,0.14),transparent_68%)] blur-3xl" />
          <Image
            src="/ariesai-logo.webp"
            alt=""
            width={320}
            height={320}
            aria-hidden="true"
            className="absolute inset-0 h-[17rem] w-[17rem] scale-[1.02] opacity-[0.28] brightness-[2.25] contrast-130 mix-blend-screen"
          />
        </div>

        <div className="relative z-10">
          <div className="relative overflow-hidden rounded-[2rem] border border-white/14 bg-[linear-gradient(180deg,rgba(28,24,39,0.5),rgba(14,12,20,0.26))] shadow-[0_34px_110px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.22)] backdrop-blur-[30px] backdrop-saturate-150">
            <div className="pointer-events-none absolute inset-0 rounded-[2rem] bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.17),transparent_18%),radial-gradient(circle_at_left_14%,rgba(171,108,255,0.2),transparent_24%),radial-gradient(circle_at_top_right,rgba(176,106,255,0.16),transparent_24%),linear-gradient(180deg,rgba(255,255,255,0.04),transparent_32%,rgba(255,255,255,0.02))]" />
            <div className="pointer-events-none absolute inset-[1px] rounded-[calc(2rem-1px)] border border-white/10" />
            <div className="pointer-events-none absolute left-0 right-0 top-0 h-24 bg-[linear-gradient(180deg,rgba(255,255,255,0.12),transparent)] opacity-50" />

            <div className="relative z-10 border-b border-white/8 px-6 pb-6 pt-7 sm:px-8 lg:px-10">
              <div className="grid gap-5 lg:grid-cols-[55%_45%] lg:items-start lg:gap-10">
                <h1 className="max-w-none text-[2rem] font-light tracking-[0.0025em] text-white sm:text-[2rem] sm:leading-[1]">
                  Set the business once.
                  <br />
                  Launch from it every time.
                </h1>
                <p className="w-full max-w-none text-base leading-8 text-white/68 lg:pr-6 lg:pt-2 lg:text-[1.05rem]">
                  Aries uses this intake to prepare the first campaign, shape the review package, and keep approvals visible from the start.
                </p>
              </div>
            </div>

            <div className="relative z-10 px-6 pb-6 pt-5 sm:px-8 lg:px-10">
              <div className="flex flex-wrap gap-3 border-b border-white/8 pb-5">
                {STEP_DEFINITIONS.map((step, index) => {
                  const active = index === stepIndex;
                  const complete = index < stepIndex;
                  return (
                    <div
                      key={step.key}
                      className={clsx(
                        'flex min-w-[126px] flex-1 items-center gap-2 rounded-full border px-3 py-2.5 text-[1.1rem] transition duration-300',
                        active
                          ? 'border-[#a96cff]/45 bg-[linear-gradient(90deg,rgba(151,93,255,0.22),rgba(151,93,255,0.05))] text-white shadow-[inset_0_-1px_0_rgba(169,108,255,0.9),0_0_20px_rgba(169,108,255,0.15)]'
                          : 'border-white/8 bg-white/[0.02] text-white/50',
                      )}
                    >
                      <span
                        className={clsx(
                          'flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-semibold',
                          active
                            ? 'border-[#a96cff]/50 bg-[#8a52ff]/20 text-[#dec6ff]'
                            : complete
                              ? 'border-white/20 bg-white/[0.08] text-white/80'
                              : 'border-white/10 text-white/40',
                        )}
                      >
                        {complete ? <Check className="h-3 w-3" /> : `0${index + 1}`}
                      </span>
                      <span className="whitespace-nowrap">{step.label}</span>
                    </div>
                  );
                })}
              </div>

              <div className="mt-7">
                <section className="relative rounded-[1.8rem] border border-white/16 bg-[linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0.018))] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-[22px] backdrop-saturate-150 md:p-8">
            <div className="pointer-events-none absolute inset-0 rounded-[1.8rem] bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.1),transparent_20%),radial-gradient(circle_at_top,rgba(171,108,255,0.12),transparent_35%)]" />
            <div className="pointer-events-none absolute inset-[1px] rounded-[calc(1.8rem-1px)] border border-white/8" />
            <div className="relative z-10 flex flex-wrap items-start justify-between gap-4 border-b border-white/8 pb-6">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#ba8cff]">
                  {currentStep.label}
                </p>
                <h2 className="mt-3 text-3xl font-normal tracking-[-0.03em] text-white">{currentStep.title}</h2>
                <p className="mt-3 max-w-3xl text-sm leading-8 text-white/66">{currentStep.description}</p>
              </div>

              {preview || websiteUrl.trim() ? (
                <div className="rounded-full border border-[#a96cff]/25 bg-[rgba(118,67,190,0.14)] px-4 py-2 text-xs font-medium text-white/72">
                  {previewDomain}
                </div>
              ) : null}
            </div>

            <div className="relative z-10 mt-8 space-y-8">
              {currentStep.key === 'business' ? (
                <div className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
                  <div className="grid gap-5 md:grid-cols-2">
                    <Field
                      label="Business name"
                      hint="Use the client-facing name that should appear throughout the workspace."
                    >
                      <input
                        value={businessName}
                        onChange={(event) => setBusinessName(event.target.value)}
                        className={fieldInputClassName}
                        placeholder="Sugar & Leather"
                      />
                    </Field>
                    <Field
                      label="Business type"
                      hint="Describe the business in plain language, not internal taxonomy."
                    >
                      <input
                        value={businessType}
                        onChange={(event) => setBusinessType(event.target.value)}
                        className={fieldInputClassName}
                        placeholder="Executive and transformational coaching network"
                      />
                    </Field>
                    <Field
                      label="Launch approver"
                      hint="Who should have the final say before anything goes live?"
                    >
                      <input
                        value={approverName}
                        onChange={(event) => setApproverName(event.target.value)}
                        className={fieldInputClassName}
                        placeholder="Audrey"
                      />
                    </Field>
                    <Field
                      label="Current source"
                      hint="Enter the website Aries should treat as the active brand source for this campaign."
                    >
                      <input
                        value={websiteUrl}
                        onChange={(event) => setWebsiteUrl(event.target.value)}
                        className={fieldInputClassName}
                        placeholder="https://aries.sugarandleather.com"
                      />
                    </Field>
                  </div>

                  <div className="grid gap-4 lg:mt-6">
                    <EditorialPanel
                      eyebrow="What this powers"
                      title="One intake feeds the full campaign flow."
                      description="The business profile, brand review, strategy review, creative package, and launch status all start from this operating baseline."
                    />
                    <EditorialList
                      title="What Aries will prepare next"
                      items={[
                        'A current-source review built from the live website.',
                        'A brand identity snapshot the client can actually approve.',
                        'A first campaign plan aligned to the selected goal and channels.',
                      ]}
                    />
                  </div>
                </div>
              ) : null}

              {currentStep.key === 'website' ? (
                <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
                  <div className="space-y-5">
                    <Field
                      label="Website"
                      hint="Use the current live website. Aries treats this as the active brand source for the first campaign."
                    >
                      <input
                        value={websiteUrl}
                        onChange={(event) => setWebsiteUrl(event.target.value)}
                        className={fieldInputClassName}
                        placeholder="https://sugarandleather.com"
                      />
                    </Field>

                    <div className="rounded-[1.5rem] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#ba8cff]">What Aries reviews</p>
                      <div className="mt-4 grid gap-3 text-sm text-white/68">
                        <div className="rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-4">
                          Brand name, promise, voice, and offer language
                        </div>
                        <div className="rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-4">
                          Visual identity cues like logos, palette, and typography
                        </div>
                        <div className="rounded-[1rem] border border-white/10 bg-white/[0.03] px-4 py-4">
                          The current source URL that must stay attached to the campaign
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-[1.7rem] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-6">
                    <div className="space-y-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#ba8cff]">Website review</p>
                      <h3 className="text-2xl font-semibold text-white">{previewBrandName}</h3>
                      <p className="text-sm text-white/50">{previewDomain}</p>
                      <p className="text-sm leading-7 text-white/68">{brandPreviewSummary(preview, urlPreview)}</p>
                    </div>

                    {previewLoading ? (
                      <div className="mt-6 rounded-[1.25rem] border border-white/10 bg-white/[0.04] px-4 py-4 text-sm text-white/62">
                        Preparing the brand preview from the current source website.
                      </div>
                    ) : previewError ? (
                      <div className="mt-6 rounded-[1.25rem] border border-amber-300/20 bg-amber-300/10 px-4 py-4 text-sm text-amber-100">
                        {previewError}
                      </div>
                    ) : preview ? (
                      <div className="mt-6 grid gap-4 sm:grid-cols-2">
                        <PreviewStat label="Brand voice" value={preview.brandVoiceSummary || 'Aries will refine the brand voice after the source review.'} />
                        <PreviewStat label="Offer" value={preview.offerSummary || 'Aries will refine the offer summary after the source review.'} />
                        <PreviewStat label="Current source" value={firstPresent(preview.canonicalUrl, websiteUrl, 'No source set yet.') || ''} />
                        <PreviewStat label="Visible summary" value={brandPreviewSummary(preview, urlPreview)} />
                      </div>
                    ) : (
                      <div className="mt-6 rounded-[1.25rem] border border-white/10 bg-white/[0.04] px-4 py-4 text-sm text-white/58">
                        Enter a valid HTTPS website to prepare the brand snapshot.
                      </div>
                    )}
                  </div>
                </div>
              ) : null}

              {currentStep.key === 'brand' ? (
                <div className="space-y-6">
                  <div className="rounded-[2rem] border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(151,93,255,0.12),transparent_28%),linear-gradient(160deg,rgba(255,255,255,0.06),rgba(255,255,255,0.03))] p-6">
                    <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
                      <div className="space-y-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#ba8cff]">Brand identity preview</p>
                        <div>
                          <h3 className="text-3xl font-semibold tracking-[-0.03em] text-white">{previewBrandName}</h3>
                          <p className="mt-2 text-sm text-white/50">
                            {firstPresent(preview?.canonicalUrl, websiteUrl, props.initialAuthenticated && !draftId ? profile?.websiteUrl : null, 'No current source yet')}
                          </p>
                        </div>
                        <p className="max-w-2xl text-sm leading-7 text-white/70">
                          {brandPreviewSummary(preview, urlPreview)}
                        </p>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <PreviewStat
                            label="Brand voice"
                            value={preview?.brandVoiceSummary || (props.initialAuthenticated && !draftId ? profile?.brandVoice : null) || 'Aries will refine the voice as soon as the source review is complete.'}
                          />
                          <PreviewStat
                            label="Offer summary"
                            value={preview?.offerSummary || offer || (props.initialAuthenticated && !draftId ? profile?.offer : null) || 'The offer summary will appear here once the website provides enough signal.'}
                          />
                        </div>
                      </div>

                      <div className="grid gap-4">
                        <VisualBoard
                          logoUrls={preview?.logoUrls || []}
                          colors={previewColors}
                          fontFamilies={previewFonts}
                          brandName={previewBrandName}
                        />
                      </div>
                    </div>
                  </div>

                  {preview?.externalLinks && preview.externalLinks.length > 0 ? (
                    <div className="rounded-[1.6rem] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#ba8cff]">Visible brand links</p>
                      <div className="mt-4 flex flex-wrap gap-3">
                        {preview.externalLinks.map((link) => (
                          <a
                            key={`${link.platform}-${link.url}`}
                            href={link.url}
                            target="_blank"
                            rel="noreferrer"
                            className="rounded-full border border-white/12 bg-white/[0.03] px-4 py-2 text-sm text-white/76 transition hover:border-[#a96cff]/30 hover:text-white"
                          >
                            {link.platform}
                          </a>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {currentStep.key === 'channels' ? (
                <div className="space-y-5">
                  <p className="max-w-3xl text-sm leading-7 text-white/65">
                    Choose the channels Aries should prioritize first. The initial set stays lightweight so the first campaign is easy to approve and launch.
                  </p>
                  <div className="grid gap-4 md:grid-cols-2">
                    {CHANNEL_OPTIONS.map((channel) => {
                      const selected = selectedChannels.includes(channel.id);
                      return (
                        <button
                          key={channel.id}
                          type="button"
                          onClick={() => toggleChannel(channel.id)}
                          className={clsx(
                            'rounded-[1.5rem] border px-5 py-5 text-left transition',
                            selected
                              ? 'border-[#a96cff]/40 bg-[linear-gradient(180deg,rgba(151,93,255,0.16),rgba(151,93,255,0.05))] text-white shadow-[0_0_18px_rgba(169,108,255,0.12)]'
                              : 'border-white/10 bg-white/[0.03] text-white/62 hover:border-white/16 hover:bg-white/[0.04] hover:text-white',
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-base font-semibold">{channel.label}</p>
                              <p className="mt-2 text-sm leading-7 text-white/58">{channel.description}</p>
                            </div>
                            {selected ? <Check className="mt-1 h-4 w-4 text-[#d6b8ff]" /> : null}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {currentStep.key === 'goal' ? (
                <div className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
                  <div className="space-y-4">
                    <p className="text-sm leading-7 text-white/65">What should Aries help your business achieve first?</p>
                    <div className="grid gap-3">
                      {GOAL_OPTIONS.map((option) => (
                        <button
                          key={option.label}
                          type="button"
                          onClick={() => {
                            setGoal(option.label);
                            if (option.label !== 'Other') {
                              setCustomGoal('');
                            }
                          }}
                          className={clsx(
                            'rounded-[1.35rem] border px-4 py-4 text-left transition',
                            goal === option.label
                              ? 'border-[#a96cff]/40 bg-[linear-gradient(180deg,rgba(151,93,255,0.16),rgba(151,93,255,0.05))] text-white shadow-[0_0_18px_rgba(169,108,255,0.12)]'
                              : 'border-white/10 bg-white/[0.03] text-white/62 hover:border-white/16 hover:bg-white/[0.04] hover:text-white',
                          )}
                        >
                          <p className="font-medium">{option.label}</p>
                          <p className="mt-2 text-sm leading-7 text-white/58">{option.description}</p>
                        </button>
                      ))}
                      {goal === 'Other' ? (
                        <input
                          value={customGoal}
                          onChange={(event) => setCustomGoal(event.target.value)}
                          className={fieldInputClassName}
                          placeholder="Describe your business outcome goal"
                          autoFocus
                        />
                      ) : null}
                    </div>
                  </div>

                  <div className="grid gap-5">
                    <Field
                      label="What does your business offer?"
                      hint="The core product, service, or program Aries should focus the first campaign around."
                    >
                      <input
                        value={offer}
                        onChange={(event) => setOffer(event.target.value)}
                        className={fieldInputClassName}
                        placeholder="e.g. Private coaching, SaaS subscriptions, handmade jewelry"
                      />
                    </Field>

                    <Field
                      label="Competitor website"
                      hint="Optional. Add one strong comparison site if you want Aries to account for market positioning."
                    >
                      <input
                        value={competitorUrl}
                        onChange={(event) => setCompetitorUrl(event.target.value)}
                        className={fieldInputClassName}
                        placeholder="https://betterup.com"
                      />
                    </Field>

                    <div className="rounded-[1.5rem] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 text-sm leading-7 text-white/65">
                      Aries will save this operating profile, open the first campaign workspace, and carry the same brand identity through review instead of rebuilding it from scratch.
                    </div>

                  </div>
                </div>
              ) : null}
            </div>

            <div className="relative z-10 mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-white/8 pt-6">
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setStepIndex((index) => Math.max(index - 1, 0));
                }}
                disabled={stepIndex === 0 || submitting}
                className="inline-flex items-center gap-2 rounded-full border border-[#fff] bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-[#fff] transition disabled:cursor-not-allowed disabled:opacity-40 hover:border-[#fff] hover:text-[#fff]"
              >
                <ArrowLeft className="h-4 w-4 text-[#fff]" />
                Back
              </button>

              <div className="flex flex-wrap items-center gap-3">
                {error ? <p className="text-sm text-amber-200">{error}</p> : null}
                {stepIndex < STEP_DEFINITIONS.length - 1 ? (
                  <button
                    type="button"
                    onClick={handleContinue}
                    className="inline-flex items-center gap-2 rounded-full border border-[#a96cff]/40 bg-[linear-gradient(90deg,#5c2e96,#7a41c2,#a96cff)] px-6 py-3 text-sm font-semibold text-white shadow-[0_0_24px_rgba(169,108,255,0.2)] transition hover:translate-y-[-1px]"
                  >
                    Continue
                    <ArrowRight className="h-4 w-4" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleFinish()}
                    disabled={submitting || !canFinish}
                    className="inline-flex items-center gap-2 rounded-full border border-[#a96cff]/40 bg-[linear-gradient(90deg,#5c2e96,#7a41c2,#a96cff)] px-6 py-3 text-sm font-semibold text-white shadow-[0_0_24px_rgba(169,108,255,0.2)] transition hover:translate-y-[-1px] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {submitting
                      ? 'Saving setup...'
                      : props.initialAuthenticated
                        ? 'Continue to workspace'
                        : 'Save and continue'}
                    <ArrowRight className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>

            <div className="relative z-10 mt-4 rounded-[1.7rem] border border-white/10 bg-[linear-gradient(160deg,rgba(255,255,255,0.08),rgba(255,255,255,0.03))] p-5 text-sm leading-7 text-white/78 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
              <div className="flex items-center gap-3 text-[#e8d8ff]">
                <ShieldCheck className="h-4 w-4" />
                <span className="font-medium">Approval stays visible from the first plan through launch.</span>
              </div>
              <p className="mt-3 text-white/62">
                Nothing goes live without a clear review step. The source website stays attached to the campaign so stale brand material does not leak forward.
              </p>
            </div>
                </section>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="space-y-2">
      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/72">{props.label}</span>
      {props.children}
      {props.hint ? <p className="text-sm leading-7 text-white/46">{props.hint}</p> : null}
    </label>
  );
}

function EditorialPanel(props: { eyebrow: string; title: string; description: string }) {
  return (
    <div className="relative overflow-hidden rounded-[1.65rem] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.03))] p-5 shadow-[0_20px_50px_rgba(0,0,0,0.18)]">
      <p className="relative text-[11px] font-semibold uppercase tracking-[0.24em] text-[#ba8cff]">{props.eyebrow}</p>
      <h3 className="relative mt-3 text-2xl font-semibold tracking-[-0.03em] text-white">{props.title}</h3>
      <p className="relative mt-3 text-sm leading-7 text-white/66">{props.description}</p>
    </div>
  );
}

function EditorialList(props: { title: string; items: string[] }) {
  return (
    <div className="rounded-[1.6rem] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/54">{props.title}</p>
      <div className="mt-4 space-y-3">
        {props.items.map((item) => (
          <div key={item} className="rounded-[1rem] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))] px-4 py-4 text-sm leading-7 text-white/72">
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}

function PreviewStat(props: { label: string; value: string }) {
  return (
    <div className="rounded-[1.2rem] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/54">{props.label}</p>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-white/72">{props.value}</p>
    </div>
  );
}

function VisualBoard(props: {
  logoUrls: string[];
  colors: string[];
  fontFamilies: string[];
  brandName: string;
}) {
  const logoUrls = props.logoUrls.filter(Boolean);

  return (
    <div className="grid gap-4">
      <div className="rounded-[1.5rem] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/54">Logo candidates</p>
        {logoUrls.length > 0 ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {logoUrls.map((logoUrl, index) => (
              <div key={`${logoUrl}-${index}`} className="overflow-hidden rounded-[1rem] border border-white/10 bg-white px-4 py-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={logoUrl} alt={`${props.brandName} logo ${index + 1}`} className="h-20 w-full object-contain" />
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-white/55">Logo and mark references will appear here when the site exposes them clearly.</p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-[1.5rem] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/54">Palette</p>
          {props.colors.length > 0 ? (
            <div className="mt-4 grid grid-cols-3 gap-3">
              {props.colors.map((color, index) => (
                <div key={`${color}-${index}`} className="space-y-2">
                  <div className="h-14 rounded-[0.9rem] border border-white/10" style={{ backgroundColor: color }} />
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-white/55">Palette cues will appear here once the website review is ready.</p>
          )}
        </div>

        <div className="rounded-[1.5rem] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/54">Fonts</p>
          {props.fontFamilies.length > 0 ? (
            <div className="mt-4 space-y-3">
              {props.fontFamilies.map((font) => (
                <div key={font} className="rounded-[1rem] border border-white/8 bg-white/[0.03] px-4 py-4">
                  <p
                    className="text-2xl text-white"
                    style={{ fontFamily: `"${font}", ${font}, ui-sans-serif, system-ui, sans-serif` }}
                  >
                    {props.brandName}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-white/55">Type direction will appear here once the website review is ready.</p>
          )}
        </div>
      </div>
    </div>
  );
}
