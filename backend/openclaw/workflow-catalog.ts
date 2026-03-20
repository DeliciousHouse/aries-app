import { resolveCodePath } from '../../lib/runtime-paths';

export type AriesOpenClawWorkflowKey =
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

export type AriesOpenClawWorkflowDef = {
  key: AriesOpenClawWorkflowKey;
  pipeline: string;
  cwd?: string;
  mode: 'real' | 'stub';
  route: string;
};

const DEFAULT_CWD = resolveCodePath('lobster');

export const ARIES_OPENCLAW_WORKFLOWS: Record<AriesOpenClawWorkflowKey, AriesOpenClawWorkflowDef> = {
  demo_start: {
    key: 'demo_start',
    pipeline: 'parity/demo-start/workflow.lobster',
    cwd: DEFAULT_CWD,
    mode: 'stub',
    route: 'demo.start',
  },
  sandbox_launch: {
    key: 'sandbox_launch',
    pipeline: 'parity/sandbox-launch/workflow.lobster',
    cwd: DEFAULT_CWD,
    mode: 'stub',
    route: 'sandbox.launch',
  },
  onboarding_start: {
    key: 'onboarding_start',
    pipeline: 'parity/onboarding-start/workflow.lobster',
    cwd: DEFAULT_CWD,
    mode: 'stub',
    route: 'onboarding.start',
  },
  marketing_stage1_research: {
    key: 'marketing_stage1_research',
    pipeline: 'stage-1-research/workflow.lobster',
    cwd: DEFAULT_CWD,
    mode: 'real',
    route: 'marketing.stage1_research',
  },
  marketing_stage2_strategy_review: {
    key: 'marketing_stage2_strategy_review',
    pipeline: 'stage-2-strategy/review-workflow.lobster',
    cwd: DEFAULT_CWD,
    mode: 'real',
    route: 'marketing.stage2_strategy_review',
  },
  marketing_stage2_strategy_finalize: {
    key: 'marketing_stage2_strategy_finalize',
    pipeline: 'stage-2-strategy/finalize-workflow.lobster',
    cwd: DEFAULT_CWD,
    mode: 'real',
    route: 'marketing.stage2_strategy_finalize',
  },
  marketing_stage3_production_review: {
    key: 'marketing_stage3_production_review',
    pipeline: 'stage-3-production/review-workflow.lobster',
    cwd: DEFAULT_CWD,
    mode: 'real',
    route: 'marketing.stage3_production_review',
  },
  marketing_stage3_production_finalize: {
    key: 'marketing_stage3_production_finalize',
    pipeline: 'stage-3-production/finalize-workflow.lobster',
    cwd: DEFAULT_CWD,
    mode: 'real',
    route: 'marketing.stage3_production_finalize',
  },
  marketing_stage4_publish_review: {
    key: 'marketing_stage4_publish_review',
    pipeline: 'stage-4-publish-optimize/review-workflow.lobster',
    cwd: DEFAULT_CWD,
    mode: 'real',
    route: 'marketing.stage4_publish_review',
  },
  marketing_stage4_publish_finalize: {
    key: 'marketing_stage4_publish_finalize',
    pipeline: 'stage-4-publish-optimize/publish-workflow.lobster',
    cwd: DEFAULT_CWD,
    mode: 'real',
    route: 'marketing.stage4_publish_finalize',
  },
  publish_dispatch: {
    key: 'publish_dispatch',
    pipeline: 'parity/publish-dispatch/workflow.lobster',
    cwd: DEFAULT_CWD,
    mode: 'stub',
    route: 'publish.dispatch',
  },
  publish_retry: {
    key: 'publish_retry',
    pipeline: 'parity/publish-retry/workflow.lobster',
    cwd: DEFAULT_CWD,
    mode: 'stub',
    route: 'publish.retry',
  },
  calendar_sync: {
    key: 'calendar_sync',
    pipeline: 'parity/calendar-sync/workflow.lobster',
    cwd: DEFAULT_CWD,
    mode: 'stub',
    route: 'calendar.sync',
  },
  integrations_sync: {
    key: 'integrations_sync',
    pipeline: 'parity/integrations-sync/workflow.lobster',
    cwd: DEFAULT_CWD,
    mode: 'stub',
    route: 'integrations.sync',
  },
};

export function getAriesOpenClawWorkflow(key: AriesOpenClawWorkflowKey): AriesOpenClawWorkflowDef {
  return ARIES_OPENCLAW_WORKFLOWS[key];
}
