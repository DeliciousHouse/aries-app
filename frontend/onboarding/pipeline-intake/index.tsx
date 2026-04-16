'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2 } from 'lucide-react';
import ProgressIndicator from './components/ProgressIndicator';
import BrandStep from './steps/BrandStep';
import CompetitorStep from './steps/CompetitorStep';
import GoalStep from './steps/GoalStep';
import ChannelsStep from './steps/ChannelsStep';
import ExecutionStep from './steps/ExecutionStep';
import type { Channel, ExecutionMode, Goal, PipelineInput } from './types';

type StepIndex = 0 | 1 | 2 | 3 | 4;

const LOCAL_DRAFT_KEY = 'aries:pipeline-intake-draft';
const LOCAL_DRAFT_VERSION = 1;

type LocalDraft = {
  version: number;
  brandUrl: string;
  competitorUrl: string;
  goal: Goal | null;
  channels: Channel[];
  mode: ExecutionMode | null;
};

function readLocalDraft(): LocalDraft | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LOCAL_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalDraft> | null;
    if (!parsed || parsed.version !== LOCAL_DRAFT_VERSION) return null;
    return {
      version: LOCAL_DRAFT_VERSION,
      brandUrl: parsed.brandUrl || '',
      competitorUrl: parsed.competitorUrl || '',
      goal: (parsed.goal as Goal | null) ?? null,
      channels: Array.isArray(parsed.channels) ? (parsed.channels as Channel[]) : [],
      mode: (parsed.mode as ExecutionMode | null) ?? null,
    };
  } catch {
    return null;
  }
}

function clearLocalDraft() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(LOCAL_DRAFT_KEY);
  } catch {
    // ignore
  }
}

function writeLocalDraft(draft: Omit<LocalDraft, 'version'>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      LOCAL_DRAFT_KEY,
      JSON.stringify({ version: LOCAL_DRAFT_VERSION, ...draft }),
    );
  } catch {
    // ignore
  }
}

function hasDraftContent(draft: LocalDraft | null): boolean {
  if (!draft) return false;
  return Boolean(
    draft.brandUrl.trim() ||
      draft.competitorUrl.trim() ||
      draft.goal ||
      (draft.channels && draft.channels.length > 0) ||
      draft.mode,
  );
}

