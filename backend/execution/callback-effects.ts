import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { loadExecutionRunRecord, saveExecutionRunRecord, type ExecutionRunRecord } from './run-store';

type Receipt = NonNullable<ExecutionRunRecord['callback_receipts']>[number];
// Carry the parent receipt through the real callback's nested writers. A child
// callback opens its own scope; an unrelated request never inherits this one.
const scope = new AsyncLocalStorage<{ runId: string; receipt: Receipt }>();

export function callbackEffectDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item) => (
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item
  ))).digest('hex');
}

export function withCallbackEffectScope<T>(run: ExecutionRunRecord, receipt: Receipt, action: () => T): T {
  return scope.run({ runId: run.aries_run_id, receipt }, action);
}

/** Persist intent BEFORE the effect, using the callback's existing durable file. */
export function recordCallbackEffectIntent(target: string, key: string, expected: unknown): void {
  const context = scope.getStore();
  if (!context) return;
  const latest = loadExecutionRunRecord(context.runId);
  const stored = latest?.callback_receipts?.find((item) => item.payload_sha256 === context.receipt.payload_sha256
    && item.external_run_id === context.receipt.external_run_id && item.event_id === context.receipt.event_id);
  if (!latest || !stored || stored.state !== 'applying') throw new Error('callback effect receipt unavailable');
  const digest = callbackEffectDigest(expected);
  const existing = stored.effects?.find((item) => item.target === target && item.key === key);
  if (existing && existing.expected_sha256 !== digest) throw new Error('conflicting callback effect intent');
  if (existing) return;
  stored.effects = [...(stored.effects ?? []), { target, key, expected_sha256: digest, disposition: 'unknown' }];
  saveExecutionRunRecord(latest);
  context.receipt.effects = stored.effects;
}
