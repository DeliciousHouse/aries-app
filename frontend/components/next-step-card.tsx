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

export function NextStepCard({ nextStep }: NextStepCardProps): JSX.Element {
  return (
    <section data-next-step={nextStep}>
      <h3>Next step</h3>
      <p>{nextStep}</p>
      <p>{copyByStep[nextStep]}</p>
    </section>
  );
}

export default NextStepCard;
