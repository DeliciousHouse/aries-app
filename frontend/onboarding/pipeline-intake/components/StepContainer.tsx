'use client';

import { ArrowLeft, ArrowRight, Zap } from 'lucide-react';
import { ReactNode } from 'react';

interface StepContainerProps {
  title: string;
  subtitle: string;
  children: ReactNode;
  canProceed: boolean;
  onNext: () => void;
  onBack?: () => void;
  stepNumber: number;
  isLast?: boolean;
}

export default function StepContainer({
  title,
  subtitle,
  children,
  canProceed,
  onNext,
  onBack,
  stepNumber,
  isLast = false,
}: StepContainerProps) {
  return (
    <div className="w-full max-w-2xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <p className="text-xs uppercase tracking-[0.28em] text-aries-crimson mb-2 font-medium">
          Step {stepNumber}
        </p>
        <h2 className="text-3xl font-bold text-white mb-2">{title}</h2>
        <p className="text-[#888] text-base leading-relaxed">{subtitle}</p>
      </div>

      {/* Content */}
      <div className="mb-8">{children}</div>

      {/* Navigation */}
      <div className="flex items-center gap-3">
        {onBack && (
          <button
            onClick={onBack}
            className="flex items-center gap-2 px-5 py-3 rounded-xl border border-[#1e1e2e] bg-[#111118] text-[#888] hover:text-white hover:border-[#2a2a3e] transition-all duration-200 text-sm font-medium"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>
        )}
        <button
          onClick={onNext}
          disabled={!canProceed}
          className={`
            flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-sm transition-all duration-200 ml-auto
            ${canProceed
              ? 'bg-aries-crimson text-white hover:bg-aries-deep shadow-lg shadow-aries-crimson/20 hover:shadow-aries-crimson/30'
              : 'bg-[#1e1e2e] text-[#444] cursor-not-allowed'
            }
          `}
        >
          {isLast ? (
            <>
              <Zap className="w-4 h-4" />
              Launch Pipeline
            </>
          ) : (
            <>
              Continue
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </div>
    </div>
  );
}
