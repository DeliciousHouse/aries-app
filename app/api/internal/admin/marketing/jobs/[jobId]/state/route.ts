import { NextResponse } from 'next/server';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { getTenantContext } from '@/lib/tenant-context';
import { loadSocialContentJobRuntime, marketingRuntimePath } from '@/backend/marketing/runtime-state';
import { listMarketingApprovalRecordsForJob } from '@/backend/marketing/approval-store';
import { resolveDataPath } from '@/lib/runtime-paths';
import { sanitizeJobRuntimeDoc } from '@/lib/admin-sanitize';

function executionRunsRoot(): string {
  return resolveDataPath('generated', 'draft', 'execution-runs');
}

async function loadExecutionRunsForJob(marketingJobId: string): Promise<Array<Record<string, unknown>>> {
  const root = executionRunsRoot();
  const runs: Array<Record<string, unknown>> = [];
  let entries: string[];
  try {
    entries = (await readdir(root)).filter((e) => e.endsWith('.json'));
  } catch {
    return runs;
  }
  for (const entry of entries) {
    try {
      const raw = await readFile(path.join(root, entry), 'utf8');
      const doc = JSON.parse(raw) as Record<string, unknown>;
      if (doc?.marketing_job_id === marketingJobId) {
        // Strip the execution_resume_token to avoid leaking secrets
        const safe = { ...doc };
        delete safe.execution_resume_token;
        runs.push(safe);
      }
    } catch {
      continue;
    }
  }
  return runs.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> },
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

  const { jobId } = await params;
  if (!jobId || typeof jobId !== 'string') {
    return NextResponse.json({ status: 'error', reason: 'missing_job_id' }, { status: 400 });
  }

  const doc = await loadSocialContentJobRuntime(jobId);
  if (!doc) {
    return NextResponse.json({ status: 'error', reason: 'job_not_found' }, { status: 404 });
  }

  // Strict tenant isolation: only return data for the authenticated tenant
  if (doc.tenant_id !== tenantContext.tenantId) {
    return NextResponse.json({ status: 'error', reason: 'job_not_found' }, { status: 404 });
  }

  const approvalRecords = listMarketingApprovalRecordsForJob(jobId).map((record) => {
    // Strip resume tokens — they are secrets, not debug data
    const safe = { ...record } as Record<string, unknown>;
    delete safe.execution_resume_token;
    return safe;
  });

  const executionRuns = await loadExecutionRunsForJob(jobId);

  return NextResponse.json({
    status: 'ok',
    job: sanitizeJobRuntimeDoc(doc),
    approval_records: approvalRecords,
    execution_runs: executionRuns,
    runtime_path: marketingRuntimePath(jobId),
  });
}
