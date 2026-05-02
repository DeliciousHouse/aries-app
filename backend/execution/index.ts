/**
 * Aries provider-neutral execution surface.
 *
 * This barrel exports the types and errors that callers should depend on
 * instead of importing provider-specific names (e.g. OpenClawGatewayError,
 * AriesWorkflowExecutionResult). Adding this module is a no-op for runtime
 * behavior; migration of existing callers happens in a later task.
 */

export {
  ExecutionError,
  type ExecutionErrorCode,
  type ExecutionErrorInit,
} from './errors';

export type {
  ExecutionProvider,
  ExecutionProviderName,
  ParityStubPayload,
  WorkflowEnvelope,
  WorkflowExecutionResult,
} from './types';
