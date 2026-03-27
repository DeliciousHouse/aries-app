"use client";

import Link from 'next/link';
import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { CheckCircle2 } from 'lucide-react';
import type {
  ApproveJobResult,
  MarketingArtifactCard,
  MarketingReviewBundle,
  MarketingReviewPreviewCard,
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
const PLATFORM_VALUES = ['meta-ads', 'instagram', 'x', 'tiktok', 'youtube', 'linkedin', 'reddit'] as const;

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

function ReviewPreviewCard({ preview }: { preview: MarketingReviewPreviewCard }) {
  return (
    <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 grid gap-3">
      <div>
        <p className="text-xs uppercase tracking-[0.22em] text-white/35 mb-2">{preview.channelType}</p>
        <strong>{preview.platformName}</strong>
      </div>
      <p className="text-white/60 m-0">{preview.summary}</p>
      {preview.hook ? (
        <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-4 text-cyan-100">
          <strong className="block mb-1">Hook</strong>
          <span>{preview.hook}</span>
        </div>
      ) : null}
      <div className="grid gap-2 text-sm text-white/70">
        {preview.headline ? <span><strong className="text-white">Headline:</strong> {preview.headline}</span> : null}
        {preview.cta ? <span><strong className="text-white">CTA:</strong> {preview.cta}</span> : null}
      </div>
      {preview.caption ? (
        <div className="rounded-[1.25rem] border border-white/10 bg-black/30 p-4 whitespace-pre-wrap text-sm text-white/75">
          {preview.caption}
        </div>
      ) : null}
      {preview.details.length > 0 ? (
        <ul className="m-0 pl-5 text-white/60">
          {preview.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
      {preview.mediaAssets.length > 0 ? (
        <div className="grid gap-3">
          <div className="grid sm:grid-cols-2 gap-3">
            {preview.mediaAssets.map((asset) => (
              <a
                key={asset.id}
                href={asset.url}
                target="_blank"
                rel="noreferrer"
                className="rounded-[1.25rem] overflow-hidden border border-white/10 bg-black/30"
              >
                {asset.contentType.startsWith('image/') ? (
                  <img src={asset.url} alt={asset.label} className="w-full h-44 object-cover" />
                ) : (
                  <div className="p-4 text-sm text-white/70">{asset.label}</div>
                )}
              </a>
            ))}
          </div>
          {preview.assetLinks.length > 0 ? (
            <div className="flex flex-wrap gap-3">
              {preview.assetLinks.map((asset) => (
                <a
                  key={asset.id}
                  href={asset.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-primary hover:text-primary/80 transition-colors"
                >
                  {asset.label}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ReviewBundlePreview({ reviewBundle }: { reviewBundle: MarketingReviewBundle }) {
  return (
    <div className="grid gap-5">
      <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-5 text-cyan-100">
        <strong className="block mb-2">{reviewBundle.title}</strong>
        <span>{reviewBundle.approvalMessage}</span>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {reviewBundle.landingPage ? (
          <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 grid gap-3">
            <strong>Landing page preview</strong>
            <div className="grid gap-2 text-white/70">
              <span><strong className="text-white">Headline:</strong> {reviewBundle.landingPage.headline || 'n/a'}</span>
              <span><strong className="text-white">Subheadline:</strong> {reviewBundle.landingPage.subheadline || 'n/a'}</span>
              <span><strong className="text-white">CTA:</strong> {reviewBundle.landingPage.cta || 'n/a'}</span>
              {reviewBundle.landingPage.slug ? <span><strong className="text-white">Slug:</strong> {reviewBundle.landingPage.slug}</span> : null}
              {reviewBundle.landingPage.asset ? (
                <a href={reviewBundle.landingPage.asset.url} target="_blank" rel="noreferrer" className="text-primary hover:text-primary/80 transition-colors">
                  Open landing page artifact
                </a>
              ) : null}
            </div>
            {reviewBundle.landingPage.sections.length > 0 ? (
              <ul className="m-0 pl-5 text-white/60">
                {reviewBundle.landingPage.sections.map((section) => (
                  <li key={section}>{section}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {reviewBundle.scriptPreview ? (
          <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 grid gap-3">
            <strong>Copy and script preview</strong>
            {reviewBundle.scriptPreview.metaAdHook ? <span className="text-white/70"><strong className="text-white">Meta hook:</strong> {reviewBundle.scriptPreview.metaAdHook}</span> : null}
            {reviewBundle.scriptPreview.shortVideoOpeningLine ? (
              <span className="text-white/70"><strong className="text-white">Video opening line:</strong> {reviewBundle.scriptPreview.shortVideoOpeningLine}</span>
            ) : null}
            {reviewBundle.scriptPreview.metaAdBody.length > 0 ? (
              <ul className="m-0 pl-5 text-white/60">
                {reviewBundle.scriptPreview.metaAdBody.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
            {reviewBundle.scriptPreview.shortVideoBeats.length > 0 ? (
              <ul className="m-0 pl-5 text-white/60">
                {reviewBundle.scriptPreview.shortVideoBeats.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      {reviewBundle.reviewPacketAssets.length > 0 ? (
        <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5">
          <strong className="block mb-3">Review packet and contract indexes</strong>
          <div className="flex flex-wrap gap-3">
            {reviewBundle.reviewPacketAssets.map((asset) => (
              <a
                key={asset.id}
                href={asset.url}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-primary hover:text-primary/80 transition-colors"
              >
                {asset.label}
              </a>
            ))}
          </div>
        </div>
      ) : null}

      <div>
        <p className="text-xs uppercase tracking-[0.22em] text-white/35 mb-3">Platform drafts to review before approval</p>
        {reviewBundle.platformPreviews.length === 0 ? (
          <p className="text-white/60">No platform-specific previews are available yet.</p>
        ) : (
          <div className="grid xl:grid-cols-2 gap-4">
            {reviewBundle.platformPreviews.map((preview) => (
              <ReviewPreviewCard key={preview.id} preview={preview} />
            ))}
          </div>
        )}
      </div>
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
  const [approvedBy, setApprovedBy] = useState(props.defaultApprovedBy ?? 'operator');
  const [resumePublishIfNeeded, setResumePublishIfNeeded] = useState(true);
  const [approvedStages, setApprovedStages] = useState<MarketingStage[]>([]);
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [livePublishPlatforms, setLivePublishPlatforms] = useState<string[]>([]);
  const [videoRenderPlatforms, setVideoRenderPlatforms] = useState<string[]>([]);

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
      if (result && !isErrorResult(result) && result.marketing_stage) {
        setApprovedStages([result.marketing_stage as MarketingStage]);
        setPlatforms(result.publishConfig.platforms);
        setLivePublishPlatforms(result.publishConfig.livePublishPlatforms);
        setVideoRenderPlatforms(result.publishConfig.videoRenderPlatforms);
      }
    } finally {
      setLoadingStatus(false);
    }
  }

  function toggleValue(value: string, setter: Dispatch<SetStateAction<string[]>>) {
    setter((prev) =>
      prev.includes(value) ? prev.filter((entry) => entry !== value) : [...prev, value]
    );
  }

  async function handleApprove() {
    if (!canSubmit) return;

    const body: PostMarketingJobApproveRequest = {
      approvedBy: approvedBy.trim(),
      approvedStages: approvedStages.length > 0 ? approvedStages : undefined,
      approvalId: !isErrorResult(jobStatus) ? jobStatus?.approval?.approvalId : undefined,
      resumePublishIfNeeded,
      publishConfig: {
        platforms,
        livePublishPlatforms,
        videoRenderPlatforms,
      },
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
    if (approveResult.approval_status === 'resumed') {
      return { tone: 'success', text: 'Approval succeeded and resume was accepted.' };
    }
    if (approveResult.approval_status === 'already_resolved') {
      return { tone: 'success', text: 'This approval was already resolved, so nothing new was consumed.' };
    }
    return { tone: 'danger', text: `Approval failed: ${approveResult.approval_status}` };
  })();

  const statusSuccess = jobStatus && !isErrorResult(jobStatus) ? jobStatus : null;
  const approveSuccess = approveResult && !isErrorResult(approveResult) ? approveResult : null;
  const pendingStage = statusSuccess?.approval ? statusSuccess.marketing_stage : null;
  const loadOrActionFailed = !!(
    marketingStatus.error ||
    marketingApprove.error ||
    (jobStatus && isErrorResult(jobStatus))
  );
  const showIdleHint =
    !loadingStatus &&
    !loadOrActionFailed &&
    !statusSuccess &&
    !approveResult &&
    !approvalMessage;

  function approvalCheckpointLabel(): string {
    if (loadingStatus) {
      return 'Loading…';
    }
    if (marketingStatus.error) {
      return `Status unavailable: ${marketingStatus.error.message}`;
    }
    return pendingStage ?? 'Load a job to see the active checkpoint.';
  }

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
              <span className="text-xs uppercase tracking-[0.22em] text-white/35">Current approval checkpoint</span>
              <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white/75">
                {approvalCheckpointLabel()}
              </div>
            </div>

            {pendingStage === 'publish' ? (
              <>
                <div className="grid gap-2">
                  <span className="text-xs uppercase tracking-[0.22em] text-white/35">Platforms to package</span>
                  <div className="flex flex-wrap gap-3">
                    {PLATFORM_VALUES.map((platform) => {
                      const active = platforms.includes(platform);
                      return (
                        <button
                          key={platform}
                          type="button"
                          onClick={() => toggleValue(platform, setPlatforms)}
                          className={`px-4 py-2 rounded-full border transition-all ${
                            active ? 'border-primary/30 bg-primary/15 text-white' : 'border-white/10 bg-white/5 text-white/60'
                          }`}
                        >
                          {platform}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="grid gap-2">
                  <span className="text-xs uppercase tracking-[0.22em] text-white/35">Live draft publish</span>
                  <div className="flex flex-wrap gap-3">
                    {PLATFORM_VALUES.filter((platform) => !['tiktok', 'youtube'].includes(platform)).map((platform) => {
                      const active = livePublishPlatforms.includes(platform);
                      return (
                        <button
                          key={platform}
                          type="button"
                          onClick={() => toggleValue(platform, setLivePublishPlatforms)}
                          className={`px-4 py-2 rounded-full border transition-all ${
                            active ? 'border-primary/30 bg-primary/15 text-white' : 'border-white/10 bg-white/5 text-white/60'
                          }`}
                        >
                          {platform}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="grid gap-2">
                  <span className="text-xs uppercase tracking-[0.22em] text-white/35">Video render execution</span>
                  <div className="flex flex-wrap gap-3">
                    {['tiktok', 'youtube'].map((platform) => {
                      const active = videoRenderPlatforms.includes(platform);
                      return (
                        <button
                          key={platform}
                          type="button"
                          onClick={() => toggleValue(platform, setVideoRenderPlatforms)}
                          className={`px-4 py-2 rounded-full border transition-all ${
                            active ? 'border-primary/30 bg-primary/15 text-white' : 'border-white/10 bg-white/5 text-white/60'
                          }`}
                        >
                          {platform}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : null}

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

            {marketingStatus.error || marketingApprove.error || (jobStatus && isErrorResult(jobStatus)) ? (
              <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-red-100">
                {marketingApprove.error?.message ||
                  marketingStatus.error?.message ||
                  (jobStatus && isErrorResult(jobStatus) ? jobStatus.error : '')}
              </div>
            ) : null}
        </div>
      </div>

      <div className="glass rounded-[2.5rem] p-8">
        <div className="grid gap-5">
          <p className="text-xs uppercase tracking-[0.24em] text-white/35">Outcome</p>

            {loadingStatus ? (
              <p className="text-white/60">Loading campaign status…</p>
            ) : null}

            {loadOrActionFailed ? (
              <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-5 text-red-100">
                <strong className="block mb-1">
                  {jobStatus && isErrorResult(jobStatus) ? 'Could not load campaign' : 'Request failed'}
                </strong>
                <span>
                  {marketingApprove.error?.message ||
                    marketingStatus.error?.message ||
                    (jobStatus && isErrorResult(jobStatus) ? jobStatus.error : '')}
                </span>
              </div>
            ) : null}

            {approvalMessage ? (
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
            ) : null}

            {showIdleHint ? (
              <p className="text-white/60">Load a campaign to review its launch state before approving.</p>
            ) : null}

            {statusSuccess ? (
              <div className="grid gap-5">
                <div className="space-y-3">
                  
                  <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-5 py-4 flex items-center justify-between gap-4">
                    <strong>Status</strong>
                    <StatusBadge status={statusSuccess.marketing_job_status as any} />
                  </div>
                  <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-5 py-4 flex items-center justify-between gap-4"><strong>Current stage</strong><span>{statusSuccess.marketing_stage ?? 'none'}</span></div>
                  
                </div>

                <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-5 py-4 text-white/70">
                  <strong className="block text-white mb-2">Publish configuration</strong>
                  <div className="grid gap-1 text-sm">
                    <span>Platforms: {statusSuccess.publishConfig.platforms.join(', ') || 'none selected'}</span>
                    <span>Live draft publish: {statusSuccess.publishConfig.livePublishPlatforms.join(', ') || 'not requested'}</span>
                    <span>Video render: {statusSuccess.publishConfig.videoRenderPlatforms.join(', ') || 'not requested'}</span>
                  </div>
                </div>

                {statusSuccess.approval ? (
                  <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-4 text-cyan-100">
                    <strong className="block mb-2">{statusSuccess.approval.title}</strong>
                    <span>{statusSuccess.approval.message}</span>
                  </div>
                ) : null}

                {statusSuccess.reviewBundle ? (
                  <div className="border-t border-white/5 pt-5 mt-5">
                    <ReviewBundlePreview reviewBundle={statusSuccess.reviewBundle} />
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
