"use client";

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import type {
  ApproveJobResult,
  GetMarketingJobStatusResponse,
  MarketingApiError,
  MarketingStage,
  PostMarketingJobApproveRequest,
} from '@/lib/api/marketing';
import { useMarketingJobApprove } from '@/hooks/use-marketing-job-approve';
import { useMarketingJobStatus } from '@/hooks/use-marketing-job-status';
import { Button } from '@/components/redesign/primitives/button';
import { Card } from '@/components/redesign/primitives/card';
import { TextInput } from '@/components/redesign/primitives/input';
import StatusBadge from '../components/status-badge';
import {
  marketing_job_status_values,
  next_step_values,
  repair_status_values
} from '../types/runtime';
import { getMarketingStateHints, nextStepGuidance } from './state-view';

type ApproveResult = ApproveJobResult | MarketingApiError;
type JobStatusResult = GetMarketingJobStatusResponse | MarketingApiError;

const APPROVAL_STAGE_VALUES: MarketingStage[] = ['research', 'strategy', 'production', 'publish'];

export interface MarketingJobApproveScreenProps {
  baseUrl?: string;
  defaultJobId?: string;
  defaultApprovedBy?: string;
}

function isErrorResult(value: unknown): value is MarketingApiError {
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
    <label className="rd-field">
      <span className="rd-label">{label}</span>
      {children}
      {hint ? <span style={{ color: 'var(--rd-text-secondary)', fontSize: '0.9rem' }}>{hint}</span> : null}
    </label>
  );
}

