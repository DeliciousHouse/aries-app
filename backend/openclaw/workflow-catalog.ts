export type AriesOpenClawWorkflowKey =
  | 'demo_start'
  | 'sandbox_launch'
  | 'onboarding_start'
  | 'marketing_start'
  | 'marketing_approve'
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

const DEFAULT_CWD = 'lobster';

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
  marketing_start: {
    key: 'marketing_start',
    pipeline: 'marketing-pipeline.lobster',
    cwd: DEFAULT_CWD,
    mode: 'real',
    route: 'marketing.start',
  },
  marketing_approve: {
    key: 'marketing_approve',
    pipeline: 'parity/marketing-approve/workflow.lobster',
    cwd: DEFAULT_CWD,
    mode: 'stub',
    route: 'marketing.approve',
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
