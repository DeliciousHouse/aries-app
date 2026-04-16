'use client';

import { BookOpen, Layers, Rocket } from 'lucide-react';
import StepContainer from '../components/StepContainer';
import SelectionCardGroup, { type SelectionOption } from '../components/SelectionCardGroup';
import SystemPreviewPanel from '../components/SystemPreviewPanel';
import type { Channel, ExecutionMode } from '../types';

const MODE_OPTIONS: SelectionOption[] = [
  {
    value: 'strategy_only',
    label: 'Strategy Only',
    description: 'Research + brand analysis + campaign strategy',
    icon: <BookOpen className="w-5 h-5" />,
  },
  {
    value: 'strategy_plus_assets',
    label: 'Strategy + Assets',
    description: 'Everything above plus ad creatives, scripts, landing pages',
    icon: <Layers className="w-5 h-5" />,
  },
  {
    value: 'full_pipeline',
    label: 'Full Pipeline',
    description: 'End-to-end: strategy, assets, and platform-ready publish packages',
    icon: <Rocket className="w-5 h-5" />,
  },
];

interface ExecutionStepProps {
  mode: ExecutionMode | null;
  channels: Channel[];
  onModeChange: (mode: ExecutionMode) => void;
  onNext: () => void;
  onBack: () => void;
  isSubmitting: boolean;
}

export default function ExecutionStep({
  mode,
  channels,
  onModeChange,
  onNext,
  onBack,
  isSubmitting,
}: ExecutionStepProps) {
  return (
    <StepContainer
      stepNumber={5}
      totalSteps={5}
      title="Execution Mode"
      subtitle="Choose how far the pipeline runs. You can always upgrade later."
      canProceed={!!mode && !isSubmitting}
      onNext={onNext}
      onBack={onBack}
      isLast={true}
    >
      <div className="space-y-6">
        <SelectionCardGroup
          options={MODE_OPTIONS}
          selected={mode ?? ''}
          onChange={(val) => onModeChange(val as ExecutionMode)}
          multi={false}
          ariaLabel="Execution mode"
        />

        <SystemPreviewPanel channels={channels} mode={mode} />

        {isSubmitting && (
          <div className="flex items-center gap-3 p-4 rounded-xl border border-aries-crimson/20 bg-aries-crimson/5">
            <div className="w-4 h-4 border-2 border-aries-crimson/40 border-t-aries-crimson rounded-full animate-spin flex-shrink-0" />
            <p className="text-sm text-[#aaa]">Launching pipeline — this may take a moment…</p>
          </div>
        )}
      </div>
    </StepContainer>
  );
}
