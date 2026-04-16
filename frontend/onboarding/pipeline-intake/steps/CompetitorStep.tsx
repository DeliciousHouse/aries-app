'use client';

import { useState } from 'react';
import StepContainer from '../components/StepContainer';
import UrlInputWithPreview from '../components/UrlInputWithPreview';
import type { UrlPreviewData } from '../types';

interface CompetitorStepProps {
  competitorUrl: string;
  brandUrl: string;
  onCompetitorUrlChange: (url: string) => void;
  onNext: () => void;
  onBack: () => void;
}

export default function CompetitorStep({
  competitorUrl,
  brandUrl,
  onCompetitorUrlChange,
  onNext,
  onBack,
}: CompetitorStepProps) {
  const [preview, setPreview] = useState<UrlPreviewData | null>(null);

  return (
    <StepContainer
      stepNumber={3}
      totalSteps={5}
      title="Your Competitor"
      subtitle="Enter the competitor's website URL. Aries will resolve the brand, find the Meta page internally, and analyze ads without needing a Facebook or Ad Library link."
      canProceed={!!preview}
      onNext={onNext}
      onBack={onBack}
    >
      <UrlInputWithPreview
        value={competitorUrl}
        onChange={onCompetitorUrlChange}
        onPreviewLoaded={setPreview}
        label="Competitor website URL"
        placeholder="https://betterup.com"
        excludeUrl={brandUrl}
        validationMode="competitor_website"
      />

      {!preview && competitorUrl && (
        <p className="mt-3 text-xs text-[#555]">
          Must be a real competitor website, different from your brand URL, and not a Facebook or Meta Ad Library URL.
        </p>
      )}
    </StepContainer>
  );
}
