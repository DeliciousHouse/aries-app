import { NextResponse } from 'next/server';

import { verifyInternalCallbackRequest, verifyPlaintextMatchesCallbackTokenHash } from '@/lib/internal-callback-auth';
import { createMemoryOrchestrator } from '@/backend/memory/orchestrator';
import { TenantMemoryClient } from '@/backend/memory/honcho-client';
import type { HonchoTransport } from '@/backend/memory/honcho-client';
import { HonchoHttpTransport } from '@/backend/memory/honcho-http-transport';
import {
  getJobById,
  recordEnvelope,
  recordFinding,
  setStatus,
  type ResearchJobStatus,
} from '@/backend/memory/research-jobs';
import type { ResearchEnvelope } from '@/backend/memory/types';

function isResearchEnvelope(value: unknown): value is ResearchEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.status !== 'ok' && v.status !== 'partial' && v.status !== 'failed') return false;
  if (!Array.isArray(v.findings)) return false;
  return true;
}

function readField<T>(body: unknown, key: string): T | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return (body as Record<string, unknown>)[key] as T | undefined;
}

function deriveJobStatus(
  approved: number,
  queued: number,
  dropped: number,
  envelopeStatus: ResearchEnvelope['status'],
): ResearchJobStatus {
  if (envelopeStatus === 'failed') return 'failed';
  if (queued > 0) return 'needs_review';
  if (envelopeStatus === 'partial') return 'partial';
  if (approved === 0 && dropped > 0) return 'completed';
  return 'completed';
}

export async function POST(req: Request, opts?: { transport?: HonchoTransport }) {
  const authResult = verifyInternalCallbackRequest(req);
  if (!authResult.ok) {
    return NextResponse.json({ status: 'error', reason: authResult.reason }, { status: authResult.status });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ status: 'error', reason: 'invalid_json' }, { status: 400 });
  }

  const jobId = readField<string>(body, 'jobId');
  if (typeof jobId !== 'string' || !jobId.trim()) {
    return NextResponse.json({ status: 'error', reason: 'missing_job_id' }, { status: 400 });
  }

  const callbackToken = readField<string>(body, 'callbackToken');
  if (typeof callbackToken !== 'string' || !callbackToken.trim()) {
    return NextResponse.json({ status: 'error', reason: 'missing_callback_token' }, { status: 403 });
  }

  const envelope = readField<unknown>(body, 'envelope');
  if (!isResearchEnvelope(envelope)) {
    return NextResponse.json({ status: 'error', reason: 'invalid_envelope_schema' }, { status: 400 });
  }

  const job = await getJobById(jobId);
  if (!job) {
    return NextResponse.json({ status: 'error', reason: 'job_not_found' }, { status: 404 });
  }

  if (!verifyPlaintextMatchesCallbackTokenHash(callbackToken, job.callback_token_hash)) {
    return NextResponse.json({ status: 'error', reason: 'invalid_callback_token' }, { status: 403 });
  }

  const tenantCtx = {
    tenantId: job.tenant_id,
    tenantSlug: '',
    userId: 'system',
    role: 'tenant_admin' as const,
  };

  await recordEnvelope(jobId, envelope);

  const transport = opts?.transport ?? new HonchoHttpTransport();
  const client = new TenantMemoryClient(transport);
  const orchestrator = createMemoryOrchestrator(client);

  let approved = 0;
  let queued = 0;
  let dropped = 0;

  for (const finding of envelope.findings) {
    const rawFinding = finding as unknown as Record<string, unknown>;
    const result = await orchestrator.appendCuratedFinding(tenantCtx, {
      jobId,
      finding,
    });

    await recordFinding(jobId, rawFinding, result.outcome, result.messageId ?? null);

    if (result.outcome.decision === 'auto_approve') {
      approved++;
    } else if (result.outcome.decision === 'queue_for_review') {
      queued++;
    } else {
      dropped++;
    }
  }

  const finalStatus = deriveJobStatus(approved, queued, dropped, envelope.status);
  await setStatus(jobId, finalStatus);

  return NextResponse.json({
    ok: true,
    counts: { approved, queued, dropped },
  });
}
