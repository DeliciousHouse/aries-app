export const onboarding_status_values = ['accepted', 'duplicate', 'validated', 'needs_repair'] as const;
export type onboarding_status = (typeof onboarding_status_values)[number];

export const provisioning_status_values = ['validated', 'needs_repair', 'in_progress', 'duplicate', 'not_found'] as const;
export type provisioning_status = (typeof provisioning_status_values)[number];

export const marketing_stage_values = ['research', 'strategy', 'production', 'publish'] as const;
export type marketing_stage = (typeof marketing_stage_values)[number];

export const repair_status_values = [
  'not_required',
  'required',
  'in_progress',
  'patched',
  'rerun_passed',
  'rerun_failed',
  'retry_scheduled',
  'exhausted'
] as const;
export type repair_status = (typeof repair_status_values)[number];

export const next_step_values = [
  'none',
  'wait_for_completion',
  'check_onboarding_status',
  'submit_approval',
  'resume_approved_stages',
  'invoke_marketing_repair',
  'retry_with_next_attempt',
  'provide_production_outputs',
  'fix_publish_targets'
] as const;
export type next_step = (typeof next_step_values)[number];
