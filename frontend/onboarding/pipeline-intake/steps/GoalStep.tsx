'use client';

import { Target, TrendingUp, ShoppingCart, Megaphone } from 'lucide-react';
import StepContainer from '../components/StepContainer';
import SelectionCardGroup, { type SelectionOption } from '../components/SelectionCardGroup';
import type { Goal } from '../types';

const GOAL_OPTIONS: SelectionOption[] = [
  {
    value: 'lead_generation',
    label: 'Lead Generation',
    description: 'Capture qualified leads through targeted campaigns',
    icon: <Target className="w-5 h-5" />,
  },
  {
    value: 'content_growth',
    label: 'Content Growth',
    description: 'Build audience through organic and paid content',
    icon: <TrendingUp className="w-5 h-5" />,
  },
  {
    value: 'product_sales',
    label: 'Product Sales',
    description: 'Drive direct purchases and conversions',
    icon: <ShoppingCart className="w-5 h-5" />,
  },
  {
    value: 'brand_awareness',
    label: 'Brand Awareness',
    description: 'Increase visibility and market presence',
    icon: <Megaphone className="w-5 h-5" />,
  },
];

interface GoalStepProps {
  goal: Goal | null;
  onGoalChange: (goal: Goal) => void;
  onNext: () => void;
  onBack?: () => void;
}

export default function GoalStep({ goal, onGoalChange, onNext, onBack }: GoalStepProps) {
  return (
    <StepContainer
      stepNumber={1}
      totalSteps={5}
      title="Campaign Goal"
      subtitle="What's the primary objective of this campaign? This shapes the entire strategy and creative direction."
      canProceed={!!goal}
      onNext={onNext}
      onBack={onBack}
    >
      <SelectionCardGroup
        options={GOAL_OPTIONS}
        selected={goal ?? ''}
        onChange={(val) => onGoalChange(val as Goal)}
        multi={false}
      />
    </StepContainer>
  );
}
