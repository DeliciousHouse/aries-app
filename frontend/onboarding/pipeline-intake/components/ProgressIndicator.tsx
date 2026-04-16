'use client';

import { Check } from 'lucide-react';

const STEPS = ['Goal', 'Brand', 'Competitor', 'Channels', 'Execution'];

interface ProgressIndicatorProps {
  currentStep: number; // 0-indexed
}

export default function ProgressIndicator({ currentStep }: ProgressIndicatorProps) {
  return (
    <div className="w-full flex items-center justify-center gap-0 mb-10">
      {STEPS.map((label, idx) => {
        const isCompleted = idx < currentStep;
        const isCurrent = idx === currentStep;

        return (
          <div key={label} className="flex items-center">
            {/* Step node */}
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={`
                  w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold transition-all duration-300
                  ${isCompleted
                    ? 'bg-aries-crimson text-white'
                    : isCurrent
                      ? 'bg-aries-crimson text-white ring-4 ring-aries-crimson/25'
                      : 'bg-[#1e1e2e] text-[#555] border border-[#2a2a3e]'
                  }
                `}
              >
                {isCompleted ? <Check className="w-4 h-4" /> : idx + 1}
              </div>
              <span
                className={`text-[11px] font-medium tracking-wide whitespace-nowrap transition-colors duration-300 ${
                  isCurrent ? 'text-white' : isCompleted ? 'text-aries-crimson' : 'text-[#555]'
                }`}
              >
                {label}
              </span>
            </div>

            {/* Connector line */}
            {idx < STEPS.length - 1 && (
              <div
                className={`w-12 h-0.5 mb-5 mx-1 transition-all duration-300 ${
                  idx < currentStep ? 'bg-aries-crimson' : 'bg-[#1e1e2e]'
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
