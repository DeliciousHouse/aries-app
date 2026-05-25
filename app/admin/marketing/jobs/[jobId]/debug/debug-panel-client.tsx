'use client';

import { useState, useCallback } from 'react';
import { useTenantTimezone } from '@/hooks/use-tenant-timezone';
import { formatInTenantZone, tenantZoneAbbreviation } from '@/lib/format-timestamp';

type StageRecord = {
  stage: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  run_id: string | null;
  errors: Array<{ code: string; message: string; at: string }>;
  primary_output: Record<string, unknown> | null;
  outputs: Record<string, unknown>;
  artifacts: unknown[];
};

type JobDoc = {
  job_id: string;
  tenant_id: string;
  state: string;
  status: string;
  current_stage: string;
  stage_order: string[];
  created_at: string;
  updated_at: string;
  last_error: { code: string; message: string; stage: string; at: string } | null;
  stages: Record<string, StageRecord>;
  failure_reason: string | null;
  inputs: Record<string, unknown>;
  approvals: Record<string, unknown>;
  brand_kit: Record<string, unknown> | null;
};

type Props = {
  doc: Record<string, unknown>;
  approvalRecords: Array<Record<string, unknown>>;
  executionRuns: Array<Record<string, unknown>>;
  runtimePath: string;
  tenantId: string;
};

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    completed: 'bg-green-900 text-green-300',
    failed: 'bg-red-900 text-red-300',
    failed_stale: 'bg-red-900 text-red-300',
    in_progress: 'bg-blue-900 text-blue-300',
    running: 'bg-blue-900 text-blue-300',
    awaiting_approval: 'bg-yellow-900 text-yellow-300',
    not_started: 'bg-gray-800 text-gray-400',
    skipped: 'bg-gray-800 text-gray-500',
    pending: 'bg-gray-800 text-gray-400',
    requires_channel_connection: 'bg-orange-900 text-orange-300',
  };
  const cls = colors[status] ?? 'bg-gray-800 text-gray-400';
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-mono font-semibold ${cls}`}>
      {status}
    </span>
  );
}

function JsonViewer({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  if (value == null || (typeof value === 'object' && Object.keys(value as object).length === 0)) {
    return <span className="text-gray-600 text-xs font-mono">{label}: (empty)</span>;
  }
  return (
    <div className="mt-1">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-xs font-mono text-blue-400 hover:text-blue-300 underline"
      >
        {open ? '▼' : '▶'} {label}
      </button>
      {open && (
        <pre className="mt-1 p-2 bg-gray-900 border border-gray-700 rounded text-xs font-mono text-green-300 overflow-auto max-h-64 whitespace-pre-wrap break-all">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API unavailable
    }
  }, [value]);
  return (
    <button
      onClick={handleCopy}
      className="ml-2 px-2 py-0.5 text-xs font-mono bg-gray-700 hover:bg-gray-600 text-gray-200 rounded border border-gray-600 transition-colors"
    >
      {copied ? '✓ Copied' : label ?? 'Copy'}
    </button>
  );
}

function formatUtcTime(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  return `${isoString.replace('T', ' ').replace(/\.\d+Z$/, '') } UTC`;
}

function formatTenantTime(isoString: string | null | undefined, tz: string): string {
  if (!isoString) return '—';
  return `${formatInTenantZone(isoString, tz)} ${tenantZoneAbbreviation(isoString, tz)}`;
}

function localTimeTooltip(isoString: string | null | undefined, tz: string): string {
  if (!isoString) return '';
  return formatTenantTime(isoString, tz);
}

function durationMs(start: string | null, end: string | null): string {
  if (!start || !end) return '—';
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function buildCurlCommand(
  jobId: string,
  stage: string,
  stageRecord: StageRecord,
  executionRuns: Array<Record<string, unknown>>,
  gatewayUrl = '<HERMES_GATEWAY_URL>',
): string {
  const run = executionRuns.find(
    (r) => r.stage === stage && r.marketing_job_id === jobId,
  );
  const payload: Record<string, unknown> = {
    input: `Workflow: marketing_pipeline\nAction: run\nJob ID: ${jobId}\nStage: ${stage}`,
    instructions: '(see Hermes port instructions)',
    session_id: 'marketing',
    callback_url: '<APP_BASE_URL>/api/internal/hermes/runs',
    callback_auth: {
      type: 'internal_api_secret_bearer',
      secret_ref: 'INTERNAL_API_SECRET',
      callback_token: '<regenerated_on_retry>',
    },
    callback_context: {
      workflow_key: 'marketing_pipeline',
      aries_run_id: run?.aries_run_id ?? '<aries_run_id>',
      job_id: jobId,
      tenant_id: stageRecord.stage,
    },
    idempotency_key: '<sha256_of_aries_run_id|workflow_version|tenant_id>',
  };
  return `curl -X POST "${gatewayUrl}/v1/runs" \\
  -H "Authorization: Bearer <HERMES_API_SERVER_KEY>" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(payload, null, 2)}'`;
}

