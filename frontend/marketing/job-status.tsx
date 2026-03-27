"use client";

import Link from 'next/link';
import { useEffect, useState } from 'react';

import MediaPreview from '@/frontend/components/media-preview';
import type {
  MarketingApprovalSummary,
  MarketingDashboardAsset,
  MarketingDashboardPost,
  MarketingDashboardPublishItem,
  MarketingReviewPreviewCard,
  GetMarketingJobStatusResponse,
  MarketingApiError,
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

function timelineEntryDotClass(tone: string | undefined): string {
  const base = 'absolute -left-[9px] top-0 w-4 h-4 rounded-full border-2 border-background';
  if (tone === 'success') {
    return `${base} bg-green-500`;
  }
  if (tone === 'warning') {
    return `${base} bg-yellow-500`;
  }
  if (tone === 'danger') {
    return `${base} bg-red-500`;
  }
  return `${base} bg-primary`;
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

function DashboardAssetCard({ asset }: { asset: MarketingDashboardAsset }) {
  return (
    <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 grid gap-3">
      <MediaPreview
        src={asset.thumbnailUrl || asset.previewUrl}
        alt={asset.title}
        contentType={asset.contentType}
        className="h-40 overflow-hidden rounded-[1rem] border border-white/8 bg-black/20"
        emptyLabel="Preview pending"
        nonImageLabel={asset.type === 'landing_page' ? 'Landing page preview available' : 'Asset preview available'}
      />
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-white/35">{asset.type.replace(/_/g, ' ')}</p>
          <h3 className="mt-2 text-base font-semibold text-white">{asset.title}</h3>
          <p className="mt-2 text-sm text-white/55">{asset.platformLabel}</p>
        </div>
        <StatusBadge status={asset.status as any} />
      </div>
      <p className="text-sm text-white/60">{asset.summary}</p>
    </div>
  );
}

function DashboardPostCard({
  post,
  previewAsset,
}: {
  post: MarketingDashboardPost | MarketingDashboardPublishItem;
  previewAsset: MarketingDashboardAsset | null;
}) {
  return (
    <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 grid gap-3">
      <MediaPreview
        src={previewAsset?.thumbnailUrl || previewAsset?.previewUrl}
        alt={post.title}
        contentType={previewAsset?.contentType}
        className="h-40 overflow-hidden rounded-[1rem] border border-white/8 bg-black/20"
        emptyLabel="Preview pending"
        nonImageLabel="Preview available"
      />
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-white/35">{post.platformLabel}</p>
          <h3 className="mt-2 text-base font-semibold text-white">{post.title}</h3>
          <p className="mt-2 text-sm text-white/55">{post.summary}</p>
        </div>
        <StatusBadge status={post.status as any} />
      </div>
    </div>
  );
}

function ReviewPreviewGallery({ previews }: { previews: MarketingReviewPreviewCard[] }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {previews.map((preview) => (
        <div key={preview.id} className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 grid gap-3">
          <p className="text-xs uppercase tracking-[0.22em] text-white/35">{preview.platformName}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {preview.mediaAssets.length > 0 ? (
              preview.mediaAssets.map((asset) => (
                <a key={asset.id} href={asset.url} target="_blank" rel="noreferrer" className="rounded-[1rem] overflow-hidden border border-white/8 bg-black/20">
                  <MediaPreview
                    src={asset.url}
                    alt={asset.label}
                    contentType={asset.contentType}
                    className="h-36 w-full"
                    emptyLabel="Preview pending"
                    nonImageLabel={asset.label}
                  />
                </a>
              ))
            ) : (
              <MediaPreview
                alt={preview.platformName}
                className="h-36 rounded-[1rem] border border-white/8 bg-black/20"
                emptyLabel="Preview pending"
              />
            )}
          </div>
          <p className="text-sm text-white/60">{preview.summary}</p>
        </div>
      ))}
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
  const statusLoadFailed = !!(marketingStatus.error || (result && isErrorResult(result)));
  const assetById = successResult
    ? new Map(successResult.dashboard.assets.map((asset) => [asset.id, asset] as const))
    : new Map<string, MarketingDashboardAsset>();

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
              {successResult?.approval ? (
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

            {successResult?.summary ? (
              <div className="rounded-2xl border border-primary/20 bg-primary/10 p-5 mt-4">
                <h3 className="text-xl font-bold text-white mb-1">{successResult.summary.headline}</h3>
                <p className="text-white/70">{successResult.summary.subheadline}</p>
              </div>
            ) : null}

            {marketingStatus.error ? <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-red-100">{marketingStatus.error.message}</div> : null}
            {result && isErrorResult(result) ? <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-red-100">{result.error}</div> : null}
          </div>
        </div>

        <div className="glass rounded-[2.5rem] p-8">
          {loading && !successResult ? (
            <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-8 min-h-[280px] flex flex-col items-center justify-center text-center text-white/60">
              <strong className="text-white text-lg mb-2">Loading campaign</strong>
              <p>Fetching status from the server…</p>
            </div>
          ) : statusLoadFailed ? (
            <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-8 min-h-[280px] flex flex-col items-center justify-center text-center">
              <strong className="text-red-100 text-lg mb-2">Could not load campaign</strong>
              <p className="text-red-100/90">
                {marketingStatus.error?.message ||
                  (result && isErrorResult(result) ? result.error : null) ||
                  'The status request did not return usable data.'}
              </p>
            </div>
          ) : !successResult ? (
            <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-8 min-h-[280px] flex flex-col items-center justify-center text-center text-white/60">
              <strong className="text-white text-lg mb-2">No campaign loaded</strong>
              <p>
                {!normalizeMarketingJobId(jobId)
                  ? 'Enter a job ID, then use Refresh status to load this workspace.'
                  : 'Use Refresh status to load the operational view for this job.'}
              </p>
            </div>
          ) : (
            <div className="grid gap-5">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-white/35 mb-3">Current state</p>
                <h2 className="text-3xl font-bold mb-3">Campaign Pipeline</h2>
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
                  <strong>Job State</strong>
                  <span>{successResult.marketing_job_state}</span>
                </div>
              </div>
              
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-white/70">
                <strong className="block text-white mb-2">Selected publish configuration</strong>
                <div className="grid gap-1 text-sm">
                  <span>Platforms: {successResult.publishConfig?.platforms?.join(', ') || 'none selected'}</span>
                  <span>Live draft publish: {successResult.publishConfig?.livePublishPlatforms?.join(', ') || 'not requested'}</span>
                  <span>Video render: {successResult.publishConfig?.videoRenderPlatforms?.join(', ') || 'not requested'}</span>
                </div>
              </div>

              {successResult.stageCards?.length ? (
                <div className="grid gap-3">
                  <p className="text-xs uppercase tracking-[0.24em] text-white/35">Stage Progress</p>
                  {successResult.stageCards.map((card) => (
                    <div key={card.stage} className="rounded-xl border border-white/5 bg-white/5 p-4 flex items-center justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold">{card.label}</span>
                          <StatusBadge status={card.status as any} />
                        </div>
                        <p className="text-sm text-white/50">{card.summary}</p>
                        {successResult.approval?.actionHref &&
                        (card.status === 'awaiting_approval' || card.status === 'required') ? (
                          <Link
                            href={successResult.approval.actionHref}
                            className="inline-flex mt-3 px-4 py-2 rounded-full bg-white/10 border border-white/10 text-sm font-semibold text-white"
                          >
                            Approve this stage
                          </Link>
                        ) : null}
                      </div>
                      {card.highlight ? <span className="text-xs font-mono bg-white/10 px-2 py-1 rounded">{card.highlight}</span> : null}
                    </div>
                  ))}
                </div>
              ) : null}

              {successResult.approval ? <ApprovalBanner approval={successResult.approval} /> : null}
            </div>
          )}
        </div>
      </div>

      {successResult && (successResult.artifacts?.length || successResult.timeline?.length) ? (
        <div className="grid lg:grid-cols-2 gap-6 mt-6">
          {successResult.artifacts?.length ? (
            <div className="glass rounded-[2.5rem] p-8">
              <p className="text-xs uppercase tracking-[0.24em] text-white/35 mb-6">Deliverables & Artifacts</p>
              <div className="grid gap-4">
                {successResult.artifacts.map((art) => (
                  <div key={art.id} className="rounded-2xl border border-white/10 bg-white/5 p-5">
                    <div className="flex justify-between items-start mb-2">
                      <h3 className="font-bold">{art.title}</h3>
                      <StatusBadge status={art.status as any} />
                    </div>
                    <p className="text-sm text-white/60 mb-3">{art.summary}</p>
                    {art.preview ? (
                      <pre className="text-[10px] bg-black/40 p-3 rounded-lg text-cyan-200/70 overflow-x-auto mb-3 border border-white/5 max-h-32">
                        {art.preview}
                      </pre>
                    ) : null}
                    {art.actionHref && art.actionLabel ? (
                      <Link href={art.actionHref} className="text-xs font-bold text-primary hover:underline">
                        {art.actionLabel} →
                      </Link>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {successResult.timeline?.length ? (
            <div className="glass rounded-[2.5rem] p-8">
              <p className="text-xs uppercase tracking-[0.24em] text-white/35 mb-6">Audit Trail</p>
              <div className="space-y-6">
                {successResult.timeline.map((entry) => (
                  <div key={entry.id} className="relative pl-6 border-l-2 border-white/10">
                    <div className={timelineEntryDotClass(entry.tone)} />
                    <div className="flex justify-between items-start mb-1">
                      <h4 className="text-sm font-bold">{entry.label}</h4>
                      <time className="text-[10px] text-white/30">{entry.at ? new Date(entry.at).toLocaleString() : ''}</time>
                    </div>
                    <p className="text-xs text-white/50">{entry.description}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {successResult?.reviewBundle?.platformPreviews?.length ? (
        <div className="glass rounded-[2.5rem] p-8 mt-6">
          <p className="text-xs uppercase tracking-[0.24em] text-white/35 mb-6">Launch review previews</p>
          <ReviewPreviewGallery previews={successResult.reviewBundle.platformPreviews} />
        </div>
      ) : null}

      {successResult && (successResult.dashboard.assets.length > 0 || successResult.dashboard.posts.length > 0 || successResult.dashboard.publishItems.length > 0) ? (
        <div className="grid gap-6 mt-6 xl:grid-cols-3">
          <div className="glass rounded-[2.5rem] p-8">
            <p className="text-xs uppercase tracking-[0.24em] text-white/35 mb-6">Assets</p>
            <div className="grid gap-4">
              {successResult.dashboard.assets.slice(0, 4).map((asset) => (
                <DashboardAssetCard key={asset.id} asset={asset} />
              ))}
            </div>
          </div>
          <div className="glass rounded-[2.5rem] p-8">
            <p className="text-xs uppercase tracking-[0.24em] text-white/35 mb-6">Posts</p>
            <div className="grid gap-4">
              {successResult.dashboard.posts.slice(0, 4).map((post) => (
                <DashboardPostCard
                  key={post.id}
                  post={post}
                  previewAsset={post.previewAssetId ? assetById.get(post.previewAssetId) || null : null}
                />
              ))}
            </div>
          </div>
          <div className="glass rounded-[2.5rem] p-8">
            <p className="text-xs uppercase tracking-[0.24em] text-white/35 mb-6">Publish queue</p>
            <div className="grid gap-4">
              {successResult.dashboard.publishItems.slice(0, 4).map((item) => (
                <DashboardPostCard
                  key={item.id}
                  post={item}
                  previewAsset={item.previewAssetId ? assetById.get(item.previewAssetId) || null : null}
                />
              ))}
            </div>
          </div>
        </div>
      ) : null}
      </div>
    </div>
  );
}

export default MarketingJobStatusScreen;
