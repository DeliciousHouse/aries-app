"use client";

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import type {
  ApproveJobResult,
  MarketingArtifactCard,
  MarketingStageCard,
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

function StageCard({ stage }: { stage: MarketingStageCard }) {
  return (
    <div className="rd-glass" style={{ padding: '1rem', borderRadius: '1rem', display: 'grid', gap: '0.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <strong>{stage.label}</strong>
        <StatusBadge status={stage.status as any} />
      </div>
      <p className="rd-section-description" style={{ margin: 0 }}>{stage.summary}</p>
      {stage.highlight ? <span style={{ color: 'var(--rd-text-secondary)' }}>{stage.highlight}</span> : null}
    </div>
  );
}

function ArtifactPreview({ artifact }: { artifact: MarketingArtifactCard }) {
  return (
    <div className="rd-glass" style={{ padding: '1rem', borderRadius: '1rem', display: 'grid', gap: '0.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <strong>{artifact.title}</strong>
        <StatusBadge status={artifact.status as any} />
      </div>
      <p className="rd-section-description" style={{ margin: 0 }}>{artifact.summary}</p>
      {artifact.details.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: '1.1rem', color: 'var(--rd-text-secondary)' }}>
          {artifact.details.slice(0, 3).map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
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
  const marketingStatus = useMarketingJobStatus({
    baseUrl: props.baseUrl,
    jobId: props.defaultJobId,
    autoLoad: false,
  });

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

  useEffect(() => {
    if (!props.defaultJobId?.trim()) {
      return;
    }

    void handleLoadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.defaultJobId]);

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
    if (approveResult.reason === 'approval_not_available') {
      return {
        tone: 'danger',
        text: 'This campaign is not holding an active launch approval token, so there is nothing real to resume yet.',
      };
    }
    return approveResult.approval_status === 'resumed'
      ? { tone: 'success', text: 'Approval succeeded and resume was accepted.' }
      : { tone: 'danger', text: `Approval failed: ${approveResult.approval_status}` };
  })();

  const statusSuccess = jobStatus && !isErrorResult(jobStatus) ? jobStatus : null;
  const approveSuccess = approveResult && !isErrorResult(approveResult) ? approveResult : null;

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
              <p className="rd-section-description">Load a campaign to review its launch state before approving.</p>
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
              <div style={{ display: 'grid', gap: '1rem' }}>
                <div className="rd-summary-list">
                  <div className="rd-summary-row"><strong>Headline</strong><span>{statusSuccess.summary.headline}</span></div>
                  <div className="rd-summary-row">
                    <strong>Status</strong>
                    <StatusBadge status={statusSuccess.marketing_job_status as any} />
                  </div>
                  <div className="rd-summary-row"><strong>Current stage</strong><span>{statusSuccess.marketing_stage ?? 'none'}</span></div>
                  <div className="rd-summary-row"><strong>Next step</strong><span>{statusSuccess.nextStep}</span></div>
                </div>

                {statusSuccess.approval ? (
                  <div className="rd-alert rd-alert--info">
                    <strong style={{ display: 'block', marginBottom: '0.4rem' }}>{statusSuccess.approval.title}</strong>
                    <span>{statusSuccess.approval.message}</span>
                  </div>
                ) : null}

                <div>
                  <p className="rd-label" style={{ marginBottom: '0.75rem' }}>Stage progress</p>
                  <div className="rd-card-grid rd-card-grid--4">
                    {statusSuccess.stageCards.map((stage) => (
                      <StageCard key={stage.stage} stage={stage} />
                    ))}
                  </div>
                </div>

                {statusSuccess.artifacts.length > 0 ? (
                  <div>
                    <p className="rd-label" style={{ marginBottom: '0.75rem' }}>Key artifacts</p>
                    <div style={{ display: 'grid', gap: '0.75rem' }}>
                      {statusSuccess.artifacts.slice(0, 3).map((artifact) => (
                        <ArtifactPreview key={artifact.id} artifact={artifact} />
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
        </div>
      </Card>
    </div>
  );
}

export default MarketingJobApproveScreen;
