'use client';

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import clsx from 'clsx';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  ShieldCheck,
} from 'lucide-react';

import { useBusinessProfile } from '@/hooks/use-business-profile';
import { createAriesV1Api, type UrlPreviewBrandKitPreview, type UrlPreviewResponse } from '@/lib/api/aries-v1';
import { validateCanonicalCompetitorUrl } from '@/lib/marketing-competitor';
import { VISUAL_BOARD_EMPTY_STATE_COPY } from './onboarding-flow.copy';

export { VISUAL_BOARD_EMPTY_STATE_COPY } from './onboarding-flow.copy';

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
    key: 'goal',
    label: 'Goal',
    title: 'What outcome matters most right now?',
    description: 'Start with the goal so every downstream step — business profile, website review, brand snapshot, and channel mix — is built around a real objective.',
  },
  {
    key: 'business',
    label: 'Business',
    title: 'Set the business Aries will represent.',
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
];

const CHANNEL_OPTIONS: ChannelOption[] = [
  {
    id: 'meta-ads',
    label: 'Meta (Facebook + Instagram Ads)',
    description: 'Paid ads on Facebook and Instagram via Meta Business Suite.',
  },
  {
    id: 'instagram',
    label: 'Instagram (Organic)',
    description: 'Organic posts, stories, and reels on Instagram.',
  },
  {
    id: 'email',
    label: 'Email Marketing',
    description: 'Automated email campaigns and sequences.',
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    description: 'Short-form video ads and organic content.',
  },
  {
    id: 'youtube',
    label: 'YouTube',
    description: 'Video ads, shorts, and channel content.',
  },
  {
    id: 'google-business',
    label: 'Google Business',
    description: 'Local presence, reviews, and Google Maps visibility.',
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    description: 'Professional network for B2B reach and thought leadership.',
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

type UrlChipState =
  | { kind: 'idle' }
  | { kind: 'valid'; hostname: string }
  | { kind: 'invalid' };

function urlChipFromValue(value: string): UrlChipState {
  const trimmed = value.trim();
  if (!trimmed) {
    return { kind: 'idle' };
  }
  const hostname = hostnameFromUrl(trimmed);
  if (!hostname || !isValidHttpsUrl(trimmed)) {
    return { kind: 'invalid' };
  }
  return { kind: 'valid', hostname };
}

function recommendedChannelsForBusinessType(businessType: string): string[] {
  const normalized = businessType.trim().toLowerCase();
  if (!normalized) {
    return ['meta-ads', 'instagram'];
  }
  const localKeywords = ['local', 'restaurant', 'retail', 'service', 'salon', 'clinic', 'store', 'shop'];
  const saasKeywords = ['saas', 'software', 'b2b', 'agency', 'platform', 'technology', 'tech'];
  const ecomKeywords = ['ecommerce', 'e-commerce', 'commerce', 'dtc', 'direct-to-consumer', 'online store', 'brand'];
  if (localKeywords.some((kw) => normalized.includes(kw))) {
    return ['meta-ads', 'instagram', 'google-business'];
  }
  if (saasKeywords.some((kw) => normalized.includes(kw))) {
    return ['linkedin', 'meta-ads', 'email'];
  }
  if (ecomKeywords.some((kw) => normalized.includes(kw))) {
    return ['meta-ads', 'instagram', 'email', 'tiktok'];
  }
  return ['meta-ads', 'instagram'];
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

function stepValidationMessage(stepKey: StepKey, values?: {
  businessName: string;
  businessType: string;
}): string | null {
  if (stepKey === 'business') {
    if (values) {
      if (!values.businessName.trim()) {
        return 'Add a business name before continuing.';
      }
      if (!values.businessType.trim()) {
        return 'Select a business type before continuing.';
      }
      return null;
    }
    return 'Add a business name before continuing.';
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

const LOCAL_DRAFT_KEY = 'aries:v1-onboarding-draft';
const LOCAL_DRAFT_VERSION = 1;

type LocalDraftSnapshot = {
  version: number;
  updatedAt: number;
  businessName: string;
  businessType: string;
  websiteUrl: string;
  approverName: string;
  selectedChannels: string[];
  goal: string;
  customGoal: string;
  offer: string;
  competitorUrl: string;
};

function readLocalDraft(): LocalDraftSnapshot | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(LOCAL_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalDraftSnapshot> | null;
    if (!parsed || parsed.version !== LOCAL_DRAFT_VERSION) return null;
    return {
      version: LOCAL_DRAFT_VERSION,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      businessName: parsed.businessName || '',
      businessType: parsed.businessType || '',
      websiteUrl: parsed.websiteUrl || '',
      approverName: parsed.approverName || '',
      selectedChannels: Array.isArray(parsed.selectedChannels) ? parsed.selectedChannels : [],
      goal: parsed.goal || '',
      customGoal: parsed.customGoal || '',
      offer: parsed.offer || '',
      competitorUrl: parsed.competitorUrl || '',
    };
  } catch {
    return null;
  }
}

function writeLocalDraft(snapshot: Omit<LocalDraftSnapshot, 'version' | 'updatedAt'>): void {
  if (typeof window === 'undefined') return;
  try {
    const payload: LocalDraftSnapshot = {
      version: LOCAL_DRAFT_VERSION,
      updatedAt: Date.now(),
      ...snapshot,
    };
    window.localStorage.setItem(LOCAL_DRAFT_KEY, JSON.stringify(payload));
  } catch {
    // storage quota or private-mode errors — degrade silently
  }
}

function clearLocalDraft(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(LOCAL_DRAFT_KEY);
  } catch {
    // ignore
  }
}

function localDraftHasContent(snapshot: LocalDraftSnapshot | null): boolean {
  if (!snapshot) return false;
  return Boolean(
    snapshot.businessName.trim() ||
      snapshot.businessType.trim() ||
      snapshot.websiteUrl.trim() ||
      snapshot.approverName.trim() ||
      snapshot.selectedChannels.length > 0 ||
      snapshot.goal.trim() ||
      snapshot.customGoal.trim() ||
      snapshot.offer.trim() ||
      snapshot.competitorUrl.trim(),
  );
}

function offerPlaceholderForBusinessType(businessType: string): string {
  const normalized = businessType.trim().toLowerCase();
  if (!normalized) {
    return "Describe your core offer and customer. Example: 'A meal-planning app for busy parents — weekly plans, one-tap grocery lists, and family-friendly recipes.'";
  }
  if (
    normalized.includes('saas') ||
    normalized.includes('software') ||
    normalized.includes('platform') ||
    normalized.includes('b2b') ||
    normalized.includes('technology') ||
    normalized.includes('tech')
  ) {
    return "Describe your core product and who it's for. Example: 'A task management SaaS for small marketing agencies that need to keep clients in the loop.'";
  }
  if (
    normalized.includes('ecommerce') ||
    normalized.includes('e-commerce') ||
    normalized.includes('retail') ||
    normalized.includes('dtc') ||
    normalized.includes('shop') ||
    normalized.includes('store') ||
    normalized.includes('commerce') ||
    normalized.includes('product')
  ) {
    return "Describe your product line and customer. Example: 'Handmade leather goods for remote workers — wallets, bags, and desk accessories.'";
  }
  if (
    normalized.includes('agency') ||
    normalized.includes('studio') ||
    normalized.includes('consult')
  ) {
    return "Describe your service and client type. Example: 'Brand design for Series A consumer startups.'";
  }
  if (
    normalized.includes('service') ||
    normalized.includes('local') ||
    normalized.includes('salon') ||
    normalized.includes('clinic') ||
    normalized.includes('restaurant') ||
    normalized.includes('florist') ||
    normalized.includes('coach')
  ) {
    return "Describe the service and customer. Example: 'A boutique floral studio serving Brooklyn weddings and event planners.'";
  }
  return "Describe your core offer and customer. Example: 'A meal-planning app for busy parents — weekly plans, one-tap grocery lists, and family-friendly recipes.'";
}

type TouchedFields = {
  businessName: boolean;
  businessType: boolean;
  approverName: boolean;
  websiteUrl: boolean;
  offer: boolean;
  competitorUrl: boolean;
  customGoal: boolean;
};

type FieldValidity = 'untouched' | 'valid' | 'invalid';

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

function replaceOnboardingUrlState(input: { draftId: string; step?: StepKey | null }): void {
  if (typeof window === 'undefined') {
    return;
  }

  const url = new URL(window.location.href);
  url.pathname = '/onboarding/start';
  url.searchParams.set('draft', input.draftId);

  if (input.step) {
    url.searchParams.set('step', input.step);
  } else {
    url.searchParams.delete('step');
  }

  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
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
  const [previewRefreshCounter, setPreviewRefreshCounter] = useState(0);
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
  const [websiteChip, setWebsiteChip] = useState<UrlChipState>({ kind: 'idle' });
  // Two separate flags: `locked` prevents the recommendation from re-firing
  // (set when the user or a loaded draft already has channels). `shown`
  // controls whether the "Recommended for {businessType}" subtitle actually
  // appears — only true when the auto-recommendation was the source of the
  // current selection. The old single-flag implementation conflated these
  // two concerns and showed the subtitle for draft-loaded selections too.
  const [channelsRecommendationLocked, setChannelsRecommendationLocked] = useState(false);
  const [channelsRecommendationShown, setChannelsRecommendationShown] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'local-saved'>('idle');
  const [touched, setTouched] = useState<TouchedFields>({
    businessName: false,
    businessType: false,
    approverName: false,
    websiteUrl: false,
    offer: false,
    competitorUrl: false,
    customGoal: false,
  });
  const [resumePromptOpen, setResumePromptOpen] = useState(false);
  const [pendingLocalDraft, setPendingLocalDraft] = useState<LocalDraftSnapshot | null>(null);
  const [resumeChecked, setResumeChecked] = useState(false);
  const [showTransition, setShowTransition] = useState(false);
  const draftApiFailedRef = useRef(false);
  const creatingDraftRef = useRef(false);
  const localSaveTimerRef = useRef<number | null>(null);
  const savedIndicatorTimerRef = useRef<number | null>(null);
  const submittingRef = useRef(false);
  const deferredWebsiteUrl = useDeferredValue(websiteUrl.trim());

  const markTouched = useCallback((field: keyof TouchedFields) => {
    setTouched((prev) => (prev[field] ? prev : { ...prev, [field]: true }));
  }, []);

  const markSaved = useCallback((kind: 'saved' | 'local-saved' = 'saved') => {
    setSaveStatus(kind);
    if (savedIndicatorTimerRef.current) {
      window.clearTimeout(savedIndicatorTimerRef.current);
    }
    savedIndicatorTimerRef.current = window.setTimeout(() => {
      setSaveStatus('idle');
      savedIndicatorTimerRef.current = null;
    }, 1500);
  }, []);

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
    // Guard duplicate fires with a ref, NOT the `creatingDraft` state — if we
    // depend on that state here we re-run the effect the moment we flip it,
    // which cancels the in-flight promise's callbacks and strands
    // `creatingDraft === true`, leaving the submit button disabled forever.
    if (draftId || creatingDraftRef.current) {
      return;
    }

    let cancelled = false;
    creatingDraftRef.current = true;
    setCreatingDraft(true);

    void ariesApi.createOnboardingDraft()
      .then((response) => {
        if (cancelled) {
          return;
        }
        const nextDraftId = response.draft.draftId;
        setDraftId(nextDraftId);
        replaceOnboardingUrlState({ draftId: nextDraftId, step: currentStep.key });
      })
      .catch(() => {
        if (!cancelled) {
          setError('We could not prepare a saved onboarding session right now.');
        }
      })
      .finally(() => {
        creatingDraftRef.current = false;
        setCreatingDraft(false);
      });

    return () => {
      cancelled = true;
    };
  }, [ariesApi, currentStep.key, draftId]);

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
        setBusinessName(nextProfile.businessName?.trim() ? nextProfile.businessName.trim() : '');
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
    // Don't autosave until the draft has been hydrated from the server (or
    // freshly created locally). Without this guard, landing on
    // /onboarding/start?draft=XXX would fire this effect immediately with
    // the initial empty field values and overwrite the server draft.
    if (loadedDraftId !== draftId) {
      return;
    }

    setSaveStatus('saving');
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
      })
        .then(() => {
          draftApiFailedRef.current = false;
          markSaved('saved');
        })
        .catch(() => {
          // Draft API failed — fall back to localStorage below so the user
          // doesn't lose their in-progress inputs.
          draftApiFailedRef.current = true;
          setSaveStatus('idle');
        });
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
    loadedDraftId,
    markSaved,
  ]);

  // localStorage fallback: always write a debounced snapshot so unauthenticated
  // users (no draftId yet) and users where the draft API failed don't lose
  // their inputs on refresh. Skips the write for empty drafts so we don't
  // leave an empty key around (and so a recently cleared draft doesn't get
  // re-created by a trailing debounced tick). Also suppressed while submitting
  // / transitioning so clearLocalDraft() sticks.
  useEffect(() => {
    if (submittingRef.current) return;
    if (localSaveTimerRef.current) {
      window.clearTimeout(localSaveTimerRef.current);
    }
    localSaveTimerRef.current = window.setTimeout(() => {
      const snapshot = {
        businessName,
        businessType,
        websiteUrl,
        approverName,
        selectedChannels,
        goal,
        customGoal,
        offer,
        competitorUrl,
      };
      const hasContent =
        snapshot.businessName.trim() ||
        snapshot.businessType.trim() ||
        snapshot.websiteUrl.trim() ||
        snapshot.approverName.trim() ||
        snapshot.selectedChannels.length > 0 ||
        snapshot.goal.trim() ||
        snapshot.customGoal.trim() ||
        snapshot.offer.trim() ||
        snapshot.competitorUrl.trim();
      if (hasContent) {
        writeLocalDraft(snapshot);
        if (!draftId || draftApiFailedRef.current) {
          markSaved('local-saved');
        }
      } else {
        clearLocalDraft();
      }
      localSaveTimerRef.current = null;
    }, 500);
    return () => {
      if (localSaveTimerRef.current) {
        window.clearTimeout(localSaveTimerRef.current);
        localSaveTimerRef.current = null;
      }
    };
  }, [
    approverName,
    businessName,
    businessType,
    competitorUrl,
    customGoal,
    draftId,
    goal,
    offer,
    selectedChannels,
    websiteUrl,
    markSaved,
  ]);

  // Check for local draft on mount and offer to restore.
  useEffect(() => {
    if (resumeChecked) return;
    const snapshot = readLocalDraft();
    setResumeChecked(true);
    if (!localDraftHasContent(snapshot)) {
      return;
    }
    // If we already have a server draft with content, skip the prompt — the
    // server draft always wins.
    if (draftParam) {
      return;
    }
    // If the authenticated user already has a business profile, the hydrate
    // effect will populate things — don't confuse with an older local draft.
    if (props.initialAuthenticated) {
      return;
    }
    setPendingLocalDraft(snapshot);
    setResumePromptOpen(true);
  }, [draftParam, props.initialAuthenticated, resumeChecked]);

  useEffect(() => {
    if (currentStep.key !== 'website') {
      return;
    }
    if (websiteChip.kind !== 'idle') {
      return;
    }
    const trimmed = websiteUrl.trim();
    if (!trimmed) {
      return;
    }
    setWebsiteChip(urlChipFromValue(trimmed));
  }, [currentStep.key, websiteChip.kind, websiteUrl]);

  useEffect(() => {
    if (currentStep.key !== 'channels') {
      return;
    }
    if (channelsRecommendationLocked) {
      return;
    }
    if (selectedChannels.length > 0) {
      // User (or a loaded draft) already has channels — lock the recommender
      // so unchecking back down to zero doesn't trigger a surprise re-select,
      // but leave `shown` false so the "Recommended for {businessType}"
      // subtitle doesn't appear for user-selected or draft-loaded channels.
      setChannelsRecommendationLocked(true);
      return;
    }
    if (!businessType.trim()) {
      return;
    }
    // Filter the recommendation against the actual rendered CHANNEL_OPTIONS
    // so we never pre-select an id that doesn't appear in the UI. Without
    // this filter a user could be pre-selected to e.g. `email` or
    // `instagram-organic` that aren't rendered in this flow's option list,
    // pass the channels step's canProceed check (selectedChannels.length > 0),
    // and send unsupported ids downstream with no visible selection.
    const availableIds = new Set(CHANNEL_OPTIONS.map((option) => option.id));
    const recommended = recommendedChannelsForBusinessType(businessType).filter(
      (id) => availableIds.has(id),
    );
    if (recommended.length === 0) {
      return;
    }
    setSelectedChannels(recommended);
    setChannelsRecommendationLocked(true);
    setChannelsRecommendationShown(true);
  }, [currentStep.key, selectedChannels.length, channelsRecommendationLocked, businessType]);

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
  }, [ariesApi, deferredWebsiteUrl, draftId, previewRefreshCounter]);

  function toggleChannel(channelId: string) {
    setSelectedChannels((current) =>
      current.includes(channelId)
        ? current.filter((value) => value !== channelId)
        : [...current, channelId],
    );
  }

  function handleResumeLocalDraft() {
    if (!pendingLocalDraft) {
      setResumePromptOpen(false);
      return;
    }
    const snap = pendingLocalDraft;
    setBusinessName(snap.businessName);
    setBusinessType(snap.businessType);
    setWebsiteUrl(snap.websiteUrl);
    setApproverName(snap.approverName);
    setSelectedChannels(snap.selectedChannels);
    setGoal(snap.goal);
    setCustomGoal(snap.customGoal);
    setOffer(snap.offer);
    setCompetitorUrl(snap.competitorUrl);
    setResumePromptOpen(false);
    setPendingLocalDraft(null);
  }

  function handleDismissResume() {
    setResumePromptOpen(false);
    setPendingLocalDraft(null);
    if (localSaveTimerRef.current) {
      window.clearTimeout(localSaveTimerRef.current);
      localSaveTimerRef.current = null;
    }
    clearLocalDraft();
  }

  function handleContinue() {
    if (!stepReady(currentStep.key, { businessName, businessType, websiteUrl, selectedChannels, goal, customGoal })) {
      setError(stepValidationMessage(currentStep.key, { businessName, businessType }) ?? 'Complete the current step before continuing.');
      return;
    }
    setError(null);
    setStepIndex((index) => Math.min(index + 1, STEP_DEFINITIONS.length - 1));
  }

  async function handleFinish() {
    if (!canFinish) {
      setError(stepValidationMessage(currentStep.key, { businessName, businessType }) ?? 'Complete the current step before continuing.');
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
        replaceOnboardingUrlState({ draftId: activeDraftId, step: currentStep.key });
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

      // Freeze autosave and cancel any pending debounced write so the draft
      // doesn't get re-written between clearLocalDraft() and navigation.
      submittingRef.current = true;
      if (localSaveTimerRef.current) {
        window.clearTimeout(localSaveTimerRef.current);
        localSaveTimerRef.current = null;
      }
      clearLocalDraft();

      if (props.initialAuthenticated) {
        // Show the full-screen "Building your first campaign plan" state and
        // navigate immediately. The transition component stays mounted until
        // Next.js finishes server-rendering /onboarding/resume (which can
        // take 10-30s while the marketing job materializes), so the user
        // sees continuous feedback without the 1.8s timer race that caused
        // earlier "button loops to the same page" reports where the timer
        // and the unmount cleanup fought each other.
        setShowTransition(true);
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

  const businessNameValidity: FieldValidity = !touched.businessName
    ? 'untouched'
    : businessName.trim().length > 0
      ? 'valid'
      : 'invalid';
  const businessTypeValidity: FieldValidity = !touched.businessType
    ? 'untouched'
    : businessType.trim().length > 0
      ? 'valid'
      : 'invalid';
  const websiteUrlValidity: FieldValidity = !touched.websiteUrl
    ? 'untouched'
    : websiteUrl.trim().length === 0
      ? 'invalid'
      : isValidHttpsUrl(websiteUrl)
        ? 'valid'
        : 'invalid';
  const competitorUrlValidity: FieldValidity = !touched.competitorUrl
    ? 'untouched'
    : competitorUrl.trim().length === 0
      ? 'valid' // optional field
      : isValidHttpsUrl(competitorUrl)
        ? 'valid'
        : 'invalid';
  const offerValidity: FieldValidity = touched.offer && offer.trim().length > 0 ? 'valid' : 'untouched';
  const customGoalValidity: FieldValidity = !touched.customGoal
    ? 'untouched'
    : customGoal.trim().length > 0
      ? 'valid'
      : 'invalid';

  function inputClassForValidity(validity: FieldValidity): string {
    if (validity === 'valid') {
      return clsx(fieldInputClassName, 'border-emerald-500/40 focus:border-emerald-400');
    }
    if (validity === 'invalid') {
      return clsx(fieldInputClassName, 'border-red-500/50 focus:border-red-400');
    }
    return fieldInputClassName;
  }

  function fieldErrorMessage(field: keyof TouchedFields): string | null {
    if (!touched[field]) return null;
    switch (field) {
      case 'businessName':
        return businessName.trim() ? null : 'Add a business name.';
      case 'businessType':
        return businessType.trim() ? null : 'Describe the business in plain language.';
      case 'websiteUrl': {
        if (!websiteUrl.trim()) return 'Enter a website so Aries can analyze it.';
        return isValidHttpsUrl(websiteUrl) ? null : 'Enter a valid HTTPS URL (e.g. https://yourbusiness.com).';
      }
      case 'competitorUrl': {
        if (!competitorUrl.trim()) return null; // optional
        return isValidHttpsUrl(competitorUrl) ? null : 'Enter a valid HTTPS URL for the competitor.';
      }
      case 'customGoal':
        return customGoal.trim() ? null : 'Describe the business outcome you want.';
      case 'offer':
      case 'approverName':
      default:
        return null;
    }
  }

  if (showTransition) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#07080d] text-white px-4">
        <div className="relative max-w-md w-full rounded-[2rem] border border-white/14 bg-[linear-gradient(180deg,rgba(28,24,39,0.6),rgba(14,12,20,0.36))] px-8 py-10 text-center shadow-[0_34px_110px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.22)] backdrop-blur-[30px]">
          <div className="pointer-events-none absolute inset-0 rounded-[2rem] bg-[radial-gradient(circle_at_top,rgba(171,108,255,0.18),transparent_55%)]" />
          <div className="relative z-10 flex flex-col items-center gap-5">
            <Image
              src="/ariesai-logo.webp"
              alt="Aries"
              width={72}
              height={72}
              className="h-16 w-16 opacity-90"
            />
            <div className="flex items-center gap-3">
              <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin text-[#c8a6ff]" />
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#ba8cff]">
                Building your first campaign plan
              </p>
            </div>
            <h2 className="text-2xl font-semibold tracking-[-0.02em] text-white">
              All set — we&apos;ll take it from here.
            </h2>
            <p className="text-sm leading-7 text-white/66">
              This usually takes 10–30 seconds. We&apos;ll open the workspace as soon as it&apos;s ready.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen overflow-hidden bg-[#07080d] text-white">
      {resumePromptOpen && pendingLocalDraft ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="resume-prompt-title"
          aria-describedby="resume-prompt-body"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              handleDismissResume();
            }
          }}
        >
          <div className="w-full max-w-md rounded-[1.5rem] border border-white/14 bg-[linear-gradient(180deg,rgba(28,24,39,0.9),rgba(14,12,20,0.85))] p-6 shadow-[0_34px_110px_rgba(0,0,0,0.55)]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#ba8cff]">
              Welcome back
            </p>
            <h3 id="resume-prompt-title" className="mt-2 text-xl font-semibold text-white">Resume where you left off?</h3>
            <p id="resume-prompt-body" className="mt-3 text-sm leading-7 text-white/66">
              We saved your onboarding inputs in this browser. Continue from your last session, or start over.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={handleResumeLocalDraft}
                autoFocus
                className="inline-flex items-center gap-2 rounded-full border border-[#a96cff]/40 bg-[linear-gradient(90deg,#5c2e96,#7a41c2,#a96cff)] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_0_24px_rgba(169,108,255,0.2)] transition hover:translate-y-[-1px]"
              >
                Continue
                <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={handleDismissResume}
                className="inline-flex items-center gap-2 rounded-full border border-white/16 bg-white/[0.04] px-5 py-2.5 text-sm font-medium text-white/78 transition hover:border-white/30 hover:text-white"
              >
                Start over
              </button>
            </div>
          </div>
        </div>
      ) : null}

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
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <p className="text-xs font-medium uppercase tracking-[0.22em] text-white/52">
                  Takes ~3 minutes · Step {stepIndex + 1} of {STEP_DEFINITIONS.length}
                </p>
                <SaveIndicator status={saveStatus} />
              </div>
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
                      validity={businessNameValidity}
                      error={fieldErrorMessage('businessName')}
                    >
                      <input
                        value={businessName}
                        onChange={(event) => setBusinessName(event.target.value)}
                        onBlur={() => markTouched('businessName')}
                        className={inputClassForValidity(businessNameValidity)}
                        placeholder="Sugar & Leather"
                      />
                    </Field>
                    <Field
                      label="Business type"
                      hint="Describe the business in plain language, not internal taxonomy."
                      validity={businessTypeValidity}
                      error={fieldErrorMessage('businessType')}
                    >
                      <input
                        value={businessType}
                        onChange={(event) => setBusinessType(event.target.value)}
                        onBlur={() => markTouched('businessType')}
                        className={inputClassForValidity(businessTypeValidity)}
                        placeholder="Executive and transformational coaching network"
                      />
                    </Field>
                    <Field
                      label="Launch approver"
                      hint="Who should have the final say before anything goes live?"
                      optional
                    >
                      <input
                        value={approverName}
                        onChange={(event) => setApproverName(event.target.value)}
                        onBlur={() => markTouched('approverName')}
                        className={fieldInputClassName}
                        placeholder="Your name"
                      />
                    </Field>
                    <Field
                      label="Current source"
                      hint="Enter the website Aries should treat as the active brand source for this campaign."
                      validity={websiteUrlValidity}
                      error={fieldErrorMessage('websiteUrl')}
                    >
                      <input
                        value={websiteUrl}
                        onChange={(event) => setWebsiteUrl(event.target.value)}
                        onBlur={() => markTouched('websiteUrl')}
                        className={inputClassForValidity(websiteUrlValidity)}
                        placeholder="https://yourbusiness.com"
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
                      validity={websiteUrlValidity}
                      error={fieldErrorMessage('websiteUrl')}
                    >
                      <input
                        value={websiteUrl}
                        onChange={(event) => {
                          setWebsiteUrl(event.target.value);
                          setUrlPreview(null);
                          setPreviewError(null);
                          setWebsiteChip({ kind: 'idle' });
                        }}
                        onBlur={() => {
                          markTouched('websiteUrl');
                          setWebsiteChip(urlChipFromValue(websiteUrl));
                        }}
                        className={inputClassForValidity(websiteUrlValidity)}
                        placeholder="https://yourbusiness.com"
                      />
                      {websiteChip.kind === 'valid' ? (
                        <div className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-medium">
                          <Check className="w-3.5 h-3.5" /> {websiteChip.hostname} — ready to analyze
                        </div>
                      ) : null}
                      {websiteChip.kind === 'invalid' ? (
                        <div className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-medium">
                          <span aria-hidden>✗</span> Enter a valid HTTPS website
                        </div>
                      ) : null}
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

                    {(() => {
                      // Only show the emerald "ready to analyze" chip for a
                      // URL that would actually pass step validation
                      // (isValidHttpsUrl gates Continue and the preview fetch).
                      // Parsing with `new URL()` alone accepts http:// and
                      // other non-https schemes, which would show a green
                      // success state for a URL that still blocks the user.
                      const readyHostname = isValidHttpsUrl(websiteUrl)
                        ? hostnameFromUrl(websiteUrl.trim())
                        : null;
                      return previewLoading ? (
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
                      ) : readyHostname ? (
                        <div className="mt-6 rounded-[1.25rem] border border-emerald-500/30 bg-emerald-500/10 px-4 py-4 text-sm text-emerald-100">
                          {`✓ ${readyHostname} — ready to analyze`}
                        </div>
                      ) : (
                        <div className="mt-6 rounded-[1.25rem] border border-white/10 bg-white/[0.04] px-4 py-4 text-sm text-white/58">
                          Enter a valid HTTPS website to prepare the brand snapshot.
                        </div>
                      );
                    })()}
                  </div>
                </div>
              ) : null}

              {currentStep.key === 'brand' ? (
                <div className="space-y-6">
                  {previewLoading ? (
                    <div className="rounded-[2rem] border border-white/10 bg-[linear-gradient(160deg,rgba(255,255,255,0.06),rgba(255,255,255,0.03))] p-6 animate-pulse">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#ba8cff] mb-4">Analyzing your site...</p>
                      <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
                        <div className="space-y-4">
                          <div className="h-8 w-48 rounded-[0.75rem] bg-white/10" />
                          <div className="h-4 w-64 rounded-[0.5rem] bg-white/[0.06]" />
                          <div className="space-y-2">
                            <div className="h-3 w-full rounded-[0.5rem] bg-white/[0.06]" />
                            <div className="h-3 w-5/6 rounded-[0.5rem] bg-white/[0.06]" />
                            <div className="h-3 w-4/6 rounded-[0.5rem] bg-white/[0.06]" />
                          </div>
                          <div className="grid gap-4 sm:grid-cols-2">
                            <div className="h-20 rounded-[1rem] bg-white/[0.05]" />
                            <div className="h-20 rounded-[1rem] bg-white/[0.05]" />
                          </div>
                        </div>
                        <div className="grid gap-4">
                          <div className="h-32 rounded-[1.5rem] bg-white/[0.05]" />
                          <div className="h-20 rounded-[1.5rem] bg-white/[0.05]" />
                        </div>
                      </div>
                    </div>
                  ) : previewError ? (
                    <div className="rounded-[2rem] border border-amber-400/20 bg-amber-400/[0.06] p-6">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-amber-300 mb-3">Brand analysis failed</p>
                      <p className="text-sm leading-7 text-amber-100/80 mb-4">{previewError}</p>
                      <button
                        type="button"
                        onClick={() => {
                          setUrlPreview(null);
                          setPreviewError(null);
                          // Bump the refresh counter — the preview useEffect
                          // lists it in deps, so incrementing is enough to
                          // re-run the fetch without churning websiteUrl (and
                          // without the fragile setTimeout batching trick).
                          setPreviewRefreshCounter((n) => n + 1);
                        }}
                        className="inline-flex items-center gap-2 rounded-full border border-amber-400/30 bg-amber-400/10 px-4 py-2 text-sm font-medium text-amber-200 transition hover:bg-amber-400/20"
                      >
                        Retry analysis
                      </button>
                    </div>
                  ) : (
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
                  )}

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
                  {channelsRecommendationShown && businessType.trim() ? (
                    <p className="max-w-3xl text-xs font-medium uppercase tracking-[0.22em] text-[#ba8cff]">
                      Recommended for {businessType.trim()}
                    </p>
                  ) : null}
                  <div className="grid gap-4 md:grid-cols-2" role="group" aria-label="Campaign channels">
                    {CHANNEL_OPTIONS.map((channel) => {
                      const selected = selectedChannels.includes(channel.id);
                      return (
                        <button
                          key={channel.id}
                          type="button"
                          role="checkbox"
                          aria-checked={selected}
                          tabIndex={0}
                          onClick={() => toggleChannel(channel.id)}
                          onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              toggleChannel(channel.id);
                            }
                          }}
                          className={clsx(
                            'rounded-[1.5rem] border px-5 py-5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a96cff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#07080d]',
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
                            {selected ? <Check className="mt-1 h-4 w-4 text-[#d6b8ff]" aria-hidden /> : null}
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
                    <div className="grid gap-3" role="radiogroup" aria-label="Campaign goal">
                      {GOAL_OPTIONS.map((option) => {
                        const active = goal === option.label;
                        return (
                          <button
                            key={option.label}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            tabIndex={0}
                            onClick={() => {
                              setGoal(option.label);
                              if (option.label !== 'Other') {
                                setCustomGoal('');
                              }
                            }}
                            onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                setGoal(option.label);
                                if (option.label !== 'Other') {
                                  setCustomGoal('');
                                }
                              }
                            }}
                            className={clsx(
                              'rounded-[1.35rem] border px-4 py-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a96cff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#07080d]',
                              active
                                ? 'border-[#a96cff]/40 bg-[linear-gradient(180deg,rgba(151,93,255,0.16),rgba(151,93,255,0.05))] text-white shadow-[0_0_18px_rgba(169,108,255,0.12)]'
                                : 'border-white/10 bg-white/[0.03] text-white/62 hover:border-white/16 hover:bg-white/[0.04] hover:text-white',
                            )}
                          >
                            <p className="font-medium">{option.label}</p>
                            <p className="mt-2 text-sm leading-7 text-white/58">{option.description}</p>
                          </button>
                        );
                      })}
                      {goal === 'Other' ? (
                        <div className="space-y-2">
                          <input
                            value={customGoal}
                            onChange={(event) => setCustomGoal(event.target.value)}
                            onBlur={() => markTouched('customGoal')}
                            className={inputClassForValidity(customGoalValidity)}
                            placeholder="Describe your business outcome goal"
                            autoFocus
                          />
                          {fieldErrorMessage('customGoal') ? (
                            <p className="text-xs text-red-400">{fieldErrorMessage('customGoal')}</p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="grid gap-5">
                    <div
                      className={clsx(
                        'space-y-3 rounded-[1.5rem] border p-5 shadow-[0_20px_50px_rgba(0,0,0,0.18)] transition',
                        offerValidity === 'valid'
                          ? 'border-emerald-500/40 bg-[linear-gradient(180deg,rgba(16,185,129,0.06),rgba(255,255,255,0.02))]'
                          : 'border-[#a96cff]/35 bg-[linear-gradient(180deg,rgba(151,93,255,0.08),rgba(255,255,255,0.02))]',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <label
                          htmlFor="onboarding-core-offer"
                          className="text-sm font-semibold uppercase tracking-[0.18em] text-white"
                        >
                          What does your business offer?
                        </label>
                        {offerValidity === 'valid' ? (
                          <Check className="h-4 w-4 text-emerald-400" aria-hidden />
                        ) : null}
                      </div>
                      <p className="text-xs leading-6 text-[#d6b8ff]">
                        The more specific you are, the better Aries will do.
                      </p>
                      <textarea
                        id="onboarding-core-offer"
                        value={offer}
                        onChange={(event) => setOffer(event.target.value)}
                        onBlur={() => markTouched('offer')}
                        rows={4}
                        className={clsx(
                          'w-full rounded-[1rem] border bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] px-4 py-3 text-white outline-none transition duration-200 placeholder:text-white/32 focus:border-[#b36cff] focus:shadow-[0_0_0_1px_rgba(179,108,255,0.24),0_0_24px_rgba(179,108,255,0.14)]',
                          offerValidity === 'valid'
                            ? 'border-emerald-500/50'
                            : 'border-[#a96cff]/30',
                        )}
                        placeholder={offerPlaceholderForBusinessType(businessType)}
                      />
                    </div>

                    <Field
                      label="Competitor website"
                      hint="Add one strong comparison site if you want Aries to account for market positioning."
                      optional
                      validity={competitorUrlValidity}
                      error={fieldErrorMessage('competitorUrl')}
                    >
                      <input
                        value={competitorUrl}
                        onChange={(event) => setCompetitorUrl(event.target.value)}
                        onBlur={() => markTouched('competitorUrl')}
                        className={inputClassForValidity(competitorUrlValidity)}
                        placeholder="https://competitor.com"
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
                    disabled={submitting || !canFinish || creatingDraft}
                    className="inline-flex items-center gap-2 rounded-full border border-[#a96cff]/40 bg-[linear-gradient(90deg,#5c2e96,#7a41c2,#a96cff)] px-6 py-3 text-sm font-semibold text-white shadow-[0_0_24px_rgba(169,108,255,0.2)] transition hover:translate-y-[-1px] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {submitting
                      ? 'Saving setup...'
                      : props.initialAuthenticated
                        ? 'Continue to Dashboard'
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

function Field(props: {
  label: string;
  hint?: string;
  children: ReactNode;
  optional?: boolean;
  validity?: FieldValidity;
  error?: string | null;
}) {
  const validity = props.validity ?? 'untouched';
  return (
    <label className="space-y-2">
      <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/72">
        {props.label}
        {props.optional ? (
          <span className="text-xs font-normal normal-case tracking-normal text-white/40">(optional)</span>
        ) : null}
        {validity === 'valid' ? <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden /> : null}
      </span>
      {props.children}
      {props.error ? (
        <p className="text-xs text-red-400">{props.error}</p>
      ) : props.hint ? (
        <p className="text-sm leading-7 text-white/46">{props.hint}</p>
      ) : null}
    </label>
  );
}

function SaveIndicator(props: { status: 'idle' | 'saving' | 'saved' | 'local-saved' }) {
  if (props.status === 'idle') return null;
  if (props.status === 'saving') {
    return (
      <span
        aria-live="polite"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-white/45"
      >
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        Saving…
      </span>
    );
  }
  return (
    <span
      aria-live="polite"
      className="inline-flex items-center gap-1.5 text-xs font-medium text-white/55"
    >
      <Check className="h-3 w-3 text-emerald-400" aria-hidden />
      {props.status === 'local-saved' ? 'Progress saved in this browser' : 'Progress saved'}
    </span>
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
          <p className="mt-4 text-sm text-white/55">{VISUAL_BOARD_EMPTY_STATE_COPY.logos}</p>
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
            <p className="mt-4 text-sm text-white/55">{VISUAL_BOARD_EMPTY_STATE_COPY.palette}</p>
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
            <p className="mt-4 text-sm text-white/55">{VISUAL_BOARD_EMPTY_STATE_COPY.fonts}</p>
          )}
        </div>
      </div>
    </div>
  );
}
