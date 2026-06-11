/**
 * Aries execution surface.
 *
 * Route handlers and backend callers import this surface instead of
 * provider-specific modules. Hermes is the sole execution provider behind
 * these helpers.
 */

export {
  ExecutionError,
  type ExecutionErrorCode,
  type ExecutionErrorInit,
} from './errors';

export {
  ATOMIC_MARKETING_WORKFLOW_KEYS,
  ARIES_WORKFLOWS,
  getAriesWorkflow,
  type AriesWorkflowDef,
  type AriesWorkflowKey,
} from './workflow-catalog';

export {
  DEFAULT_EXECUTION_PROVIDER,
  getExecutionProvider,
  resolveExecutionProviderName,
  type AriesExecutionProviderName,
} from './provider-factory';

export {
  HermesExecutionAdapter,
  buildHermesRequestEnvelope,
  type HermesCancelRequestEnvelope,
  type HermesRequestEnvelope,
  type HermesRequestEnvelopeInput,
  type HermesResumeRequestEnvelope,
  type HermesRunRequestEnvelope,
} from './providers/hermes';

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
