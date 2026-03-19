"use client";

import Link from 'next/link';
import { useEffect, useState } from 'react';

import type {
  MarketingArtifactCard,
  MarketingApprovalSummary,
  GetMarketingJobStatusResponse,
  MarketingApiError,
  MarketingStageCard,
  MarketingTimelineEntry,
} from '@/lib/api/marketing';
import { useMarketingJobStatus } from '@/hooks/use-marketing-job-status';
import { Button } from '@/components/redesign/primitives/button';
import { Card } from '@/components/redesign/primitives/card';
import { TextInput } from '@/components/redesign/primitives/input';
import StatusBadge from '../components/status-badge';

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

function isActiveStatus(status: string): boolean {
  return ['accepted', 'running', 'in_progress', 'ready', 'awaiting_approval', 'resumed'].includes(status);
}

function nextStepGuidance(nextStep: string): string | null {
  switch (nextStep) {
    case 'submit_approval':
      return 'Review the launch package and approve the publish stage when the campaign is ready to continue.';
    case 'invoke_marketing_repair':
      return 'A failure or blocked state was recorded. Review the latest artifacts before retrying the run.';
    case 'wait_for_completion':
      return 'Aries is still collecting the latest pipeline signals. Keep this page open or refresh manually.';
    default:
      return null;
  }
}

