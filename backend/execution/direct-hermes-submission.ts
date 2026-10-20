import { createHash } from 'node:crypto';
import {
  createExecutionRunRecord, loadExecutionRunRecord, markExecutionRunSubmitted,
  prepareExecutionRunSubmission, withExecutionRunLock,
} from './run-store';

/** Direct prompt consumers share the durable original-identity boundary. */
export async function submitDirectHermesRun(input: {
  ariesRunId?: string;
  workflowKey: string;
  tenantId?: string | number | null;
  gatewayUrl: string;
  authorization: string;
  body: string;
  signal?: AbortSignal;
  fetchImpl: (url: string | URL, init?: RequestInit) => Promise<Response>;
}): Promise<{ ok: true; runId: string } | { ok: false; reason: 'submit_rejected' | 'submit_invalid'; detail?: string }> {
  const tenantId = input.tenantId == null ? null : String(input.tenantId);
  const gateway = input.gatewayUrl.replace(/\/+$/, '');
  const requestHash = createHash('sha256').update(input.body).digest('hex');
  const scopeHash = createHash('sha256').update(`${gateway}\0${input.authorization}`).digest('hex');
  // Identical text is not identity: competitor research can intentionally be
  // refreshed. A retry must supply its ORIGINAL Aries ID, never a replacement.
  const id = input.ariesRunId ?? createExecutionRunRecord({ provider: 'hermes', domain: 'route',
    workflowKey: input.workflowKey, action: 'run', tenantId }).aries_run_id;
  const existingId = await withExecutionRunLock(id, async () => {
    const existing = loadExecutionRunRecord(id);
    if (!existing || existing.aries_run_id !== id || existing.provider !== 'hermes'
      || existing.domain !== 'route' || existing.action !== 'run'
      || existing.workflow_key !== input.workflowKey || existing.tenant_id !== tenantId) {
      throw new Error('direct Hermes submission binding unavailable');
    }
    if (existing.submission !== null) {
      if (existing.submission?.idempotency_key === id
        && existing.submission.request_sha256 === requestHash
        && existing.submission.gateway_scope_sha256 === scopeHash
        && existing.submission.state === 'accepted' && existing.external_run_id) return existing.external_run_id;
      throw new Error('direct Hermes submission reconciliation required');
    }
    prepareExecutionRunSubmission(id, { idempotency_key: id, request_sha256: requestHash,
      gateway_scope_sha256: scopeHash, target_profile: null });
    return null;
  });
  if (existingId) return { ok: true, runId: existingId };
  const response = await input.fetchImpl(`${gateway}/v1/runs`, {
    method: 'POST', headers: { authorization: input.authorization,
      'content-type': 'application/json', 'idempotency-key': id },
    body: input.body, signal: input.signal,
  });
  if (!response.ok) return { ok: false, reason: 'submit_rejected', detail: `HTTP ${response.status}` };
  const value = await response.json().catch(() => null) as { run_id?: unknown } | null;
  const runId = typeof value?.run_id === 'string' ? value.run_id.trim() : '';
  if (!runId) return { ok: false, reason: 'submit_invalid' };
  await withExecutionRunLock(id, async () => {
    markExecutionRunSubmitted(id, { externalRunId: runId });
  });
  // Acceptance binds the ID only; polling/output application remain unproved.
  return { ok: true, runId };
}
