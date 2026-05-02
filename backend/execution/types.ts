/**
 * Provider-neutral execution types for Aries.
 *
 * These mirror the runtime outcomes currently expressed by the OpenClaw-coupled
 * AriesWorkflowExecutionResult (backend/openclaw/aries-execution.ts) but use
 * provider-neutral names so future Hermes-native execution can share the same
 * contract. Adding these types is a no-op for runtime behavior; callers are
 * not migrated in this task.
 */

import type { ExecutionError, ExecutionProviderName } from './errors';

/**
 * Opaque envelope returned from a provider-specific execution call.
 *
 * We intentionally keep this loose so different providers (OpenClaw/Lobster,
 * Hermes-native, etc.) can populate their own envelope shapes without leaking
 * provider-specific names into the public type. Callers that need provider
 * specifics should narrow at the provider boundary.
 */
export type WorkflowEnvelope = Record<string, unknown>;

/**
 * Parity stub returned when a route's workflow has not been implemented yet.
 * Mirrors the existing ParityStubPayload shape so we can swap result types
 * without changing the wire format consumed by route handlers.
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
 * Provider-neutral interface for executing a workflow by key + input.
 *
 * Concrete providers (OpenClaw adapter, Hermes-native adapter) implement this
 * interface. Callers depend on the interface, not the concrete provider.
 */
export interface ExecutionProvider {
  readonly name: ExecutionProviderName;
  runWorkflow(
    key: string,
    input: Record<string, unknown>,
  ): Promise<WorkflowExecutionResult>;
}

export type { ExecutionProviderName } from './errors';
