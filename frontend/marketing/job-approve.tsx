"use client";

import { useMemo, useState, type ReactNode } from 'react';
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

function Field({
  label,
  children,
  hint
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label style={{ display: 'grid', gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: '#344054', letterSpacing: 0.2 }}>{label}</span>
      {children}
      {hint ? <span style={{ fontSize: 12, color: '#667085' }}>{hint}</span> : null}
    </label>
  );
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
      return { tone: 'danger', text: `Approval failed: ${approveResult.error}` };
    }
    return approveResult.approval_status === 'resumed'
      ? { tone: 'success', text: 'Approval succeeded and resume was accepted.' }
      : { tone: 'danger', text: `Approval failed: ${approveResult.approval_status}` };
  })();

  return (
    <section
      style={{
        minHeight: '100vh',
        padding: 24,
        background:
          'radial-gradient(1200px 400px at 20% -10%, #e0f2fe 0%, transparent 60%), radial-gradient(1200px 500px at 100% 0%, #fce7f3 0%, transparent 55%), #f8fafc'
      }}
    >
      <div style={{ maxWidth: 980, margin: '0 auto', display: 'grid', gap: 16 }}>
        <header
          style={{
            padding: '20px 22px',
            borderRadius: 14,
            background: 'linear-gradient(135deg, #0f172a, #1d4ed8)',
            color: 'white',
            boxShadow: '0 18px 40px rgba(2,6,23,0.25)'
          }}
        >
          <p style={{ margin: 0, fontSize: 12, opacity: 0.8, letterSpacing: 0.4 }}>ARIES • OPERATIONS</p>
          <h1 style={{ margin: '6px 0 4px', fontSize: 28 }}>Marketing Job Approval</h1>
          <p style={{ margin: 0, opacity: 0.9 }}>
            Resume a paused marketing workflow through the live backend endpoint.
          </p>
        </header>

        <div style={{ display: 'grid', gap: 16, gridTemplateColumns: '1.3fr 1fr' }}>
          <article
            style={{
              borderRadius: 14,
              background: 'white',
              border: '1px solid #e4e7ec',
              padding: 18,
              boxShadow: '0 8px 22px rgba(15, 23, 42, 0.06)',
              display: 'grid',
              gap: 14
            }}
          >
            <h2 style={{ margin: 0, fontSize: 18, color: '#101828' }}>Approval Request</h2>

            <Field label="Job ID" hint="Required route key for /api/marketing/jobs/:jobId/approve">
              <input
                value={jobId}
                onChange={(event) => setJobId(event.target.value)}
                placeholder="mkt_..."
                style={{ border: '1px solid #d0d5dd', borderRadius: 10, padding: '10px 12px', fontSize: 14 }}
              />
            </Field>

            <Field label="Tenant ID">
              <input
                value={tenantId}
                onChange={(event) => setTenantId(event.target.value)}
                placeholder="acme-phase5"
                style={{ border: '1px solid #d0d5dd', borderRadius: 10, padding: '10px 12px', fontSize: 14 }}
              />
            </Field>

            <Field label="Approved By">
              <input
                value={approvedBy}
                onChange={(event) => setApprovedBy(event.target.value)}
                placeholder="operator"
                style={{ border: '1px solid #d0d5dd', borderRadius: 10, padding: '10px 12px', fontSize: 14 }}
              />
            </Field>

            <div style={{ display: 'grid', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#344054' }}>Approved stages</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {APPROVAL_STAGE_VALUES.map((stage) => {
                  const active = approvedStages.includes(stage);
                  return (
                    <button
                      key={stage}
                      type="button"
                      onClick={() => toggleStage(stage)}
                      style={{
                        border: active ? '1px solid #1d4ed8' : '1px solid #d0d5dd',
                        background: active ? '#eff6ff' : 'white',
                        color: active ? '#1e40af' : '#344054',
                        borderRadius: 999,
                        padding: '6px 12px',
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: 'pointer'
                      }}
                    >
                      {stage}
                    </button>
                  );
                })}
              </div>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#344054' }}>
              <input
                type="checkbox"
                checked={resumePublishIfNeeded}
                onChange={(event) => setResumePublishIfNeeded(event.target.checked)}
              />
              Resume publish if needed
            </label>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={handleLoadStatus}
                disabled={loadingStatus || !jobId.trim()}
                style={{
                  borderRadius: 10,
                  border: '1px solid #1d4ed8',
                  background: 'white',
                  color: '#1d4ed8',
                  padding: '9px 14px',
                  fontWeight: 700,
                  cursor: 'pointer'
                }}
              >
                {loadingStatus ? 'Loading…' : 'Load current status'}
              </button>
              <button
                type="button"
                onClick={handleApprove}
                disabled={!canSubmit}
                style={{
                  borderRadius: 10,
                  border: '1px solid #0f172a',
                  background: canSubmit ? '#0f172a' : '#98a2b3',
                  color: 'white',
                  padding: '9px 14px',
                  fontWeight: 700,
                  cursor: canSubmit ? 'pointer' : 'not-allowed'
                }}
              >
                {submitting ? 'Approving…' : 'Approve and Resume'}
              </button>
            </div>
          </article>

          <article
            style={{
              borderRadius: 14,
              background: 'white',
              border: '1px solid #e4e7ec',
              padding: 18,
              boxShadow: '0 8px 22px rgba(15, 23, 42, 0.06)',
              display: 'grid',
              gap: 12,
              alignContent: 'start'
            }}
          >
            <h3 style={{ margin: 0, fontSize: 16, color: '#101828' }}>Outcome</h3>

            {!approvalMessage ? (
              <p style={{ margin: 0, color: '#667085', fontSize: 13 }}>Run an approval action to see result state.</p>
            ) : (
              <div
                style={{
                  borderRadius: 10,
                  padding: '10px 12px',
                  border: approvalMessage.tone === 'success' ? '1px solid #16a34a' : '1px solid #dc2626',
                  background: approvalMessage.tone === 'success' ? '#f0fdf4' : '#fef2f2',
                  color: approvalMessage.tone === 'success' ? '#166534' : '#991b1b',
                  fontWeight: 700
                }}
              >
                {approvalMessage.text}
              </div>
            )}

            {approveResult ? (
              <details open style={{ marginTop: 4 }}>
                <summary style={{ cursor: 'pointer', fontWeight: 700, color: '#344054' }}>Approve response JSON</summary>
                <pre
                  style={{
                    marginTop: 8,
                    background: '#0b1020',
                    color: '#d1e9ff',
                    borderRadius: 10,
                    padding: 12,
                    fontSize: 12,
                    overflow: 'auto'
                  }}
                >
                  {JSON.stringify(approveResult, null, 2)}
                </pre>
              </details>
            ) : null}

            {jobStatus ? (
              <details style={{ marginTop: 4 }}>
                <summary style={{ cursor: 'pointer', fontWeight: 700, color: '#344054' }}>Live job status JSON</summary>
                <pre
                  style={{
                    marginTop: 8,
                    background: '#101828',
                    color: '#d1fadf',
                    borderRadius: 10,
                    padding: 12,
                    fontSize: 12,
                    overflow: 'auto'
                  }}
                >
                  {JSON.stringify(jobStatus, null, 2)}
                </pre>
              </details>
            ) : null}
          </article>
        </div>
      </div>
    </section>
  );
}

export default MarketingJobApproveScreen;
