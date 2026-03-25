'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import ProgressIndicator from './components/ProgressIndicator';
import BrandStep from './steps/BrandStep';
import CompetitorStep from './steps/CompetitorStep';
import GoalStep from './steps/GoalStep';
import ChannelsStep from './steps/ChannelsStep';
import ExecutionStep from './steps/ExecutionStep';
import type { Channel, ExecutionMode, Goal, PipelineInput } from './types';

type StepIndex = 0 | 1 | 2 | 3 | 4;

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

  const goNext = () => {
    setDirection('forward');
    setStep((s) => Math.min(s + 1, 4) as StepIndex);
  };

  const goBack = () => {
    setDirection('back');
    setStep((s) => Math.max(s - 1, 0) as StepIndex);
  };

  const handleSubmit = async () => {
    if (!goal || !mode || channels.length === 0 || !brandUrl || !competitorUrl) return;

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
      router.push(nextUrl);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Something went wrong');
      setIsSubmitting(false);
    }
  };

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
          <BrandStep brandUrl={brandUrl} onBrandUrlChange={setBrandUrl} onNext={goNext} />
        )}
        {step === 1 && (
          <CompetitorStep
            competitorUrl={competitorUrl}
            brandUrl={brandUrl}
            onCompetitorUrlChange={setCompetitorUrl}
            onNext={goNext}
            onBack={goBack}
          />
        )}
        {step === 2 && (
          <GoalStep goal={goal} onGoalChange={setGoal} onNext={goNext} onBack={goBack} />
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
