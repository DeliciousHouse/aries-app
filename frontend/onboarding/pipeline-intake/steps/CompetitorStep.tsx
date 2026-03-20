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
      stepNumber={2}
      title="Your Competitor"
      subtitle="Enter a competitor's website. We'll extract their ad strategy, messaging, and positioning to inform your campaign."
      canProceed={!!preview}
      onNext={onNext}
      onBack={onBack}
    >
      <UrlInputWithPreview
        value={competitorUrl}
        onChange={onCompetitorUrlChange}
        onPreviewLoaded={setPreview}
        label="Competitor URL"
        placeholder="https://competitor.com"
        excludeUrl={brandUrl}
      />

      {!preview && competitorUrl && (
        <p className="mt-3 text-xs text-[#555]">
          Must be a different domain from your brand URL and accessible over HTTPS.
        </p>
      )}
    </StepContainer>
  );
}
