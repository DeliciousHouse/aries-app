"use client";

import Link from 'next/link';
import { useEffect, useState } from 'react';

import type {
  GetMarketingJobStatusResponse,
  MarketingApiError,
} from '@/lib/api/marketing';
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

type JobStatusResult = GetMarketingJobStatusResponse | MarketingApiError;

export interface MarketingJobStatusScreenProps {
  baseUrl?: string;
  defaultJobId?: string;
}

export function normalizeMarketingJobId(jobId?: string): string {
  return jobId?.trim() || '';
}

function isErrorResult(value: JobStatusResult | null): value is MarketingApiError {
  return !!value && typeof value === 'object' && 'error' in value;
}

export function MarketingJobStatusScreen(props: MarketingJobStatusScreenProps) {
  const marketingStatus = useMarketingJobStatus({
    baseUrl: props.baseUrl,
    jobId: props.defaultJobId,
    autoLoad: false,
  });

  const [jobId, setJobId] = useState(normalizeMarketingJobId(props.defaultJobId));
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<JobStatusResult | null>(null);

  async function loadStatus(rawJobId: string) {
    const trimmedJobId = normalizeMarketingJobId(rawJobId);
    if (!trimmedJobId) {
      marketingStatus.setError(new Error('jobId is required'));
      return;
    }

    setLoading(true);
    try {
      marketingStatus.reset();
      const response = await marketingStatus.load(trimmedJobId);
      setResult(response);
    } finally {
      setLoading(false);
    }
  }

  async function handleLoadStatus() {
    await loadStatus(jobId);
  }

  useEffect(() => {
    const initialJobId = normalizeMarketingJobId(props.defaultJobId);
    setJobId(initialJobId);

    if (!initialJobId) {
      return;
    }

    void loadStatus(initialJobId);
  }, [props.defaultJobId]);

  const successResult = result && !isErrorResult(result) ? result : null;
  const hints =
    successResult &&
    getMarketingStateHints(successResult.marketing_job_state, successResult.marketing_stage_status);

  const hasKnownJobStatus =
    !!successResult && marketing_job_status_values.includes(successResult.marketing_job_status as any);

  const knownRepairStatus =
    hints?.repairStatus &&
    repair_status_values.includes(hints.repairStatus as (typeof repair_status_values)[number]);

  const knownNextStep =
    hints?.nextStep && next_step_values.includes(hints.nextStep as (typeof next_step_values)[number]);

  return (
    <div className="rd-workflow-grid rd-workflow-grid--2">
      <Card>
        <div style={{ display: 'grid', gap: '1rem' }}>
          <div>
            <p className="rd-section-label">Job status</p>
            <h2 style={{ margin: '0.8rem 0 0.5rem', fontFamily: 'var(--rd-font-display)', fontSize: '2rem' }}>
              Inspect current workflow progress
            </h2>
            <p className="rd-section-description">
              Load a job ID to inspect phase progress, repair state, and the next recommended operator action.
            </p>
          </div>

          <label className="rd-field">
            <span className="rd-label">Job ID</span>
            <TextInput value={jobId} onChange={(event) => setJobId(event.target.value)} placeholder="mkt_..." />
          </label>

          <Button type="button" onClick={handleLoadStatus} disabled={loading || !jobId.trim()}>
            {loading ? 'Loading…' : 'Load job status'}
          </Button>

          {marketingStatus.error ? <div className="rd-alert rd-alert--danger">{marketingStatus.error.message}</div> : null}
          {result && isErrorResult(result) ? <div className="rd-alert rd-alert--danger">{result.error}</div> : null}
        </div>
      </Card>

      <Card>
        <div style={{ display: 'grid', gap: '1rem' }}>
          <p className="rd-section-label">Workflow state</p>

          {!successResult ? (
            <div className="rd-empty" style={{ minHeight: '320px' }}>
              <strong>No job loaded</strong>
              <p>Enter a job ID to review the current stage, per-stage status, and recommended next step.</p>
            </div>
          ) : (
            <>
              <div className="rd-summary-list">
                <div className="rd-summary-row"><strong>Current stage</strong><span>{successResult.marketing_stage ?? 'none'}</span></div>
                <div className="rd-summary-row">
                  <strong>Job status</strong>
                  {hasKnownJobStatus ? (
                    <StatusBadge status={successResult.marketing_job_status as (typeof marketing_job_status_values)[number]} />
                  ) : (
                    <span>{successResult.marketing_job_status}</span>
                  )}
                </div>
                <div className="rd-summary-row">
                  <strong>Repair status</strong>
                  {knownRepairStatus ? (
                    <StatusBadge status={hints?.repairStatus as (typeof repair_status_values)[number]} />
                  ) : (
                    <span>{hints?.repairStatus ?? 'n/a'}</span>
                  )}
                </div>
                <div className="rd-summary-row"><strong>Next step</strong><span>{hints?.nextStep ?? 'none'}</span></div>
              </div>

              {knownNextStep ? (
                <div className="rd-alert rd-alert--info">{nextStepGuidance(hints?.nextStep) ?? 'No extra guidance.'}</div>
              ) : null}

              {successResult.approvalRequired ? (
                <div className="rd-inline-actions">
                  <Link
                    href={`/marketing/job-approve?jobId=${encodeURIComponent(successResult.jobId)}`}
                    className="rd-button rd-button--secondary"
                  >
                    Open approval dashboard
                  </Link>
                </div>
              ) : null}

              <div>
                <p className="rd-label" style={{ marginBottom: '0.75rem' }}>Stage status</p>
                {!hints || hints.stageStatuses.length === 0 ? (
                  <p className="rd-section-description">No stage status values returned.</p>
                ) : (
                  <div className="rd-chip-group">
                    {hints.stageStatuses.map((row) => (
                      <span key={row.stage} className="rd-chip" data-active="true">
                        <strong>{row.stage}</strong>
                        {marketing_job_status_values.includes(row.status as (typeof marketing_job_status_values)[number]) ? (
                          <StatusBadge status={row.status as (typeof marketing_job_status_values)[number]} />
                        ) : (
                          <span>{row.status}</span>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {successResult.needs_attention ? (
                <div className="rd-alert rd-alert--danger">This workflow needs operator attention before it can continue.</div>
              ) : null}
            </>
          )}
        </div>
      </Card>
    </div>
  );
}

export default MarketingJobStatusScreen;
