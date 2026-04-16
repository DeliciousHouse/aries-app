'use client';

import StepContainer from '../components/StepContainer';
import SelectionCardGroup, { type SelectionOption } from '../components/SelectionCardGroup';
import type { Channel } from '../types';

// Simple text icons since we don't have brand SVGs
const CHANNEL_OPTIONS: SelectionOption[] = [
  {
    value: 'meta-ads',
    label: 'Meta (Facebook + Instagram Ads)',
    description: 'Paid ads on Facebook and Instagram via Meta Business Suite.',
    icon: <span className="text-base">📣</span>,
  },
  {
    value: 'tiktok',
    label: 'TikTok',
    description: 'Short-form video — massive reach, high engagement',
    icon: <span className="text-base">🎵</span>,
  },
  {
    value: 'instagram',
    label: 'Instagram (Organic + Reels)',
    description: 'Reels, stories, carousel — visual-first audience',
    icon: <span className="text-base">📸</span>,
  },
  {
    value: 'youtube',
    label: 'YouTube',
    description: 'Long-form and pre-roll — high intent, high conversion',
    icon: <span className="text-base">▶️</span>,
  },
  {
    value: 'linkedin',
    label: 'LinkedIn',
    description: 'B2B focus — professionals and decision-makers',
    icon: <span className="text-base">💼</span>,
  },
  {
    value: 'x',
    label: 'X (Twitter)',
    description: 'Real-time conversation — trending topics and brand voice',
    icon: <span className="text-base">✖️</span>,
  },
  {
    value: 'email',
    label: 'Email Marketing',
    description: 'Automated email campaigns and sequences.',
    icon: <span className="text-base">✉️</span>,
  },
];

interface ChannelsStepProps {
  channels: Channel[];
  onChannelsChange: (channels: Channel[]) => void;
  onNext: () => void;
  onBack: () => void;
}

export default function ChannelsStep({
  channels,
  onChannelsChange,
  onNext,
  onBack,
}: ChannelsStepProps) {
  return (
    <StepContainer
      stepNumber={4}
      totalSteps={5}
      title="Target Channels"
      subtitle="Select the platforms where your campaign will run. You can choose multiple."
      canProceed={channels.length > 0}
      onNext={onNext}
      onBack={onBack}
    >
      <SelectionCardGroup
        options={CHANNEL_OPTIONS}
        selected={channels}
        onChange={(val) => onChannelsChange(val as Channel[])}
        multi={true}
        ariaLabel="Target channels"
      />

      {channels.length === 0 && (
        <p className="mt-3 text-xs text-[#555]">Select at least one channel to continue.</p>
      )}
      {channels.length > 0 && (
        <p className="mt-3 text-xs text-[#666]">
          {channels.length} channel{channels.length > 1 ? 's' : ''} selected
        </p>
      )}
    </StepContainer>
  );
}
