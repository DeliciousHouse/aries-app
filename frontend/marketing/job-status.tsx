"use client";

import { useEffect, useState } from 'react';

import type {
  GetMarketingJobStatusResponse,
  MarketingApiError,
} from '@/lib/api/marketing';
import { useMarketingJobStatus } from '@/hooks/use-marketing-job-status';
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
    <section>
      <h2>Marketing Job Status</h2>
      <p>Load a job to inspect stage progress, repair state, and next-step guidance.</p>

      <div>
        <label>
          Job ID
          <input
            value={jobId}
            onChange={(event) => setJobId(event.target.value)}
            placeholder="mkt_..."
          />
        </label>
      </div>

      <div style={{ marginTop: 12 }}>
        <button type="button" onClick={handleLoadStatus} disabled={loading || !jobId.trim()}>
          {loading ? 'Loading…' : 'Load job status'}
        </button>
      </div>

      {marketingStatus.error ? <pre style={{ marginTop: 16 }}>{marketingStatus.error.message}</pre> : null}

      {result && isErrorResult(result) ? (
        <div style={{ marginTop: 16 }}>
          <h3>API error</h3>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </div>
      ) : null}

      {successResult ? (
        <div style={{ marginTop: 16 }}>
          <h3>Status</h3>
          <dl>
            <dt>marketing_stage</dt>
            <dd>{successResult.marketing_stage ?? 'null'}</dd>

            <dt>marketing_job_status</dt>
            <dd>
              {successResult.marketing_job_status}{' '}
              {hasKnownJobStatus ? (
                <StatusBadge
                  status={successResult.marketing_job_status as (typeof marketing_job_status_values)[number]}
                />
              ) : null}
            </dd>

            <dt>repair_status</dt>
            <dd>
              {hints?.repairStatus ?? 'n/a'}{' '}
              {knownRepairStatus ? (
                <StatusBadge status={hints.repairStatus as (typeof repair_status_values)[number]} />
              ) : null}
            </dd>

            <dt>next_step</dt>
            <dd>{hints?.nextStep ?? 'none'}</dd>
          </dl>

          {knownNextStep ? <p>{nextStepGuidance(hints?.nextStep) ?? 'No extra guidance.'}</p> : null}

          <h4>Stage status</h4>
          {!hints || hints.stageStatuses.length === 0 ? (
            <p>No stage status values returned.</p>
          ) : (
            <ul>
              {hints.stageStatuses.map((row) => (
                <li key={row.stage}>
                  <strong>{row.stage}</strong>: {row.status}{' '}
                  {marketing_job_status_values.includes(
                    row.status as (typeof marketing_job_status_values)[number]
                  ) ? (
                    <StatusBadge status={row.status as (typeof marketing_job_status_values)[number]} />
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {successResult.needs_attention ? (
            <p role="alert">This workflow needs attention before it can continue.</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export default MarketingJobStatusScreen;
