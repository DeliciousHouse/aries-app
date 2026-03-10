import { PROVIDER_ADAPTERS } from './adapters/index';
import type { PublishDispatchEvent } from './adapters/types';

export type WorkflowType = 'connection_events' | 'publish_dispatch' | 'publish_retry' | 'calendar_schedule_sync';

export interface OrchestrationEnvelope {
  schema_name: 'aries_orchestration_event';
  schema_version: '1.0.0';
  workflow: WorkflowType;
  tenant_id: string;
  provider?: string;
  event_id: string;
  occurred_at: string;
  payload: Record<string, unknown>;
}

function randomId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`validation_error:${field}`);
  }
}

export function normalizePublishDispatch(event: PublishDispatchEvent): OrchestrationEnvelope {
  assertNonEmpty(event.tenant_id, 'tenant_id');
  assertNonEmpty(event.provider, 'provider');
  assertNonEmpty(event.content, 'content');

  const adapter = PROVIDER_ADAPTERS[event.provider];
  if (!adapter) throw new Error('validation_error:unsupported_provider');

  const normalized = adapter.normalizePublishEvent(event);

  return {
    schema_name: 'aries_orchestration_event',
    schema_version: '1.0.0',
    workflow: 'publish_dispatch',
    tenant_id: event.tenant_id,
    provider: event.provider,
    event_id: randomId('evt'),
    occurred_at: new Date().toISOString(),
    payload: normalized.payload
  };
}

export function buildCalendarSyncEvent(input: { tenant_id: string; window_start?: string; window_end?: string }): OrchestrationEnvelope {
  assertNonEmpty(input.tenant_id, 'tenant_id');
  return {
    schema_name: 'aries_orchestration_event',
    schema_version: '1.0.0',
    workflow: 'calendar_schedule_sync',
    tenant_id: input.tenant_id,
    event_id: randomId('evt'),
    occurred_at: new Date().toISOString(),
    payload: {
      window_start: input.window_start || null,
      window_end: input.window_end || null
    }
  };
}

export function buildRetryEvent(input: { tenant_id: string; max_attempts?: number }): OrchestrationEnvelope {
  assertNonEmpty(input.tenant_id, 'tenant_id');
  const attempts = Math.min(Math.max(input.max_attempts || 3, 1), 10);
  return {
    schema_name: 'aries_orchestration_event',
    schema_version: '1.0.0',
    workflow: 'publish_retry',
    tenant_id: input.tenant_id,
    event_id: randomId('evt'),
    occurred_at: new Date().toISOString(),
    payload: { max_attempts: attempts }
  };
}
