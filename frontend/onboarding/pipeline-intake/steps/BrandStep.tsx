'use client';

import { useState } from 'react';
import { Check } from 'lucide-react';
import StepContainer from '../components/StepContainer';
import UrlInputWithPreview from '../components/UrlInputWithPreview';
import BusinessTypeCombobox from '../components/BusinessTypeCombobox';
import type { UrlPreviewData } from '../types';

interface BrandStepProps {
  brandUrl: string;
  onBrandUrlChange: (url: string) => void;
  businessType: string;
  onBusinessTypeChange: (next: string) => void;
  onNext: () => void;
  onBack?: () => void;
}

export default function BrandStep({
  brandUrl,
  onBrandUrlChange,
  businessType,
  onBusinessTypeChange,
  onNext,
  onBack,
}: BrandStepProps) {
  const [preview, setPreview] = useState<UrlPreviewData | null>(null);
  const [blurChip, setBlurChip] = useState<{ kind: 'idle' | 'valid' | 'invalid'; hostname?: string }>({ kind: 'idle' });

  const handleBlur = () => {
    const trimmed = brandUrl.trim();
    if (!trimmed) {
      setBlurChip({ kind: 'idle' });
      return;
    }
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'https:' || !parsed.hostname) {
        setBlurChip({ kind: 'invalid' });
        return;
      }
      setBlurChip({ kind: 'valid', hostname: parsed.hostname.replace(/^www\./, '') });
    } catch {
      setBlurChip({ kind: 'invalid' });
    }
  };

  const businessTypeReady = businessType.trim().length > 0;

  return (
    <StepContainer
      stepNumber={2}
      totalSteps={5}
      title="Your Brand"
      subtitle="Tell us about your business so we can tailor research, voice, and positioning."
      canProceed={!!preview && businessTypeReady}
      onNext={onNext}
      onBack={onBack}
    >
      <div onBlur={handleBlur}>
        <UrlInputWithPreview
          value={brandUrl}
          onChange={(next) => {
            onBrandUrlChange(next);
            setBlurChip({ kind: 'idle' });
          }}
          onPreviewLoaded={setPreview}
          label="Brand URL"
          placeholder="https://yourbrand.com"
        />
      </div>

      {blurChip.kind === 'valid' && blurChip.hostname ? (
        <div className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-medium">
          <Check className="w-3.5 h-3.5" /> {blurChip.hostname} — ready to analyze
        </div>
      ) : null}
      {blurChip.kind === 'invalid' ? (
        <div className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-medium">
          <span aria-hidden>✗</span> Enter a valid HTTPS website
        </div>
      ) : null}

      {!preview && brandUrl && blurChip.kind !== 'invalid' && (
        <p className="mt-3 text-xs text-[#555]">
          Waiting for a valid, reachable HTTPS URL to proceed.
        </p>
      )}

      <div className="mt-6">
        <BusinessTypeCombobox
          value={businessType}
          onChange={onBusinessTypeChange}
          required
        />
      </div>
    </StepContainer>
  );
}