export function MarketingJobApproveScreen(props: MarketingJobApproveScreenProps) {
  const marketingApprove = useMarketingJobApprove({ baseUrl: props.baseUrl });
  const marketingStatus = useMarketingJobStatus({ baseUrl: props.baseUrl, autoLoad: false });

  const [jobId, setJobId] = useState(props.defaultJobId ?? '');
  const [approvedBy, setApprovedBy] = useState(props.defaultApprovedBy ?? '');
  const [resumePublishIfNeeded, setResumePublishIfNeeded] = useState(true);
  const [approvedStages, setApprovedStages] = useState<MarketingStage[]>([]);

  const [loadingStatus, setLoadingStatus] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [jobStatus, setJobStatus] = useState<JobStatusResult | null>(null);
  const [approveResult, setApproveResult] = useState<ApproveResult | null>(null);

  const canSubmit =
    jobId.trim().length > 0 &&
    approvedBy.trim().length > 0 &&
    !submitting;

  async function handleLoadStatus() {
    if (!jobId.trim()) return;
    setLoadingStatus(true);
    setApproveResult(null);
    try {
      marketingStatus.reset();
      const result = await marketingStatus.load(jobId.trim());
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
      approvedBy: approvedBy.trim(),
      approvedStages: approvedStages.length > 0 ? approvedStages : undefined,
      resumePublishIfNeeded
    };

    setSubmitting(true);
    setApproveResult(null);
    try {
      marketingApprove.reset();
      const result = await marketingApprove.approveJob(jobId.trim(), body);
      if (!result) {
        return;
      }
      setApproveResult(result);
      if (!isErrorResult(result)) {
        const refreshed = await marketingStatus.load(jobId.trim());
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

  const statusSuccess = jobStatus && !isErrorResult(jobStatus) ? jobStatus : null;
  const approveSuccess = approveResult && !isErrorResult(approveResult) ? approveResult : null;
  const statusHints =
    statusSuccess && getMarketingStateHints(statusSuccess.marketing_job_state, statusSuccess.marketing_stage_status);

  const hasKnownJobStatus =
    !!statusSuccess && marketing_job_status_values.includes(statusSuccess.marketing_job_status as any);

  const knownRepairStatus =
    statusHints?.repairStatus &&
    repair_status_values.includes(statusHints.repairStatus as (typeof repair_status_values)[number]);

  const knownNextStep =
    statusHints?.nextStep && next_step_values.includes(statusHints.nextStep as (typeof next_step_values)[number]);

  return (
    <div className="rd-workflow-grid rd-workflow-grid--2">
      <Card>
        <div style={{ display: 'grid', gap: '1rem' }}>
          <div>
            <p className="rd-section-label">Approval control</p>
            <h1 style={{ margin: '0.8rem 0 0.5rem', fontFamily: 'var(--rd-font-display)', fontSize: '2rem' }}>
              Resume a paused marketing workflow
            </h1>
            <p className="rd-section-description">
              Submit approval decisions through the internal Aries route and refresh live status without exposing workflow runner details.
            </p>
          </div>

            <Field label="Job ID" hint="Required route key for /api/marketing/jobs/:jobId/approve">
              <TextInput
                value={jobId}
                onChange={(event) => setJobId(event.target.value)}
                placeholder="mkt_..."
              />
            </Field>

            <Field label="Approved By">
              <TextInput
                value={approvedBy}
                onChange={(event) => setApprovedBy(event.target.value)}
                placeholder="operator"
              />
            </Field>

            <div style={{ display: 'grid', gap: 8 }}>
              <span className="rd-label">Approved stages</span>
              <div className="rd-chip-group">
                {APPROVAL_STAGE_VALUES.map((stage) => {
                  const active = approvedStages.includes(stage);
                  return (
                    <button
                      key={stage}
                      type="button"
                      onClick={() => toggleStage(stage)}
                      className="rd-chip"
                      data-active={active}
                    >
                      {stage}
                    </button>
                  );
                })}
              </div>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--rd-text-secondary)' }}>
              <input
                type="checkbox"
                checked={resumePublishIfNeeded}
                onChange={(event) => setResumePublishIfNeeded(event.target.checked)}
              />
              Resume publish if needed
            </label>

            <div className="rd-inline-actions">
              <Button type="button" onClick={handleLoadStatus} disabled={loadingStatus || !jobId.trim()} variant="secondary">
                {loadingStatus ? 'Loading…' : 'Load current status'}
              </Button>
              <Button type="button" onClick={handleApprove} disabled={!canSubmit}>
                {submitting ? 'Approving…' : 'Approve and Resume'}
              </Button>
            </div>

            {marketingStatus.error || marketingApprove.error ? (
              <div className="rd-alert rd-alert--danger">
                {marketingApprove.error?.message || marketingStatus.error?.message}
              </div>
            ) : null}
        </div>
      </Card>

      <Card>
        <div style={{ display: 'grid', gap: '1rem' }}>
          <p className="rd-section-label">Outcome</p>

            {!approvalMessage ? (
              <p className="rd-section-description">Run an approval action to see result state.</p>
            ) : (
              <div
                className={approvalMessage.tone === 'success' ? 'rd-alert rd-alert--success' : 'rd-alert rd-alert--danger'}
              >
                <div style={{ display: 'grid', gap: '0.75rem' }}>
                  <span>{approvalMessage.text}</span>
                  {approveSuccess?.jobStatusUrl ? (
                    <Link href={approveSuccess.jobStatusUrl} className="rd-button rd-button--secondary">
                      Review updated status
                    </Link>
                  ) : null}
                </div>
              </div>
            )}

            {statusSuccess ? (
              <div className="rd-summary-list">
                <div className="rd-summary-row">
                  <strong>Job status</strong>
                  {hasKnownJobStatus ? (
                    <StatusBadge
                      status={statusSuccess.marketing_job_status as (typeof marketing_job_status_values)[number]}
                    />
                  ) : <span>{statusSuccess.marketing_job_status}</span>}
                </div>
                <div className="rd-summary-row"><strong>Current stage</strong><span>{statusSuccess.marketing_stage ?? 'none'}</span></div>
                <div className="rd-summary-row">
                  <strong>Repair status</strong>
                  {knownRepairStatus ? (
                    <StatusBadge status={statusHints.repairStatus as (typeof repair_status_values)[number]} />
                  ) : <span>{statusHints?.repairStatus ?? 'n/a'}</span>}
                </div>
                <div className="rd-summary-row"><strong>Next step</strong><span>{statusHints?.nextStep ?? 'none'}</span></div>
                {knownNextStep ? (
                  <div className="rd-alert rd-alert--info">{nextStepGuidance(statusHints?.nextStep)}</div>
                ) : null}

                {statusHints && statusHints.stageStatuses.length > 0 ? (
                  <div>
                    <p className="rd-label" style={{ marginBottom: '0.75rem' }}>Stage status</p>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {statusHints.stageStatuses.map((row) => (
                        <li key={row.stage}>
                          {row.stage}: {row.status}{' '}
                          {marketing_job_status_values.includes(
                            row.status as (typeof marketing_job_status_values)[number]
                          ) ? (
                            <StatusBadge status={row.status as (typeof marketing_job_status_values)[number]} />
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}

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
        </div>
      </Card>
    </div>
  );
}

export default MarketingJobApproveScreen;
