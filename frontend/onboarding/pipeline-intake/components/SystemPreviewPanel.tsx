'use client';

import { CheckCircle2, Clock } from 'lucide-react';
import type { Channel, ExecutionMode } from '../types';

interface SystemPreviewPanelProps {
  channels: Channel[];
  mode: ExecutionMode | null;
}

interface PipelineStage {
  id: string;
  label: string;
  description: string;
  modes: ExecutionMode[];
}

const PIPELINE_STAGES: PipelineStage[] = [
  {
    id: 'brand_analysis',
    label: 'Brand Analysis',
    description: 'Deep-dive into brand voice, positioning, and visual identity',
    modes: ['strategy_only', 'strategy_plus_assets', 'full_pipeline'],
  },
  {
    id: 'competitor_research',
    label: 'Competitor Research',
    description: 'Extract and analyse competitor ads, messaging, and strategy',
    modes: ['strategy_only', 'strategy_plus_assets', 'full_pipeline'],
  },
  {
    id: 'campaign_strategy',
    label: 'Campaign Strategy',
    description: 'Funnel design, audience targeting, and messaging framework',
    modes: ['strategy_only', 'strategy_plus_assets', 'full_pipeline'],
  },
  {
    id: 'ad_creatives',
    label: 'Ad Creatives',
    description: 'Image and video ad creatives optimised for each channel',
    modes: ['strategy_plus_assets', 'full_pipeline'],
  },
  {
    id: 'scripts',
    label: 'Video Scripts',
    description: 'Scene-by-scene scripts with production notes',
    modes: ['strategy_plus_assets', 'full_pipeline'],
  },
  {
    id: 'landing_pages',
    label: 'Landing Pages',
    description: 'Conversion-optimised pages for each campaign angle',
    modes: ['strategy_plus_assets', 'full_pipeline'],
  },
  {
    id: 'publish_packages',
    label: 'Publish Packages',
    description: 'Platform-ready packages for direct publishing',
    modes: ['full_pipeline'],
  },
];

const CHANNEL_LABELS: Record<Channel, string> = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  x: 'X (Twitter)',
  'meta-ads': 'Meta Ads',
  email: 'Email',
};

export default function SystemPreviewPanel({ channels, mode }: SystemPreviewPanelProps) {
  const activeStages = mode
    ? PIPELINE_STAGES.filter((s) => s.modes.includes(mode))
    : [];

  return (
    <div className="rounded-xl border border-[#1e1e2e] bg-[#0d0d14] p-5 space-y-5">
      <div>
        <p className="text-xs uppercase tracking-[0.22em] text-[#555] mb-3 font-medium">
          Pipeline Preview
        </p>

        {/* Channels */}
        {channels.length > 0 && (
          <div className="mb-4">
            <p className="text-xs text-[#666] mb-2">Targeting channels</p>
            <div className="flex flex-wrap gap-2">
              {channels.map((ch) => (
                <span
                  key={ch}
                  className="px-2.5 py-1 rounded-lg bg-aries-crimson/10 border border-aries-crimson/20 text-xs text-aries-crimson font-medium"
                >
                  {CHANNEL_LABELS[ch]}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Stages */}
        {mode ? (
          <div className="space-y-2">
            {PIPELINE_STAGES.map((stage) => {
              const active = stage.modes.includes(mode);
              return (
                <div
                  key={stage.id}
                  className={`flex items-start gap-3 p-3 rounded-lg transition-all duration-200 ${
                    active ? 'bg-[#111118] border border-[#1e1e2e]' : 'opacity-30'
                  }`}
                >
                  <div className="flex-shrink-0 mt-0.5">
                    {active ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <Clock className="w-4 h-4 text-[#444]" />
                    )}
                  </div>
                  <div>
                    <p className={`text-sm font-medium ${active ? 'text-white' : 'text-[#555]'}`}>
                      {stage.label}
                    </p>
                    <p className={`text-xs mt-0.5 ${active ? 'text-[#666]' : 'text-[#333]'}`}>
                      {stage.description}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-[#444] italic">Select an execution mode to preview your pipeline.</p>
        )}
      </div>

      {/* Stage count summary */}
      {mode && activeStages.length > 0 && (
        <div className="pt-3 border-t border-[#1e1e2e]">
          <p className="text-xs text-[#555]">
            <span className="text-aries-crimson font-semibold">{activeStages.length}</span> pipeline stages ·{' '}
            <span className="text-aries-crimson font-semibold">{channels.length || '—'}</span> channels
          </p>
        </div>
      )}
    </div>
  );
}
