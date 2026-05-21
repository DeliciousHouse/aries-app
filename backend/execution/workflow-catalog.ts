export type AriesWorkflowKey =
  | 'demo_start'
  | 'sandbox_launch'
  | 'onboarding_start'
  | 'marketing_stage1_research'
  | 'marketing_stage2_strategy_review'
  | 'marketing_stage2_strategy_finalize'
  | 'marketing_stage3_production_review'
  | 'marketing_stage3_production_finalize'
  | 'marketing_stage4_publish_review'
  | 'marketing_stage4_publish_finalize'
  | 'publish_dispatch'
  | 'publish_retry'
  | 'calendar_sync'
  | 'integrations_sync';

export type AriesWorkflowDef = {
  key: AriesWorkflowKey;
  mode: 'real' | 'stub';
  route: string;
};

/**
 * Atomic marketing stage workflows are exposed through `/api/tenant/workflows/*`.
 * Client-facing `/api/marketing/jobs*` stays on the monolithic marketing
 * orchestrator path.
 */
export const ARIES_ATOMIC_MARKETING_WORKFLOW_KEYS: AriesWorkflowKey[] = [
  'marketing_stage1_research',
  'marketing_stage2_strategy_review',
  'marketing_stage2_strategy_finalize',
  'marketing_stage3_production_review',
  'marketing_stage3_production_finalize',
  'marketing_stage4_publish_review',
  'marketing_stage4_publish_finalize',
];

export const ARIES_WORKFLOWS: Record<AriesWorkflowKey, AriesWorkflowDef> = {
  demo_start: {
    key: 'demo_start',
    mode: 'stub',
    route: 'demo.start',
  },
  sandbox_launch: {
    key: 'sandbox_launch',
    mode: 'stub',
    route: 'sandbox.launch',
  },
  onboarding_start: {
    key: 'onboarding_start',
    mode: 'stub',
    route: 'onboarding.start',
  },
  marketing_stage1_research: {
    key: 'marketing_stage1_research',
    mode: 'real',
    route: 'marketing.stage1_research',
  },
  marketing_stage2_strategy_review: {
    key: 'marketing_stage2_strategy_review',
    mode: 'real',
    route: 'marketing.stage2_strategy_review',
  },
  marketing_stage2_strategy_finalize: {
    key: 'marketing_stage2_strategy_finalize',
    mode: 'real',
    route: 'marketing.stage2_strategy_finalize',
  },
  marketing_stage3_production_review: {
    key: 'marketing_stage3_production_review',
    mode: 'real',
    route: 'marketing.stage3_production_review',
  },
  marketing_stage3_production_finalize: {
    key: 'marketing_stage3_production_finalize',
    mode: 'real',
    route: 'marketing.stage3_production_finalize',
  },
  marketing_stage4_publish_review: {
    key: 'marketing_stage4_publish_review',
    mode: 'real',
    route: 'marketing.stage4_publish_review',
  },
  marketing_stage4_publish_finalize: {
    key: 'marketing_stage4_publish_finalize',
    mode: 'real',
    route: 'marketing.stage4_publish_finalize',
  },
  publish_dispatch: {
    key: 'publish_dispatch',
    mode: 'stub',
    route: 'publish.dispatch',
  },
  publish_retry: {
    key: 'publish_retry',
    mode: 'stub',
    route: 'publish.retry',
  },
  calendar_sync: {
    key: 'calendar_sync',
    mode: 'stub',
    route: 'calendar.sync',
  },
  integrations_sync: {
    key: 'integrations_sync',
    mode: 'stub',
    route: 'integrations.sync',
  },
};

export function getAriesWorkflow(key: AriesWorkflowKey): AriesWorkflowDef {
  return ARIES_WORKFLOWS[key];
}
