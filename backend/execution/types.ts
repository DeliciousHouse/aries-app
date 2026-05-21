/**
 * Execution types for Aries route handlers.
 *
 * Route handlers depend on this provider-neutral contract; Hermes is the
 * concrete execution provider behind it.
 */

import type { ExecutionError, ExecutionProviderName } from './errors';

/**
 * Opaque envelope returned from an execution call. Kept loose so the provider
 * can populate its own envelope shape without leaking provider-specific names
 * into the public type. Callers that need specifics narrow at the boundary.
 */
export type WorkflowEnvelope = Record<string, unknown>;

/**
 * Parity stub returned when a route's workflow has not been implemented yet.
 */
export type ParityStubPayload = {
  status: 'not_implemented';
  code: 'workflow_missing_for_route';
  route: string;
  message: string;
  [key: string]: unknown;
};

/**
 * Discriminated union representing the result of executing a workflow.
 *
 * - 'ok' — the provider returned a successful envelope.
 * - 'not_implemented' — no workflow exists for the requested route; the
 *   parity stub payload should be returned to the caller.
 * - 'gateway_error' — the provider returned a structured error.
 */
export type WorkflowExecutionResult =
  | { kind: 'ok'; envelope: WorkflowEnvelope; primaryOutput: Record<string, unknown> | null }
  | { kind: 'not_implemented'; payload: ParityStubPayload }
  | { kind: 'gateway_error'; error: ExecutionError };

/**
 * Interface for executing a workflow by key + input.
 *
 * The Hermes adapter implements this interface. Callers depend on the
 * interface, not the concrete provider.
 */
export interface ExecutionProvider {
  readonly name: ExecutionProviderName;
  runWorkflow(
    key: string,
    input: Record<string, unknown>,
  ): Promise<WorkflowExecutionResult>;
}

export type { ExecutionProviderName } from './errors';