function ArtifactCard({ artifact }: { artifact: MarketingArtifactCard }) {
  return (
    <div className="rd-glass" style={{ padding: '1rem', borderRadius: '1rem', display: 'grid', gap: '0.75rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <p className="rd-label" style={{ marginBottom: '0.35rem' }}>{artifact.category}</p>
          <strong>{artifact.title}</strong>
        </div>
        <StatusBadge status={artifact.status as any} />
      </div>
      <p className="rd-section-description" style={{ margin: 0 }}>{artifact.summary}</p>
      {artifact.details.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: '1.1rem', color: 'var(--rd-text-secondary)' }}>
          {artifact.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
      {artifact.preview ? (
        <div className="rd-json-panel" style={{ whiteSpace: 'pre-wrap' }}>{artifact.preview}</div>
      ) : null}
      {artifact.actionHref && artifact.actionLabel ? (
        <div className="rd-inline-actions">
          <Link href={artifact.actionHref} className="rd-button rd-button--secondary">
            {artifact.actionLabel}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function StageCard({ stage }: { stage: MarketingStageCard }) {
  return (
    <div className="rd-glass" style={{ padding: '1rem', borderRadius: '1rem', display: 'grid', gap: '0.75rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <strong>{stage.label}</strong>
        <StatusBadge status={stage.status as any} />
      </div>
      <p className="rd-section-description" style={{ margin: 0 }}>{stage.summary}</p>
      {stage.highlight ? (
        <div className="rd-alert rd-alert--info" style={{ margin: 0 }}>
          {stage.highlight}
        </div>
      ) : null}
    </div>
  );
}

function TimelineCard({ event }: { event: MarketingTimelineEntry }) {
  const alertClass =
    event.tone === 'success'
      ? 'rd-alert rd-alert--success'
      : event.tone === 'warning'
        ? 'rd-alert rd-alert--info'
        : event.tone === 'danger'
          ? 'rd-alert rd-alert--danger'
          : 'rd-alert rd-alert--info';

  return (
    <div className={alertClass} style={{ margin: 0 }}>
      <div style={{ display: 'grid', gap: '0.35rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
          <strong>{event.label}</strong>
          {event.at ? <span>{new Date(event.at).toLocaleString()}</span> : null}
        </div>
        <span>{event.description}</span>
      </div>
    </div>
  );
}

function ApprovalBanner({ approval }: { approval: MarketingApprovalSummary }) {
  return (
    <div className="rd-alert rd-alert--info">
      <div style={{ display: 'grid', gap: '0.75rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
          <strong>{approval.title}</strong>
          <StatusBadge status="awaiting_approval" />
        </div>
        <span>{approval.message}</span>
        {approval.actionHref && approval.actionLabel ? (
          <div className="rd-inline-actions">
            <Link href={approval.actionHref} className="rd-button rd-button--secondary">
              {approval.actionLabel}
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function MarketingJobStatusScreen(props: MarketingJobStatusScreenProps) {
  const marketingStatus = useMarketingJobStatus({
    baseUrl: props.baseUrl,
    jobId: props.defaultJobId,
    autoLoad: false,
  });

  const [jobId, setJobId] = useState(normalizeMarketingJobId(props.defaultJobId));
  const [loading, setLoading] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [result, setResult] = useState<JobStatusResult | null>(null);

  async function loadStatus(rawJobId: string, quiet = false) {
    const trimmedJobId = normalizeMarketingJobId(rawJobId);
    if (!trimmedJobId) {
      marketingStatus.setError(new Error('jobId is required'));
      return;
    }

    if (!quiet) {
      setLoading(true);
    }
    try {
      if (!quiet) {
        marketingStatus.reset();
      }
      const response = await marketingStatus.load(trimmedJobId, { quiet });
      setResult(response);
      if (response && !isErrorResult(response)) {
        setLastRefreshedAt(new Date().toISOString());
      }
    } finally {
      if (!quiet) {
        setLoading(false);
      }
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

  useEffect(() => {
    if (!successResult || !jobId.trim() || !isActiveStatus(successResult.marketing_job_status)) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadStatus(jobId, true);
    }, 5000);

    return () => window.clearInterval(timer);
  }, [jobId, successResult]);

  return (
    <div style={{ display: 'grid', gap: '1.5rem' }}>
      <div className="rd-workflow-grid rd-workflow-grid--2">
        <Card>
          <div style={{ display: 'grid', gap: '1rem' }}>
            <div>
              <p className="rd-section-label">Campaign status</p>
              <h1 style={{ margin: '0.8rem 0 0.5rem', fontFamily: 'var(--rd-font-display)', fontSize: '2rem' }}>
                Operational campaign workspace
              </h1>
              <p className="rd-section-description">
                Monitor the brand campaign, refresh real stage progress, and jump to launch approval when needed.
              </p>
            </div>

            <label className="rd-field">
              <span className="rd-label">Job ID</span>
              <TextInput value={jobId} onChange={(event) => setJobId(event.target.value)} placeholder="mkt_..." />
            </label>

            <div className="rd-inline-actions">
              <Button type="button" onClick={handleLoadStatus} disabled={loading || !jobId.trim()}>
                {loading ? 'Refreshing…' : 'Refresh status'}
              </Button>
              {successResult?.approval?.required ? (
                <Link href={`/marketing/job-approve?jobId=${encodeURIComponent(successResult.jobId)}`} className="rd-button rd-button--secondary">
                  Review approval
                </Link>
              ) : null}
            </div>

            {lastRefreshedAt ? (
              <p className="rd-section-description" style={{ margin: 0 }}>
                Last synced {new Date(lastRefreshedAt).toLocaleTimeString()}.
                {successResult && isActiveStatus(successResult.marketing_job_status)
                  ? ' Auto-refresh is active while the campaign is still changing.'
                  : ''}
              </p>
            ) : null}

            {marketingStatus.error ? <div className="rd-alert rd-alert--danger">{marketingStatus.error.message}</div> : null}
            {result && isErrorResult(result) ? <div className="rd-alert rd-alert--danger">{result.error}</div> : null}
          </div>
        </Card>

        <Card>
          {!successResult ? (
            <div className="rd-empty" style={{ minHeight: '280px' }}>
              <strong>No campaign loaded</strong>
              <p>Enter a job ID to open the operational status view for a brand campaign.</p>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: '1rem' }}>
              <p className="rd-section-label">Current state</p>
              <h2 style={{ margin: 0, fontFamily: 'var(--rd-font-display)', fontSize: '1.8rem' }}>
                {successResult.summary.headline}
              </h2>
              <p className="rd-section-description" style={{ margin: 0 }}>
                {successResult.summary.subheadline}
              </p>
              <div className="rd-summary-list">
                <div className="rd-summary-row"><strong>Job ID</strong><code>{successResult.jobId}</code></div>
                <div className="rd-summary-row">
                  <strong>Status</strong>
                  <StatusBadge status={successResult.marketing_job_status as any} />
                </div>
                <div className="rd-summary-row"><strong>Current stage</strong><span>{successResult.marketing_stage ?? 'none'}</span></div>
                <div className="rd-summary-row"><strong>Next action</strong><span>{successResult.nextStep}</span></div>
                <div className="rd-summary-row"><strong>Repair status</strong><span>{successResult.repairStatus}</span></div>
              </div>
              {nextStepGuidance(successResult.nextStep) ? (
                <div className="rd-alert rd-alert--info">{nextStepGuidance(successResult.nextStep)}</div>
              ) : null}
              {successResult.approval ? <ApprovalBanner approval={successResult.approval} /> : null}
              {successResult.needs_attention && !successResult.approval ? (
                <div className="rd-alert rd-alert--danger">
                  This workflow needs operator attention before it can continue.
                </div>
              ) : null}
            </div>
          )}
        </Card>
      </div>

      {successResult ? (
        <>
          <Card>
            <div style={{ display: 'grid', gap: '1rem' }}>
              <div>
                <p className="rd-section-label">Stage progress</p>
                <h2 style={{ margin: '0.5rem 0 0', fontFamily: 'var(--rd-font-display)', fontSize: '1.5rem' }}>
                  Real pipeline stages
                </h2>
              </div>
              <div className="rd-card-grid rd-card-grid--4">
                {successResult.stageCards.map((stage) => (
                  <StageCard key={stage.stage} stage={stage} />
                ))}
              </div>
            </div>
          </Card>

          <div className="rd-workflow-grid rd-workflow-grid--2">
            <Card>
              <div style={{ display: 'grid', gap: '1rem' }}>
                <div>
                  <p className="rd-section-label">Outputs and artifacts</p>
                  <h2 style={{ margin: '0.5rem 0 0', fontFamily: 'var(--rd-font-display)', fontSize: '1.5rem' }}>
                    Product-safe campaign deliverables
                  </h2>
                </div>
                {successResult.artifacts.length === 0 ? (
                  <p className="rd-section-description">No artifact summaries are available yet.</p>
                ) : (
                  <div style={{ display: 'grid', gap: '1rem' }}>
                    {successResult.artifacts.map((artifact) => (
                      <ArtifactCard key={artifact.id} artifact={artifact} />
                    ))}
                  </div>
                )}
              </div>
            </Card>

            <Card>
              <div style={{ display: 'grid', gap: '1rem' }}>
                <div>
                  <p className="rd-section-label">Timeline</p>
                  <h2 style={{ margin: '0.5rem 0 0', fontFamily: 'var(--rd-font-display)', fontSize: '1.5rem' }}>
                    Campaign events
                  </h2>
                </div>
                {successResult.timeline.length === 0 ? (
                  <p className="rd-section-description">No timeline events are available yet.</p>
                ) : (
                  <div style={{ display: 'grid', gap: '0.75rem' }}>
                    {successResult.timeline.map((event) => (
                      <TimelineCard key={event.id} event={event} />
                    ))}
                  </div>
                )}
              </div>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}

export default MarketingJobStatusScreen;
