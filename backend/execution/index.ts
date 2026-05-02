/**
 * Aries provider-neutral execution surface.
 *
 * Route handlers and backend callers should import this surface instead of
 * provider-specific modules. OpenClaw remains the current implementation behind
 * these helpers, but callers should treat it as a swappable execution provider.
 */

export {
  ExecutionError,
  type ExecutionErrorCode,
  type ExecutionErrorInit,
} from './errors';

export {
  ARIES_ATOMIC_MARKETING_WORKFLOW_KEYS,
  ARIES_WORKFLOWS,
  getAriesWorkflow,
  type AriesWorkflowDef,
  type AriesWorkflowKey,
} from './workflow-catalog';

export {
  LegacyOpenClawExecutionAdapter,
  mapLegacyOpenClawGatewayError,
  type LegacyOpenClawCancelInput,
  type LegacyOpenClawResumeInput,
  type LegacyOpenClawRunInput,
} from './providers/legacy-openclaw';

export {
  cancelAriesWorkflow,
  mapAriesExecutionError,
  runAriesWorkflow,
  type AriesRouteExecutionResult,
} from './route-helpers';

export type {
  ExecutionProvider,
  ExecutionProviderName,
  ParityStubPayload,
  WorkflowEnvelope,
  WorkflowExecutionResult,
} from './types';
