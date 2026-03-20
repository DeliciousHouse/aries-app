"use client";

import Link from 'next/link';
import { useEffect, useState } from 'react';

import type {
  MarketingArtifactCard,
  MarketingApprovalSummary,
  GetMarketingJobStatusResponse,
  MarketingApiError,
  MarketingReviewBundle,
  MarketingReviewPreviewCard,
  MarketingStageCard,
  MarketingTimelineEntry,
} from '@/lib/api/marketing';
import { useMarketingJobStatus } from '@/hooks/use-marketing-job-status';
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
      return 'Review the current stage package and approve the checkpoint when the campaign is ready to continue.';
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
    <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 grid gap-3">
      <div className="flex justify-between gap-4 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-white/35 mb-2">{artifact.category}</p>
          <strong>{artifact.title}</strong>
        </div>
        <StatusBadge status={artifact.status as any} />
      </div>
      <p className="text-white/60 m-0">{artifact.summary}</p>
      {artifact.details.length > 0 ? (
        <ul className="m-0 pl-5 text-white/60">
          {artifact.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
      {artifact.preview ? (
        <div className="rounded-[1.25rem] border border-white/10 bg-black/30 p-4 whitespace-pre-wrap font-mono text-sm text-white/75">
          {artifact.preview}
        </div>
      ) : null}
      {artifact.actionHref && artifact.actionLabel ? (
        <div className="flex flex-wrap gap-3">
          <Link href={artifact.actionHref} className="px-5 py-3 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all">
            {artifact.actionLabel}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function StageCard({ stage }: { stage: MarketingStageCard }) {
  return (
    <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 grid gap-3">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <strong>{stage.label}</strong>
        <StatusBadge status={stage.status as any} />
      </div>
      <p className="text-white/60 m-0">{stage.summary}</p>
      {stage.highlight ? (
        <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-4 text-cyan-100">
          {stage.highlight}
        </div>
      ) : null}
    </div>
  );
}

function TimelineCard({ event }: { event: MarketingTimelineEntry }) {
  const alertClass =
    event.tone === 'success'
      ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-100'
      : event.tone === 'warning'
        ? 'border-amber-400/20 bg-amber-400/10 text-amber-100'
        : event.tone === 'danger'
          ? 'border-red-500/20 bg-red-500/10 text-red-100'
          : 'border-cyan-500/20 bg-cyan-500/10 text-cyan-100';

  return (
    <div className={`rounded-2xl border p-4 ${alertClass}`}>
      <div className="grid gap-1.5">
        <div className="flex justify-between gap-4 flex-wrap">
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
    <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-5 text-cyan-100">
      <div className="grid gap-3">
        <div className="flex justify-between gap-4 flex-wrap">
          <strong>{approval.title}</strong>
          <StatusBadge status="awaiting_approval" />
        </div>
        <span>{approval.message}</span>
        {approval.actionHref && approval.actionLabel ? (
          <div className="flex flex-wrap gap-3">
            <Link href={approval.actionHref} className="px-5 py-3 rounded-full bg-white/10 border border-white/10 text-white font-semibold">
              {approval.actionLabel}
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ReviewPreviewCard({ preview }: { preview: MarketingReviewPreviewCard }) {
  return (
    <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 grid gap-3">
      <div className="flex justify-between gap-4 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-white/35 mb-2">{preview.channelType}</p>
          <strong>{preview.platformName}</strong>
        </div>
      </div>
      <p className="text-white/60 m-0">{preview.summary}</p>
      {preview.hook ? (
        <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-4 text-cyan-100">
          <strong className="block mb-1">Hook</strong>
          <span>{preview.hook}</span>
        </div>
      ) : null}
      <div className="grid md:grid-cols-2 gap-3 text-sm text-white/70">
        {preview.headline ? <div><strong className="block text-white mb-1">Headline</strong><span>{preview.headline}</span></div> : null}
        {preview.cta ? <div><strong className="block text-white mb-1">CTA</strong><span>{preview.cta}</span></div> : null}
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
      {preview.mediaPaths.length > 0 ? (
        <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
          <strong className="block text-white mb-2">Media and output paths</strong>
          <ul className="m-0 pl-5 text-white/60 break-all">
            {preview.mediaPaths.map((pathValue) => (
              <li key={pathValue}>{pathValue}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {preview.assetPaths.length > 0 ? (
        <div className="text-sm text-white/50 break-all">
          <strong className="block text-white/70 mb-1">Source artifacts</strong>
          {preview.assetPaths.join('\n')}
        </div>
      ) : null}
    </div>
  );
}

function ReviewBundleSection({ reviewBundle }: { reviewBundle: MarketingReviewBundle }) {
  return (
    <div className="glass rounded-[2.5rem] p-8">
      <div className="grid gap-5">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-white/35">Approval review bundle</p>
          <h2 className="text-3xl font-bold mt-2">{reviewBundle.title}</h2>
          <p className="text-white/60 mt-3">{reviewBundle.summary}</p>
        </div>

        <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-5 text-cyan-100">
          <strong className="block mb-2">{reviewBundle.campaignName || 'Launch review'}</strong>
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
                {reviewBundle.landingPage.path ? <span className="break-all"><strong className="text-white">Path:</strong> {reviewBundle.landingPage.path}</span> : null}
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
              <div className="grid gap-2 text-white/70">
                {reviewBundle.scriptPreview.metaAdHook ? <span><strong className="text-white">Meta hook:</strong> {reviewBundle.scriptPreview.metaAdHook}</span> : null}
                {reviewBundle.scriptPreview.shortVideoOpeningLine ? (
                  <span><strong className="text-white">Video opening line:</strong> {reviewBundle.scriptPreview.shortVideoOpeningLine}</span>
                ) : null}
              </div>
              {reviewBundle.scriptPreview.metaAdBody.length > 0 ? (
                <div>
                  <strong className="block text-white mb-2">Meta body</strong>
                  <ul className="m-0 pl-5 text-white/60">
                    {reviewBundle.scriptPreview.metaAdBody.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {reviewBundle.scriptPreview.shortVideoBeats.length > 0 ? (
                <div>
                  <strong className="block text-white mb-2">Video beats</strong>
                  <ul className="m-0 pl-5 text-white/60">
                    {reviewBundle.scriptPreview.shortVideoBeats.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {reviewBundle.scriptPreview.paths.length > 0 ? (
                <div className="text-sm text-white/50 break-all whitespace-pre-wrap">{reviewBundle.scriptPreview.paths.join('\n')}</div>
              ) : null}
            </div>
          ) : null}
        </div>

        {reviewBundle.reviewPacketPaths.length > 0 ? (
          <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5">
            <strong className="block mb-3">Review packet and index paths</strong>
            <ul className="m-0 pl-5 text-white/60 break-all">
              {reviewBundle.reviewPacketPaths.map((pathValue) => (
                <li key={pathValue}>{pathValue}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-white/35 mb-3">Platform-by-platform drafts</p>
          {reviewBundle.platformPreviews.length === 0 ? (
            <p className="text-white/60">No platform previews are available yet.</p>
          ) : (
            <div className="grid xl:grid-cols-2 gap-4">
              {reviewBundle.platformPreviews.map((preview) => (
                <ReviewPreviewCard key={preview.id} preview={preview} />
              ))}
            </div>
          )}
        </div>
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
    <div className="min-h-screen bg-background px-6 py-10 md:px-8 lg:px-10">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="glass rounded-[2.5rem] p-8 md:p-10">
          <p className="text-xs uppercase tracking-[0.3em] text-primary mb-3">Aries workflow</p>
          <h1 className="text-4xl font-bold mb-3">Campaign status</h1>
          <p className="text-white/60">Live donor-derived campaign workspace wired to the Aries internal status and approval routes.</p>
        </div>

      <div className="grid xl:grid-cols-2 gap-6">
        <div className="glass rounded-[2.5rem] p-8">
          <div className="grid gap-5">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-white/35 mb-3">Campaign status</p>
              <h1 className="text-3xl font-bold mb-3">Operational campaign workspace</h1>
              <p className="text-white/60">
                Monitor the brand campaign, refresh real stage progress, and jump to launch approval when needed.
              </p>
            </div>

            <label className="block space-y-2">
              <span className="text-xs uppercase tracking-[0.22em] text-white/35">Job ID</span>
              <input
                value={jobId}
                onChange={(event) => setJobId(event.target.value)}
                placeholder="mkt_..."
                className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
              />
            </label>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={handleLoadStatus}
                disabled={loading || !jobId.trim()}
                className="px-6 py-3 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold shadow-xl shadow-primary/20 disabled:opacity-60"
              >
                {loading ? 'Refreshing…' : 'Refresh status'}
              </button>
              {successResult?.approval?.required ? (
                <Link href={`/marketing/job-approve?jobId=${encodeURIComponent(successResult.jobId)}`} className="px-6 py-3 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all">
                  Review approval
                </Link>
              ) : null}
            </div>

            {lastRefreshedAt ? (
              <p className="text-white/60">
                Last synced {new Date(lastRefreshedAt).toLocaleTimeString()}.
                {successResult && isActiveStatus(successResult.marketing_job_status)
                  ? ' Auto-refresh is active while the campaign is still changing.'
                  : ''}
              </p>
            ) : null}

            {marketingStatus.error ? <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-red-100">{marketingStatus.error.message}</div> : null}
            {result && isErrorResult(result) ? <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-red-100">{result.error}</div> : null}
          </div>
        </div>

        <div className="glass rounded-[2.5rem] p-8">
          {!successResult ? (
            <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-8 min-h-[280px] flex flex-col items-center justify-center text-center text-white/60">
              <strong className="text-white text-lg mb-2">No campaign loaded</strong>
              <p>Enter a job ID to open the operational status view for a brand campaign.</p>
            </div>
          ) : (
            <div className="grid gap-5">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-white/35 mb-3">Current state</p>
                <h2 className="text-3xl font-bold mb-3">{successResult.summary.headline}</h2>
                <p className="text-white/60">{successResult.summary.subheadline}</p>
              </div>
              <div className="space-y-3">
                <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-5 py-4 flex items-center justify-between gap-4">
                  <strong>Job ID</strong>
                  <code>{successResult.jobId}</code>
                </div>
                <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-5 py-4 flex items-center justify-between gap-4">
                  <strong>Status</strong>
                  <StatusBadge status={successResult.marketing_job_status as any} />
                </div>
                <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-5 py-4 flex items-center justify-between gap-4">
                  <strong>Current stage</strong>
                  <span>{successResult.marketing_stage ?? 'none'}</span>
                </div>
                <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-5 py-4 flex items-center justify-between gap-4">
                  <strong>Next action</strong>
                  <span>{successResult.nextStep}</span>
                </div>
                <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-5 py-4 flex items-center justify-between gap-4">
                  <strong>Repair status</strong>
                  <span>{successResult.repairStatus}</span>
                </div>
              </div>
              {nextStepGuidance(successResult.nextStep) ? (
                <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-4 text-cyan-100">{nextStepGuidance(successResult.nextStep)}</div>
              ) : null}
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-white/70">
                <strong className="block text-white mb-2">Selected publish configuration</strong>
                <div className="grid gap-1 text-sm">
                  <span>Platforms: {successResult.publishConfig.platforms.join(', ') || 'none selected'}</span>
                  <span>Live draft publish: {successResult.publishConfig.livePublishPlatforms.join(', ') || 'not requested'}</span>
                  <span>Video render: {successResult.publishConfig.videoRenderPlatforms.join(', ') || 'not requested'}</span>
                </div>
              </div>
              {successResult.approval ? <ApprovalBanner approval={successResult.approval} /> : null}
              {successResult.needs_attention && !successResult.approval ? (
                <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-red-100">
                  This workflow needs operator attention before it can continue.
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {successResult ? (
        <>
          {successResult.reviewBundle ? <ReviewBundleSection reviewBundle={successResult.reviewBundle} /> : null}

          <div className="glass rounded-[2.5rem] p-8">
            <div className="grid gap-5">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-white/35">Stage progress</p>
                <h2 className="text-3xl font-bold mt-2">Real pipeline stages</h2>
              </div>
              <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
                {successResult.stageCards.map((stage) => (
                  <StageCard key={stage.stage} stage={stage} />
                ))}
              </div>
            </div>
          </div>

          <div className="grid xl:grid-cols-2 gap-6">
            <div className="glass rounded-[2.5rem] p-8">
              <div className="grid gap-5">
                <div>
                  <p className="text-xs uppercase tracking-[0.24em] text-white/35">Outputs and artifacts</p>
                  <h2 className="text-3xl font-bold mt-2">Product-safe campaign deliverables</h2>
                </div>
                {successResult.artifacts.length === 0 ? (
                  <p className="text-white/60">No artifact summaries are available yet.</p>
                ) : (
                  <div className="grid gap-4">
                    {successResult.artifacts.map((artifact) => (
                      <ArtifactCard key={artifact.id} artifact={artifact} />
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="glass rounded-[2.5rem] p-8">
              <div className="grid gap-5">
                <div>
                  <p className="text-xs uppercase tracking-[0.24em] text-white/35">Timeline</p>
                  <h2 className="text-3xl font-bold mt-2">Campaign events</h2>
                </div>
                {successResult.timeline.length === 0 ? (
                  <p className="text-white/60">No timeline events are available yet.</p>
                ) : (
                  <div className="grid gap-3">
                    {successResult.timeline.map((event) => (
                      <TimelineCard key={event.id} event={event} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      ) : null}
      </div>
    </div>
  );
}

export default MarketingJobStatusScreen;
