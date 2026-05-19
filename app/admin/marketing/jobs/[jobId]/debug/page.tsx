import { redirect } from 'next/navigation';
import { getTenantContext } from '@/lib/tenant-context';
import { loadMarketingJobRuntime, marketingRuntimePath } from '@/backend/marketing/runtime-state';
import { listMarketingApprovalRecordsForJob } from '@/backend/marketing/approval-store';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveDataPath } from '@/lib/runtime-paths';
import { sanitizeJobRuntimeDoc } from '@/lib/admin-sanitize';
import { DebugPanelClient } from './debug-panel-client';

async function loadExecutionRunsForJob(marketingJobId: string): Promise<Array<Record<string, unknown>>> {
  const root = resolveDataPath('generated', 'draft', 'execution-runs');
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
        const safe = { ...doc };
        delete safe.execution_resume_token;
        delete safe.lobster_resume_token;
        runs.push(safe);
      }
    } catch {
      continue;
    }
  }
  return runs.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
}

export default async function MarketingJobDebugPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  let tenantContext;
  try {
    tenantContext = await getTenantContext();
  } catch {
    redirect('/login');
  }

  if (tenantContext.role !== 'tenant_admin') {
    redirect('/dashboard');
  }

  const { jobId } = await params;

  const doc = await loadMarketingJobRuntime(jobId);

  if (!doc || doc.tenant_id !== tenantContext.tenantId) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-100 p-8">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-xl font-mono font-bold text-red-400 mb-4">Job Not Found</h1>
          <p className="text-gray-400 font-mono">Job <code className="text-yellow-300">{jobId}</code> does not exist or does not belong to your tenant.</p>
          <a href="/dashboard" className="mt-4 inline-block text-blue-400 underline font-mono text-sm">← Back to dashboard</a>
        </div>
      </div>
    );
  }

  const approvalRecords = listMarketingApprovalRecordsForJob(jobId).map((record) => {
    const safe = { ...record } as Record<string, unknown>;
    delete safe.execution_resume_token;
    delete safe.lobster_resume_token;
    return safe;
  });

  const executionRuns = await loadExecutionRunsForJob(jobId);
  const runtimePath = marketingRuntimePath(jobId);

  const sanitizedDoc = sanitizeJobRuntimeDoc(doc);

  return (
    <DebugPanelClient
      doc={sanitizedDoc}
      approvalRecords={approvalRecords}
      executionRuns={executionRuns}
      runtimePath={runtimePath}
      tenantId={tenantContext.tenantId}
    />
  );
}
