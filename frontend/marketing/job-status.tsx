import { useMemo, useState } from 'react';

import { createMarketingClient } from '../api/client/marketing';
import type {
  GetMarketingJobStatusResponse,
  HardFailureError,
  UnhandledError
} from '../api/contracts/marketing';

type JobStatusResult = GetMarketingJobStatusResponse | HardFailureError | UnhandledError;

type OptionalContractExtras = {
  repair_status?: unknown;
  next_step?: unknown;
  latest_artifacts?: unknown;
  latest_messages?: unknown;
};

export interface MarketingJobStatusScreenProps {
  baseUrl?: string;
  defaultJobId?: string;
}

function isErrorResult(value: JobStatusResult | null): value is HardFailureError | UnhandledError {
  return !!value && typeof value === 'object' && 'error' in value;
}

function asOptionalExtras(value: GetMarketingJobStatusResponse): OptionalContractExtras {
  return value as GetMarketingJobStatusResponse & OptionalContractExtras;
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
  const contractExtras = successResult ? asOptionalExtras(successResult) : null;

  const stageStatus =
    successResult && successResult.marketing_stage
      ? successResult.marketing_stage_status?.[successResult.marketing_stage]
      : undefined;

  const approvalPending =
    !!successResult &&
    (successResult.marketing_job_status === 'awaiting_approval' || stageStatus === 'awaiting_approval');

  return (
    <section>
      <h2>Marketing Job Status</h2>

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
            <dd>{successResult.marketing_job_status}</dd>

            <dt>approval_pending</dt>
            <dd>{approvalPending ? 'true' : 'false'}</dd>

            {typeof contractExtras?.repair_status === 'string' ? (
              <>
                <dt>repair_status</dt>
                <dd>{contractExtras.repair_status}</dd>
              </>
            ) : null}

            {typeof contractExtras?.next_step === 'string' ? (
              <>
                <dt>next_step</dt>
                <dd>{contractExtras.next_step}</dd>
              </>
            ) : null}
          </dl>

          {contractExtras && contractExtras.latest_artifacts !== undefined ? (
            <>
              <h4>latest_artifacts</h4>
              <pre>{JSON.stringify(contractExtras.latest_artifacts, null, 2)}</pre>
            </>
          ) : null}

          {contractExtras && contractExtras.latest_messages !== undefined ? (
            <>
              <h4>latest_messages</h4>
              <pre>{JSON.stringify(contractExtras.latest_messages, null, 2)}</pre>
            </>
          ) : null}

          <h4>Raw response</h4>
          <pre>{JSON.stringify(successResult, null, 2)}</pre>
        </div>
      ) : null}
    </section>
  );
}

export default MarketingJobStatusScreen;
