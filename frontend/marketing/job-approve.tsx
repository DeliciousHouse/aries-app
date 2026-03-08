import { useMemo, useState } from 'react';
import { createMarketingClient } from '../api/client/marketing';
import type {
  ApproveJobResult,
  GetMarketingJobStatusResponse,
  HardFailureError,
  MarketingStage,
  PostMarketingJobApproveRequest,
  UnhandledError
} from '../api/contracts/marketing';

type ApproveResult = ApproveJobResult | HardFailureError | UnhandledError;
type JobStatusResult = GetMarketingJobStatusResponse | HardFailureError | UnhandledError;

const APPROVAL_STAGE_VALUES: MarketingStage[] = ['research', 'strategy', 'production', 'publish'];

export interface MarketingJobApproveScreenProps {
  baseUrl?: string;
  defaultTenantId?: string;
  defaultJobId?: string;
  defaultApprovedBy?: string;
}

function isErrorResult(value: unknown): value is HardFailureError | UnhandledError {
  return !!value && typeof value === 'object' && 'error' in value;
}

export function MarketingJobApproveScreen(props: MarketingJobApproveScreenProps) {
  const client = useMemo(() => createMarketingClient({ baseUrl: props.baseUrl }), [props.baseUrl]);

  const [jobId, setJobId] = useState(props.defaultJobId ?? '');
  const [tenantId, setTenantId] = useState(props.defaultTenantId ?? '');
  const [approvedBy, setApprovedBy] = useState(props.defaultApprovedBy ?? '');
  const [resumePublishIfNeeded, setResumePublishIfNeeded] = useState(true);
  const [approvedStages, setApprovedStages] = useState<MarketingStage[]>([]);

  const [loadingStatus, setLoadingStatus] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [jobStatus, setJobStatus] = useState<JobStatusResult | null>(null);
  const [approveResult, setApproveResult] = useState<ApproveResult | null>(null);

  const canSubmit =
    jobId.trim().length > 0 &&
    tenantId.trim().length > 0 &&
    approvedBy.trim().length > 0 &&
    !submitting;

  async function handleLoadStatus() {
    if (!jobId.trim()) return;
    setLoadingStatus(true);
    setApproveResult(null);
    try {
      const result = await client.getJob(jobId.trim());
      setJobStatus(result);
    } finally {
      setLoadingStatus(false);
    }
  }

  function toggleStage(stage: MarketingStage) {
    setApprovedStages((prev) =>
      prev.includes(stage) ? prev.filter((value) => value !== stage) : [...prev, stage]
    );
  }

  async function handleApprove() {
    if (!canSubmit) return;

    const body: PostMarketingJobApproveRequest = {
      tenantId: tenantId.trim(),
      approvedBy: approvedBy.trim(),
      approvedStages: approvedStages.length > 0 ? approvedStages : undefined,
      resumePublishIfNeeded
    };

    setSubmitting(true);
    setApproveResult(null);
    try {
      const result = await client.approveJob(jobId.trim(), body);
      setApproveResult(result);
      if (!isErrorResult(result)) {
        const refreshed = await client.getJob(jobId.trim());
        setJobStatus(refreshed);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const approvalMessage = (() => {
    if (!approveResult) return null;
    if (isErrorResult(approveResult)) {
      return `Approval failed: ${approveResult.error}`;
    }
    return approveResult.approval_status === 'resumed'
      ? `Approval succeeded: ${approveResult.approval_status}`
      : `Approval failed: ${approveResult.approval_status}`;
  })();

  return (
    <section>
      <h2>Marketing Job Approval</h2>

      <div>
        <label>
          Job ID
          <input value={jobId} onChange={(event) => setJobId(event.target.value)} placeholder="job id" />
        </label>
      </div>

      <div>
        <label>
          Tenant ID
          <input value={tenantId} onChange={(event) => setTenantId(event.target.value)} placeholder="tenant id" />
        </label>
      </div>

      <div>
        <label>
          Approved By
          <input value={approvedBy} onChange={(event) => setApprovedBy(event.target.value)} placeholder="approver" />
        </label>
      </div>

      <fieldset>
        <legend>Approved stages (leave empty to approve all)</legend>
        {APPROVAL_STAGE_VALUES.map((stage) => (
          <label key={stage} style={{ display: 'block' }}>
            <input
              type="checkbox"
              checked={approvedStages.includes(stage)}
              onChange={() => toggleStage(stage)}
            />
            {stage}
          </label>
        ))}
      </fieldset>

      <label>
        <input
          type="checkbox"
          checked={resumePublishIfNeeded}
          onChange={(event) => setResumePublishIfNeeded(event.target.checked)}
        />
        Resume publish if needed
      </label>

      <div style={{ marginTop: 12 }}>
        <button type="button" onClick={handleLoadStatus} disabled={loadingStatus || !jobId.trim()}>
          {loadingStatus ? 'Loading…' : 'Load job status'}
        </button>
        <button type="button" onClick={handleApprove} disabled={!canSubmit} style={{ marginLeft: 8 }}>
          {submitting ? 'Approving…' : 'Approve job'}
        </button>
      </div>

      {approvalMessage && (
        <div style={{ marginTop: 16 }}>
          <strong>{approvalMessage}</strong>
        </div>
      )}

      {jobStatus && (
        <div style={{ marginTop: 16 }}>
          <h3>Job status response</h3>
          <pre>{JSON.stringify(jobStatus, null, 2)}</pre>
        </div>
      )}

      {approveResult && (
        <div style={{ marginTop: 16 }}>
          <h3>Approve response</h3>
          <pre>{JSON.stringify(approveResult, null, 2)}</pre>
        </div>
      )}
    </section>
  );
}

export default MarketingJobApproveScreen;