export default function PipelineIntake() {
  const router = useRouter();
  const [step, setStep] = useState<StepIndex>(0);
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');

  // Form state
  const [brandUrl, setBrandUrl] = useState('');
  const [competitorUrl, setCompetitorUrl] = useState('');
  const [goal, setGoal] = useState<Goal | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [mode, setMode] = useState<ExecutionMode | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [showTransition, setShowTransition] = useState(false);
  const draftSaveTimer = useRef<number | null>(null);
  const restoredIndicatorTimer = useRef<number | null>(null);

  // Restore draft from localStorage on mount
  useEffect(() => {
    const snapshot = readLocalDraft();
    if (hasDraftContent(snapshot) && snapshot) {
      setBrandUrl(snapshot.brandUrl);
      setCompetitorUrl(snapshot.competitorUrl);
      setGoal(snapshot.goal);
      setChannels(snapshot.channels);
      setMode(snapshot.mode);
      setDraftRestored(true);
      if (restoredIndicatorTimer.current) {
        window.clearTimeout(restoredIndicatorTimer.current);
      }
      restoredIndicatorTimer.current = window.setTimeout(() => {
        setDraftRestored(false);
        restoredIndicatorTimer.current = null;
      }, 4000);
    }
    setDraftHydrated(true);
    return () => {
      if (restoredIndicatorTimer.current) {
        window.clearTimeout(restoredIndicatorTimer.current);
      }
    };
  }, []);

  // Debounced localStorage save on any state change
  useEffect(() => {
    if (!draftHydrated) return;
    if (draftSaveTimer.current) {
      window.clearTimeout(draftSaveTimer.current);
    }
    draftSaveTimer.current = window.setTimeout(() => {
      writeLocalDraft({ brandUrl, competitorUrl, goal, channels, mode });
      draftSaveTimer.current = null;
    }, 500);
    return () => {
      if (draftSaveTimer.current) {
        window.clearTimeout(draftSaveTimer.current);
        draftSaveTimer.current = null;
      }
    };
  }, [brandUrl, competitorUrl, goal, channels, mode, draftHydrated]);

  const dismissRestored = useCallback(() => {
    setDraftRestored(false);
    if (restoredIndicatorTimer.current) {
      window.clearTimeout(restoredIndicatorTimer.current);
      restoredIndicatorTimer.current = null;
    }
  }, []);

  const goNext = () => {
    setDirection('forward');
    setStep((s) => Math.min(s + 1, 4) as StepIndex);
  };

  const goBack = () => {
    setDirection('back');
    setStep((s) => Math.max(s - 1, 0) as StepIndex);
  };

  const handleSubmit = async () => {
    if (!goal) {
      setSubmitError('Select a campaign goal on Step 1 before launching.');
      return;
    }
    if (!brandUrl) {
      setSubmitError('Enter your brand URL on Step 2 before launching.');
      return;
    }
    if (!competitorUrl) {
      setSubmitError('Enter a competitor URL on Step 3 before launching.');
      return;
    }
    if (channels.length === 0) {
      setSubmitError('Select at least one channel on Step 4 before launching.');
      return;
    }
    if (!mode) {
      setSubmitError('Pick an execution mode on Step 5 before launching.');
      return;
    }

    const payload: PipelineInput = {
      brand_url: brandUrl,
      competitor_url: competitorUrl,
      goal,
      channels,
      mode,
    };

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const res = await fetch('/api/marketing/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobType: 'brand_campaign',
          payload: {
            brandUrl: brandUrl,
            competitorUrl: competitorUrl,
            goal,
            channels,
            mode,
          },
        }),
      });

      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        jobId?: string;
        jobStatusUrl?: string;
      };

      if (!res.ok) {
        throw new Error(body.error || body.message || `Request failed: ${res.status}`);
      }

      const nextUrl = body.jobStatusUrl?.trim() || `/marketing/job-status?jobId=${encodeURIComponent(body.jobId ?? '')}`;
      if (!body.jobId?.trim()) {
        throw new Error('Marketing job response missing jobId');
      }
      // Clear the local draft now that the submission succeeded so a refresh
      // later doesn't re-offer stale inputs.
      clearLocalDraft();
      // Show a brief transition screen so the user sees a clear "we've got
      // it, building your first campaign" state before the redirect.
      setShowTransition(true);
      window.setTimeout(() => {
        router.push(nextUrl);
      }, 1800);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Something went wrong');
      setIsSubmitting(false);
    }
  };

  if (showTransition) {
    return (
      <div
        className="min-h-screen flex items-center justify-center px-4"
        style={{ backgroundColor: '#0a0a0f' }}
      >
        <div className="w-full max-w-md rounded-2xl border border-[#1e1e2e] bg-[#0f0f17] px-8 py-10 text-center">
          <p className="text-[11px] uppercase tracking-[0.28em] text-aries-crimson font-medium mb-3">Aries</p>
          <div className="flex items-center justify-center gap-3 mb-5">
            <Loader2 className="w-5 h-5 text-aries-crimson animate-spin" />
            <p className="text-xs uppercase tracking-[0.2em] text-[#888] font-medium">
              Building your first campaign
            </p>
          </div>
          <h2 className="text-xl font-semibold text-white mb-3">
            All set — we&apos;ll take it from here.
          </h2>
          <p className="text-sm text-[#888] leading-relaxed">
            This usually takes 10–30 seconds. We&apos;ll open the workspace as soon as it&apos;s ready.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-start px-4 py-12"
      style={{ backgroundColor: '#0a0a0f' }}
    >
      {/* Logo / brand mark */}
      <div className="mb-8 text-center">
        <p className="text-xs uppercase tracking-[0.3em] text-aries-crimson font-medium mb-1">Aries</p>
        <h1 className="text-xl font-bold text-white">Pipeline Setup</h1>
      </div>

      {/* Draft restored indicator */}
      {draftRestored && (
        <div
          className="mb-4 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-medium"
          role="status"
        >
          <Check className="w-3.5 h-3.5" />
          Draft restored
          <button
            type="button"
            onClick={dismissRestored}
            aria-label="Dismiss draft restored notice"
            className="ml-1 text-emerald-400/70 hover:text-emerald-300"
          >
            ×
          </button>
        </div>
      )}

      {/* Progress */}
      <ProgressIndicator currentStep={step} />

      {/* Step panel */}
      <div
        key={step}
        className={`w-full max-w-2xl transition-all duration-300 ${
          direction === 'forward' ? 'animate-fade-in' : 'animate-fade-in'
        }`}
        style={{
          animation: 'fadeSlideIn 0.25s ease-out both',
        }}
      >
        {step === 0 && (
          <GoalStep goal={goal} onGoalChange={setGoal} onNext={goNext} onBack={undefined} />
        )}
        {step === 1 && (
          <BrandStep
            brandUrl={brandUrl}
            onBrandUrlChange={setBrandUrl}
            onNext={goNext}
            onBack={goBack}
          />
        )}
        {step === 2 && (
          <CompetitorStep
            competitorUrl={competitorUrl}
            brandUrl={brandUrl}
            onCompetitorUrlChange={setCompetitorUrl}
            onNext={goNext}
            onBack={goBack}
          />
        )}
        {step === 3 && (
          <ChannelsStep
            channels={channels}
            onChannelsChange={setChannels}
            onNext={goNext}
            onBack={goBack}
          />
        )}
        {step === 4 && (
          <ExecutionStep
            mode={mode}
            channels={channels}
            onModeChange={setMode}
            onNext={handleSubmit}
            onBack={goBack}
            isSubmitting={isSubmitting}
          />
        )}
      </div>

      {/* Submit error */}
      {submitError && (
        <div className="mt-6 max-w-2xl w-full px-4 py-3 rounded-xl border border-red-500/20 bg-red-500/8 text-sm text-red-400">
          {submitError}
        </div>
      )}

      <style jsx>{`
        @keyframes fadeSlideIn {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
}
