"use client";

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, Sparkles } from 'lucide-react';
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
    <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 grid gap-2">
      <div className="flex justify-between gap-4 flex-wrap">
        <strong>{stage.label}</strong>
        <StatusBadge status={stage.status as any} />
      </div>
      <p className="text-white/60 m-0">{stage.summary}</p>
      {stage.highlight ? <span className="text-white/50">{stage.highlight}</span> : null}
    </div>
  );
}

function ArtifactPreview({ artifact }: { artifact: MarketingArtifactCard }) {
  return (
    <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 grid gap-2">
      <div className="flex justify-between gap-4 flex-wrap">
        <strong>{artifact.title}</strong>
        <StatusBadge status={artifact.status as any} />
      </div>
      <p className="text-white/60 m-0">{artifact.summary}</p>
      {artifact.details.length > 0 ? (
        <ul className="m-0 pl-5 text-white/60">
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
    <label className="block space-y-2">
      <span className="text-xs uppercase tracking-[0.22em] text-white/35">{label}</span>
      {children}
      {hint ? <span className="text-sm text-white/50">{hint}</span> : null}
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
    <div className="min-h-screen bg-background px-6 py-10 md:px-8 lg:px-10">
      <div className="max-w-7xl mx-auto grid gap-6">
        <div className="glass rounded-[2.5rem] p-8 md:p-10">
          <p className="text-xs uppercase tracking-[0.3em] text-primary mb-3">Aries workflow</p>
          <h1 className="text-4xl font-bold mb-3">Campaign approval</h1>
          <p className="text-white/60">Approve or resume paused launch stages through the Aries internal approval route.</p>
        </div>

        <div className="grid xl:grid-cols-2 gap-6">
      <div className="glass rounded-[2.5rem] p-8">
        <div className="grid gap-5">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-white/35 mb-3">Approval control</p>
            <h1 className="text-3xl font-bold mb-3">Resume a paused marketing workflow</h1>
            <p className="text-white/60">
              Submit approval decisions through the internal Aries route and refresh live status without exposing workflow runner details.
            </p>
          </div>

            <Field label="Job ID" hint="Required route key for /api/marketing/jobs/:jobId/approve">
              <input
                value={jobId}
                onChange={(event) => setJobId(event.target.value)}
                placeholder="mkt_..."
                className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
              />
            </Field>

            <Field label="Approved By">
              <input
                value={approvedBy}
                onChange={(event) => setApprovedBy(event.target.value)}
                placeholder="operator"
                className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
              />
            </Field>

            <div className="grid gap-2">
              <span className="text-xs uppercase tracking-[0.22em] text-white/35">Approved stages</span>
              <div className="flex flex-wrap gap-3">
                {APPROVAL_STAGE_VALUES.map((stage) => {
                  const active = approvedStages.includes(stage);
                  return (
                    <button
                      key={stage}
                      type="button"
                      onClick={() => toggleStage(stage)}
                      className={`px-4 py-2 rounded-full border transition-all ${
                        active ? 'border-primary/30 bg-primary/15 text-white' : 'border-white/10 bg-white/5 text-white/60'
                      }`}
                    >
                      {stage}
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="flex items-center gap-2 text-white/60">
              <input
                type="checkbox"
                checked={resumePublishIfNeeded}
                onChange={(event) => setResumePublishIfNeeded(event.target.checked)}
              />
              Resume publish if needed
            </label>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={handleLoadStatus}
                disabled={loadingStatus || !jobId.trim()}
                className="px-6 py-3 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all disabled:opacity-60"
              >
                {loadingStatus ? 'Loading…' : 'Load current status'}
              </button>
              <button
                type="button"
                onClick={handleApprove}
                disabled={!canSubmit}
                className="px-6 py-3 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold shadow-xl shadow-primary/20 disabled:opacity-60"
              >
                {submitting ? 'Approving…' : 'Approve and Resume'}
              </button>
            </div>

            {marketingStatus.error || marketingApprove.error ? (
              <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-red-100">
                {marketingApprove.error?.message || marketingStatus.error?.message}
              </div>
            ) : null}
        </div>
      </div>

      <div className="glass rounded-[2.5rem] p-8">
        <div className="grid gap-5">
          <p className="text-xs uppercase tracking-[0.24em] text-white/35">Outcome</p>

            {!approvalMessage ? (
              <p className="text-white/60">Load a campaign to review its launch state before approving.</p>
            ) : (
              <div
                className={approvalMessage.tone === 'success'
                  ? 'rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-5 text-emerald-100'
                  : 'rounded-2xl border border-red-500/20 bg-red-500/10 p-5 text-red-100'}
              >
                <div className="grid gap-3">
                  <span>{approvalMessage.text}</span>
                  {approveSuccess?.jobStatusUrl ? (
                    <Link href={approveSuccess.jobStatusUrl} className="px-5 py-3 rounded-full bg-white/10 border border-white/10 text-white font-semibold inline-flex items-center gap-2 w-fit">
                      Review updated status
                      <CheckCircle2 className="w-4 h-4" />
                    </Link>
                  ) : null}
                </div>
              </div>
            )}

            {statusSuccess ? (
              <div className="grid gap-5">
                <div className="space-y-3">
                  <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-5 py-4 flex items-center justify-between gap-4"><strong>Headline</strong><span>{statusSuccess.summary.headline}</span></div>
                  <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-5 py-4 flex items-center justify-between gap-4">
                    <strong>Status</strong>
                    <StatusBadge status={statusSuccess.marketing_job_status as any} />
                  </div>
                  <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-5 py-4 flex items-center justify-between gap-4"><strong>Current stage</strong><span>{statusSuccess.marketing_stage ?? 'none'}</span></div>
                  <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-5 py-4 flex items-center justify-between gap-4"><strong>Next step</strong><span>{statusSuccess.nextStep}</span></div>
                </div>

                {statusSuccess.approval ? (
                  <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-4 text-cyan-100">
                    <strong className="block mb-2">{statusSuccess.approval.title}</strong>
                    <span>{statusSuccess.approval.message}</span>
                  </div>
                ) : null}

                <div>
                  <p className="text-xs uppercase tracking-[0.22em] text-white/35 mb-3">Stage progress</p>
                  <div className="grid md:grid-cols-2 gap-4">
                    {statusSuccess.stageCards.map((stage) => (
                      <StageCard key={stage.stage} stage={stage} />
                    ))}
                  </div>
                </div>

                {statusSuccess.artifacts.length > 0 ? (
                  <div>
                    <p className="text-xs uppercase tracking-[0.22em] text-white/35 mb-3">Key artifacts</p>
                    <div className="grid gap-3">
                      {statusSuccess.artifacts.slice(0, 3).map((artifact) => (
                        <ArtifactPreview key={artifact.id} artifact={artifact} />
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
        </div>
      </div>
        </div>
      </div>
    </div>
  );
}

export default MarketingJobApproveScreen;
