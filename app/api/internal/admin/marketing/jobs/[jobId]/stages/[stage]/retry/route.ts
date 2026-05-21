import { NextResponse } from 'next/server';

import { getTenantContext } from '@/lib/tenant-context';
import { loadMarketingJobRuntime } from '@/backend/marketing/runtime-state';
import type { MarketingStage } from '@/backend/marketing/runtime-state';
import { getMarketingExecutionPort } from '@/backend/marketing/execution-port';
import { assertMarketingExecutionPortConfigured } from '@/backend/marketing/provider-guard';

const RETRYABLE_STAGES = new Set<string>(['research', 'strategy', 'production']);

function isMarketingStage(value: string): value is MarketingStage {
  return value === 'research' || value === 'strategy' || value === 'production' || value === 'publish';
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ jobId: string; stage: string }> },
) {
  let tenantContext;
  try {
    tenantContext = await getTenantContext();
  } catch {
    return NextResponse.json({ status: 'error', reason: 'unauthenticated' }, { status: 401 });
  }

  if (tenantContext.role !== 'tenant_admin') {
    return NextResponse.json({ status: 'error', reason: 'forbidden' }, { status: 403 });
  }

  const { jobId, stage } = await params;

  if (!jobId || !stage) {
    return NextResponse.json({ status: 'error', reason: 'missing_params' }, { status: 400 });
  }

  // Publish stage is irreversible — never allow admin retry through this panel
  if (stage === 'publish') {
    return NextResponse.json(
      { status: 'error', reason: 'publish_stage_not_retryable', message: 'Use the campaign workspace to manage publish.' },
      { status: 400 },
    );
  }

  if (!isMarketingStage(stage) || !RETRYABLE_STAGES.has(stage)) {
    return NextResponse.json({ status: 'error', reason: 'invalid_stage' }, { status: 400 });
  }

  const doc = await loadMarketingJobRuntime(jobId);
  if (!doc) {
    return NextResponse.json({ status: 'error', reason: 'job_not_found' }, { status: 404 });
  }

  // Strict tenant isolation
  if (doc.tenant_id !== tenantContext.tenantId) {
    return NextResponse.json({ status: 'error', reason: 'job_not_found' }, { status: 404 });
  }

  try {
    assertMarketingExecutionPortConfigured();
  } catch {
    return NextResponse.json(
      { status: 'error', reason: 'execution_port_not_configured' },
      { status: 503 },
    );
  }

  const port = getMarketingExecutionPort();

  const result = await port.submitNextStage({
    jobId,
    tenantId: tenantContext.tenantId,
    doc,
    stage,
  });

  const hermesRunId = result.kind === 'submitted' ? result.hermesRunId : null;
  const ariesRunId = result.kind === 'submitted' ? result.ariesRunId : null;

  return NextResponse.json({
    status: 'ok',
    jobId,
    stage,
    hermes_run_id: hermesRunId,
    aries_run_id: ariesRunId,
    result_kind: result.kind,
  });
}
