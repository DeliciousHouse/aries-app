'use client';

import { useState } from 'react';
import StepContainer from '../components/StepContainer';
import UrlInputWithPreview from '../components/UrlInputWithPreview';
import type { UrlPreviewData } from '../types';

interface BrandStepProps {
  brandUrl: string;
  onBrandUrlChange: (url: string) => void;
  onNext: () => void;
}

export default function BrandStep({ brandUrl, onBrandUrlChange, onNext }: BrandStepProps) {
  const [preview, setPreview] = useState<UrlPreviewData | null>(null);

  return (
    <StepContainer
      stepNumber={1}
      title="Your Brand"
      subtitle="Enter your brand's website URL. We'll analyse your positioning, voice, and visual identity."
      canProceed={!!preview}
      onNext={onNext}
    >
      <UrlInputWithPreview
        value={brandUrl}
        onChange={onBrandUrlChange}
        onPreviewLoaded={setPreview}
        label="Brand URL"
        placeholder="https://yourbrand.com"
      />

      {!preview && brandUrl && (
        <p className="mt-3 text-xs text-[#555]">
          Waiting for a valid, reachable HTTPS URL to proceed.
        </p>
      )}
    </StepContainer>
  );
}
