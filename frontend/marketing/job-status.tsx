"use client";

import { useMemo, useState } from 'react';

import { createMarketingClient } from '../api/client/marketing';
import type {
  GetMarketingJobStatusResponse,
  HardFailureError,
  UnhandledError
} from '../api/contracts/marketing';
import StatusBadge from '../components/status-badge';
import {
  marketing_job_status_values,
  next_step_values,
  repair_status_values
} from '../types/runtime';
import { getMarketingStateHints, nextStepGuidance } from './state-view';

type JobStatusResult = GetMarketingJobStatusResponse | HardFailureError | UnhandledError;

export interface MarketingJobStatusScreenProps {
  baseUrl?: string;
  defaultJobId?: string;
}

function isErrorResult(value: JobStatusResult | null): value is HardFailureError | UnhandledError {
  return !!value && typeof value === 'object' && 'error' in value;
}

export function MarketingJobStatusScreen(props: MarketingJobStatusScreenProps) {
  const client = useMemo(() => createMarketingClient({ baseUrl: props.baseUrl }), [props.baseUrl]);

  const [jobId, setJobId] = useState(props.defaultJobId ?? '');
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [result, setResult] = useState<JobStatusResult | null>(null);

  async function handleLoadStatus() {
    const trimmedJobId = jobId.trim();
    if (!trimmedJobId) {
      setRequestError('jobId is required');
      return;
    }

    setLoading(true);
    setRequestError(null);
    try {
      const response = await client.getJob(trimmedJobId);
      setResult(response);
    } catch (error) {
      setResult(null);
      setRequestError(error instanceof Error ? error.message : 'Failed to load job status');
    } finally {
      setLoading(false);
    }
  }

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

      {requestError ? <pre style={{ marginTop: 16 }}>{requestError}</pre> : null}

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

          <h4>Raw response</h4>
          <pre>{JSON.stringify(successResult, null, 2)}</pre>
        </div>
      ) : null}
    </section>
  );
}

export default MarketingJobStatusScreen;
