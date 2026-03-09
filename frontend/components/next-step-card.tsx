import type { next_step } from '../types/runtime';

export interface NextStepCardProps {
  nextStep: next_step;
}

const copyByStep: Record<next_step, string> = {
  none: 'No action required.',
  wait_for_completion: 'Wait for completion and check status again.',
  check_onboarding_status: 'Check onboarding status for updated provisioning details.',
  submit_approval: 'Submit approval to continue the workflow.',
  resume_approved_stages: 'Resume approved stages to continue processing.',
  invoke_marketing_repair: 'Invoke marketing repair and monitor retries.',
  retry_with_next_attempt: 'Retry using the next allowed attempt.',
  provide_production_outputs: 'Provide production outputs required for publish.',
  fix_publish_targets: 'Fix publish targets before rerunning publish.'
};

const labelByStep: Record<next_step, string> = {
  none: 'Nothing pending',
  wait_for_completion: 'Wait for completion',
  check_onboarding_status: 'Check onboarding status',
  submit_approval: 'Submit approval',
  resume_approved_stages: 'Resume approved stages',
  invoke_marketing_repair: 'Invoke marketing repair',
  retry_with_next_attempt: 'Retry with next attempt',
  provide_production_outputs: 'Provide production outputs',
  fix_publish_targets: 'Fix publish targets'
};

function urgencyFor(step: next_step): 'none' | 'low' | 'medium' | 'high' {
  if (step === 'none' || step === 'wait_for_completion') {
    return 'none';
  }

  if (step === 'submit_approval' || step === 'retry_with_next_attempt') {
    return 'high';
  }

  if (step === 'invoke_marketing_repair' || step === 'fix_publish_targets') {
    return 'medium';
  }

  return 'low';
}

export function NextStepCard({ nextStep }: NextStepCardProps): JSX.Element {
  const isEmpty = nextStep === 'none';

  return (
    <section data-next-step={nextStep} data-empty={isEmpty} data-urgency={urgencyFor(nextStep)}>
      <h3>Next step</h3>
      <p>{labelByStep[nextStep]}</p>
      <p>{copyByStep[nextStep]}</p>
    </section>
  );
}

export default NextStepCard;