function RetryButton({
  jobId,
  stage,
}: {
  jobId: string;
  stage: string;
}) {
  const [state, setState] = useState<'idle' | 'confirm' | 'loading' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<string>('');

  const handleRetry = useCallback(async () => {
    setState('loading');
    try {
      const res = await fetch(`/api/internal/admin/marketing/jobs/${encodeURIComponent(jobId)}/stages/${encodeURIComponent(stage)}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = await res.json() as Record<string, unknown>;
      if (res.ok) {
        setResult(`Submitted. Aries run: ${body.aries_run_id ?? '?'} | Hermes run: ${body.hermes_run_id ?? '?'}`);
        setState('done');
      } else {
        setResult(`Error: ${body.reason ?? res.status}`);
        setState('error');
      }
    } catch (err) {
      setResult(`Network error: ${err instanceof Error ? err.message : String(err)}`);
      setState('error');
    }
  }, [jobId, stage]);

  if (stage === 'publish') {
    return <span className="text-gray-600 text-xs font-mono">publish: use campaign workspace</span>;
  }

  if (state === 'idle') {
    return (
      <button
        onClick={() => setState('confirm')}
        className="px-2 py-0.5 text-xs font-mono bg-orange-900 hover:bg-orange-800 text-orange-200 rounded border border-orange-700"
      >
        Retry Stage
      </button>
    );
  }

  if (state === 'confirm') {
    return (
      <span className="flex items-center gap-2">
        <span className="text-xs font-mono text-yellow-300">Confirm retry {stage}?</span>
        <button
          onClick={handleRetry}
          className="px-2 py-0.5 text-xs font-mono bg-red-900 hover:bg-red-800 text-red-200 rounded border border-red-700"
        >
          Yes, retry
        </button>
        <button
          onClick={() => setState('idle')}
          className="px-2 py-0.5 text-xs font-mono bg-gray-700 hover:bg-gray-600 text-gray-300 rounded border border-gray-600"
        >
          Cancel
        </button>
      </span>
    );
  }

  if (state === 'loading') {
    return <span className="text-xs font-mono text-gray-400">Submitting...</span>;
  }

  return (
    <span className={`text-xs font-mono ${state === 'done' ? 'text-green-400' : 'text-red-400'}`}>
      {result}
    </span>
  );
}

function StageRow({
  stage,
  record,
  approvalRecords,
  executionRuns,
  jobId,
  tz,
}: {
  stage: string;
  record: StageRecord;
  approvalRecords: Array<Record<string, unknown>>;
  executionRuns: Array<Record<string, unknown>>;
  jobId: string;
  tz: string;
}) {
  const stageApprovals = approvalRecords.filter((a) => a.marketing_stage === stage);
  const stageRuns = executionRuns.filter((r) => r.stage === stage);
  const curlCmd = buildCurlCommand(jobId, stage, record, executionRuns);

  const endTime = record.completed_at ?? record.failed_at;

  return (
    <tr className="border-t border-gray-800 align-top">
      <td className="py-3 px-3 font-mono text-sm text-gray-200 whitespace-nowrap">{stage}</td>
      <td className="py-3 px-3">
        <StatusBadge status={record.status} />
      </td>
      <td className="py-3 px-3 font-mono text-xs text-gray-400 whitespace-nowrap">
        <span title={localTimeTooltip(record.started_at, tz)}>{formatUtcTime(record.started_at)} / {formatTenantTime(record.started_at, tz)}</span>
      </td>
      <td className="py-3 px-3 font-mono text-xs text-gray-400 whitespace-nowrap">
        <span title={localTimeTooltip(endTime, tz)}>{formatUtcTime(endTime)} / {formatTenantTime(endTime, tz)}</span>
      </td>
      <td className="py-3 px-3 font-mono text-xs text-gray-400 whitespace-nowrap">
        {durationMs(record.started_at, endTime)}
      </td>
      <td className="py-3 px-3 font-mono text-xs text-gray-400">
        {record.run_id ? (
          <span className="flex items-center gap-1">
            <span className="text-yellow-300 truncate max-w-[180px]" title={record.run_id}>{record.run_id}</span>
            <CopyButton value={record.run_id} />
          </span>
        ) : <span className="text-gray-600">—</span>}
      </td>
      <td className="py-3 px-3 font-mono text-xs">
        {record.errors.length > 0 ? (
          <div className="text-red-400 space-y-1">
            {record.errors.map((err, i) => (
              <div key={i}>
                <span className="font-bold">{err.code}</span>: {err.message}
                <span className="text-gray-500 ml-1 text-xs" title={localTimeTooltip(err.at, tz)}>{formatUtcTime(err.at)} / {formatTenantTime(err.at, tz)}</span>
              </div>
            ))}
          </div>
        ) : <span className="text-gray-600">—</span>}
      </td>
      <td className="py-3 px-3 text-xs">
        <div className="space-y-1">
          <JsonViewer label="submission input" value={stageRuns[0]?.result ?? null} />
          <JsonViewer label="hermes output" value={record.primary_output} />
          <JsonViewer label="approval records" value={stageApprovals} />
          <div className="flex items-center gap-2 mt-2">
            <CopyButton value={curlCmd} label="Copy curl" />
            <RetryButton jobId={jobId} stage={stage} />
          </div>
        </div>
      </td>
    </tr>
  );
}

function GatewayPingButton({ jobId }: { jobId: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<string>('');

  const handlePing = useCallback(async () => {
    setState('loading');
    try {
      const res = await fetch(`/api/internal/admin/marketing/jobs/${encodeURIComponent(jobId)}/state`);
      if (res.ok) {
        setResult(`Gateway reachable — state loaded in ${res.headers.get('x-response-time') ?? '?'}ms`);
        setState('done');
      } else {
        setResult(`HTTP ${res.status}`);
        setState('error');
      }
    } catch (err) {
      setResult(`Unreachable: ${err instanceof Error ? err.message : String(err)}`);
      setState('error');
    }
  }, [jobId]);

  return (
    <span className="flex items-center gap-2">
      <button
        onClick={handlePing}
        disabled={state === 'loading'}
        className="px-3 py-1 text-xs font-mono bg-gray-700 hover:bg-gray-600 text-gray-200 rounded border border-gray-600 disabled:opacity-50"
      >
        {state === 'loading' ? 'Pinging...' : 'Ping Aries state endpoint'}
      </button>
      {result && (
        <span className={`text-xs font-mono ${state === 'done' ? 'text-green-400' : 'text-red-400'}`}>
          {result}
        </span>
      )}
    </span>
  );
}

export function DebugPanelClient({
  doc,
  approvalRecords,
  executionRuns,
  runtimePath,
  tenantId,
}: Props) {
  const tz = useTenantTimezone();
  const job = doc as unknown as JobDoc;
  const stages = job.stage_order ?? ['research', 'strategy', 'production', 'publish'];

  // Aries run IDs from execution runs for this job
  const runIdPairs = executionRuns.slice(0, 5).map((r) => ({
    aries: String(r.aries_run_id ?? ''),
    hermes: String(r.external_run_id ?? '—'),
    stage: String(r.stage ?? ''),
    status: String(r.status ?? ''),
  }));

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Banner */}
      <div className="bg-yellow-900 border-b border-yellow-700 px-6 py-2 text-sm font-mono text-yellow-200">
        Use this panel when a campaign appears stuck or failed unexpectedly. For normal campaign progress, see the workspace.{' '}
        <a
          href={`/dashboard/social-content/${encodeURIComponent(job.job_id)}`}
          className="underline text-yellow-300 hover:text-yellow-100"
        >
          View on dashboard →
        </a>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-mono font-bold text-white">Marketing Job Debug</h1>
          <p className="text-gray-400 font-mono text-sm mt-1">Admin-only. Tenant: {tenantId}</p>
        </div>

        {/* Job metadata */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
          <h2 className="text-sm font-mono font-semibold text-gray-300 mb-3 uppercase tracking-wide">Campaign Metadata</h2>
          <div className="grid grid-cols-2 gap-x-8 gap-y-2 font-mono text-sm">
            <div className="text-gray-500">Job ID</div>
            <div className="flex items-center gap-1">
              <span className="text-yellow-300">{job.job_id}</span>
              <CopyButton value={job.job_id} />
            </div>
            <div className="text-gray-500">State</div>
            <div><StatusBadge status={job.state} /></div>
            <div className="text-gray-500">Status</div>
            <div><StatusBadge status={job.status} /></div>
            <div className="text-gray-500">Current Stage</div>
            <div className="text-gray-200">{job.current_stage}</div>
            <div className="text-gray-500">Created</div>
            <div className="text-gray-300" title={localTimeTooltip(job.created_at, tz)}>{formatUtcTime(job.created_at)} / {formatTenantTime(job.created_at, tz)}</div>
            <div className="text-gray-500">Updated</div>
            <div className="text-gray-300" title={localTimeTooltip(job.updated_at, tz)}>{formatUtcTime(job.updated_at)} / {formatTenantTime(job.updated_at, tz)}</div>
            {job.failure_reason && (
              <>
                <div className="text-gray-500">Failure Reason</div>
                <div className="text-red-400">{job.failure_reason}</div>
              </>
            )}
            {job.last_error && (
              <>
                <div className="text-gray-500">Last Error</div>
                <div className="text-red-400">
                  <span className="font-bold">{job.last_error.code}</span>: {job.last_error.message}
                  <span className="text-gray-500 ml-2 text-xs">({job.last_error.stage})</span>
                </div>
              </>
            )}
            <div className="text-gray-500">Brand URL</div>
            <div className="text-gray-300 truncate">{String(job.inputs?.brand_url ?? '—')}</div>
            <div className="text-gray-500">Runtime File</div>
            <div className="flex items-center gap-1">
              <span className="text-gray-400 text-xs truncate max-w-xs" title={runtimePath}>{runtimePath}</span>
              <CopyButton value={runtimePath} />
            </div>
          </div>
        </div>

        {/* Run ID mapping */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
          <h2 className="text-sm font-mono font-semibold text-gray-300 mb-3 uppercase tracking-wide">Aries ↔ Hermes Run ID Mapping</h2>
          {runIdPairs.length === 0 ? (
            <p className="text-gray-500 font-mono text-sm">No execution runs recorded for this job.</p>
          ) : (
            <table className="w-full text-xs font-mono border-collapse">
              <thead>
                <tr className="text-gray-500 text-left">
                  <th className="pb-2 pr-4">Stage</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2 pr-4">Aries Run ID</th>
                  <th className="pb-2">Hermes Run ID</th>
                </tr>
              </thead>
              <tbody>
                {runIdPairs.map((pair, i) => (
                  <tr key={i} className="border-t border-gray-800">
                    <td className="py-1.5 pr-4 text-gray-300">{pair.stage || '—'}</td>
                    <td className="py-1.5 pr-4"><StatusBadge status={pair.status} /></td>
                    <td className="py-1.5 pr-4">
                      <span className="text-blue-300 truncate max-w-[200px] inline-block" title={pair.aries}>{pair.aries || '—'}</span>
                      {pair.aries && <CopyButton value={pair.aries} />}
                    </td>
                    <td className="py-1.5">
                      <span className="text-yellow-300 truncate max-w-[200px] inline-block" title={pair.hermes}>{pair.hermes}</span>
                      {pair.hermes !== '—' && <CopyButton value={pair.hermes} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Stage timeline */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
          <h2 className="text-sm font-mono font-semibold text-gray-300 mb-3 uppercase tracking-wide">Stage Timeline</h2>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-gray-500 font-mono text-xs text-left">
                  <th className="pb-2 px-3 whitespace-nowrap">Stage</th>
                  <th className="pb-2 px-3 whitespace-nowrap">Status</th>
                  <th className="pb-2 px-3 whitespace-nowrap">Started (UTC)</th>
                  <th className="pb-2 px-3 whitespace-nowrap">Ended (UTC)</th>
                  <th className="pb-2 px-3 whitespace-nowrap">Duration</th>
                  <th className="pb-2 px-3 whitespace-nowrap">Hermes Run ID</th>
                  <th className="pb-2 px-3 whitespace-nowrap">Errors</th>
                  <th className="pb-2 px-3 whitespace-nowrap">Details</th>
                </tr>
              </thead>
              <tbody>
                {stages.map((stage) => {
                  const record = (job.stages?.[stage] ?? {
                    stage,
                    status: 'not_started',
                    started_at: null,
                    completed_at: null,
                    failed_at: null,
                    run_id: null,
                    errors: [],
                    primary_output: null,
                    outputs: {},
                    artifacts: [],
                  }) as StageRecord;
                  return (
                    <StageRow
                      key={stage}
                      stage={stage}
                      record={record}
                      approvalRecords={approvalRecords}
                      executionRuns={executionRuns}
                      jobId={job.job_id}
                      tz={tz}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Full job JSON */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
          <h2 className="text-sm font-mono font-semibold text-gray-300 mb-3 uppercase tracking-wide">Full Runtime Document</h2>
          <JsonViewer label="runtime.json" value={doc} />
        </div>

        {/* DX tools */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
          <h2 className="text-sm font-mono font-semibold text-gray-300 mb-3 uppercase tracking-wide">DX Tools</h2>
          <div className="space-y-3">
            <GatewayPingButton jobId={job.job_id} />
            <p className="text-gray-500 font-mono text-xs">
              Not exposed here: Hermes-side kanban state (requires Hermes admin API), container log tail (not available in this environment).
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
