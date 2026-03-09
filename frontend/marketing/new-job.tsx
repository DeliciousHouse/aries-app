"use client";

import React, { useMemo, useState, type FormEvent } from 'react';

import { createMarketingClient, type MarketingClientOptions } from '../api/client/marketing';
import type {
  MarketingJobType,
  PostMarketingJobsRequest,
  StartJobAccepted,
  HardFailureError,
  UnhandledError
} from '../api/contracts/marketing';
import StatusBadge from '../components/status-badge';

type CreateJobResult = StartJobAccepted | HardFailureError | UnhandledError;

const jobTypeOptions: MarketingJobType[] = [
  'marketing_research',
  'marketing_strategy',
  'marketing_production',
  'marketing_publish',
  'unknown'
];

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isErrorResult(value: CreateJobResult): value is HardFailureError | UnhandledError {
  return typeof (value as HardFailureError | UnhandledError)?.error === 'string';
}

export interface MarketingNewJobScreenProps {
  clientOptions?: MarketingClientOptions;
}

export function MarketingNewJobScreen(props: MarketingNewJobScreenProps) {
  const client = useMemo(() => createMarketingClient(props.clientOptions), [props.clientOptions]);

  const [tenantId, setTenantId] = useState('');
  const [jobType, setJobType] = useState<MarketingJobType>('marketing_research');
  const [payloadText, setPayloadText] = useState('{}');

  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [success, setSuccess] = useState<StartJobAccepted | null>(null);
  const [result, setResult] = useState<CreateJobResult | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorText(null);
    setSuccess(null);
    setResult(null);

    const trimmedTenantId = tenantId.trim();
    if (!trimmedTenantId) {
      setErrorText('tenantId is required');
      return;
    }

    let payload: Record<string, unknown> | undefined;
    const normalizedPayloadText = payloadText.trim();

    if (normalizedPayloadText.length > 0) {
      try {
        const parsed = JSON.parse(normalizedPayloadText) as unknown;
        if (!isObjectRecord(parsed)) {
          setErrorText('payload must be a JSON object');
          return;
        }
        payload = parsed;
      } catch {
        setErrorText('payload must be valid JSON');
        return;
      }
    }

    const request: PostMarketingJobsRequest = {
      tenantId: trimmedTenantId,
      jobType,
      ...(payload ? { payload } : {})
    };

    setSubmitting(true);
    try {
      const response = await client.createJob(request);
      setResult(response);

      if (isErrorResult(response)) {
        setErrorText(response.error);
        return;
      }

      setSuccess(response);
    } catch {
      setErrorText('Failed to create marketing job');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h1>New Marketing Job</h1>
      <p>Create a job and jump directly to live status and approval flow.</p>

      <form onSubmit={onSubmit}>
        <div>
          <label htmlFor="tenantId">tenantId</label>
          <input
            id="tenantId"
            name="tenantId"
            type="text"
            value={tenantId}
            onChange={(event) => setTenantId(event.target.value)}
            required
          />
        </div>

        <div>
          <label htmlFor="jobType">jobType</label>
          <select
            id="jobType"
            name="jobType"
            value={jobType}
            onChange={(event) => setJobType(event.target.value as MarketingJobType)}
          >
            {jobTypeOptions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="payload">payload (JSON object, optional)</label>
          <textarea
            id="payload"
            name="payload"
            rows={8}
            value={payloadText}
            onChange={(event) => setPayloadText(event.target.value)}
            spellCheck={false}
          />
        </div>

        <button type="submit" disabled={submitting}>
          {submitting ? 'Submitting…' : 'Create job'}
        </button>
      </form>

      {errorText ? <p role="alert">{errorText}</p> : null}

      {success ? (
        <div>
          <p>
            Job accepted: <strong>{success.jobId}</strong> <StatusBadge status="accepted" />
          </p>
          <ul>
            <li>
              <a href={`./job-status?jobId=${encodeURIComponent(success.jobId)}`}>Open job status</a>
            </li>
            <li>
              <a href={`./job-approve?jobId=${encodeURIComponent(success.jobId)}&tenantId=${encodeURIComponent(success.tenantId)}`}>
                Open approval screen
              </a>
            </li>
          </ul>
        </div>
      ) : null}

      {result ? (
        <div>
          <h2>Response</h2>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </div>
      ) : null}
    </section>
  );
}

export default MarketingNewJobScreen;
