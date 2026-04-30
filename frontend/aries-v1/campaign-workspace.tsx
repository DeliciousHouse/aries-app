'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowUpRight, CheckCircle2, LoaderCircle, MessageSquareText, XCircle } from 'lucide-react';

import MediaPreview from '@/frontend/components/media-preview';
import { safeHref } from '@/lib/safe-href';
import { useMarketingJobStatus } from '@/hooks/use-marketing-job-status';
import type {
  MarketingArtifactCard,
  MarketingVideoArtifactCard,
  MarketingCampaignStatusHistoryEntry,
  MarketingCreativeAssetReviewPayload,
  MarketingStageReviewPayload,
} from '@/lib/api/marketing';

import {
  deriveGateFallbackState,
  deriveGenerationProgressState,
  derivePublishSurfaceState,
  deriveWorkspaceHeaderState,
  resolveWorkspaceView,
  type GateFallbackState,
  type GenerationProgressState,
  type PublishSurfaceState,
  type WorkspaceAction,
  type WorkspaceView,
} from './campaign-workspace-state';
import { customerSafeActionErrorMessage, customerSafeUiErrorMessage } from './customer-safe-copy';
import { ActivityFeed, EmptyStatePanel, SectionLink, ShellPanel, StatusChip } from './components';

type DecisionActionKind = 'approve' | 'changes_requested' | 'reject';

const DECISION_PROGRESS_LABELS: Record<DecisionActionKind, string[]> = {
  approve: ['Saving decision', 'Resuming workflow', 'Preparing next stage', 'Loading review'],
  changes_requested: ['Saving request', 'Sending revision notes', 'Updating review state', 'Refreshing checkpoint'],
  reject: ['Saving decision', 'Marking review rejected', 'Updating review state', 'Refreshing checkpoint'],
};

const DECISION_PROGRESS_MAX_PERCENT = 94;

function isActiveJobStatus(status: string): boolean {
  return ['accepted', 'running', 'in_progress', 'ready', 'awaiting_approval', 'resumed', 'pending'].includes(
    (status || '').toLowerCase(),
  );
}

function workflowStateLabel(value: string): string {
  if (value === 'brand_review_required') return 'Brand review ready';
  if (value === 'strategy_review_required') return 'Strategy review ready';
  if (value === 'creative_review_required') return 'Creative review ready';
  if (value === 'ready_to_publish') return 'Ready for launch';
  if (value === 'published') return 'Published';
  if (value === 'approved') return 'Approved';
  if (value === 'revisions_requested') return 'Needs revisions';
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function reviewSurfaceLabel(reviewType: 'brand' | 'strategy'): string {
  return reviewType === 'brand' ? 'Brand direction' : 'Campaign strategy';
}

function historyTypeLabel(value: MarketingCampaignStatusHistoryEntry['type']): string {
  if (value === 'state_changed') return 'Stage updated';
  if (value === 'stage_review') return 'Review updated';
  if (value === 'creative_asset_review') return 'Creative review updated';
  return 'Comment';
}

function stageReadyLabel(view: WorkspaceView): string {
  if (view === 'brand') return 'Brand review';
  if (view === 'strategy') return 'Strategy review';
  if (view === 'creative') return 'Creative review';
  return 'Launch status';
}

function visibleActorLabel(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    return null;
  }
  if (['operator', 'system', 'workflow', 'automation'].includes(normalized.toLowerCase())) {
    return null;
  }
  return normalized;
}

function workflowStateTone(value: string): string {
  if (value === 'published') return 'border-emerald-400/25 bg-emerald-400/10 text-emerald-100';
  if (value === 'ready_to_publish') return 'border-violet-400/25 bg-violet-400/10 text-violet-100';
  if (value === 'approved') return 'border-sky-400/25 bg-sky-400/10 text-sky-100';
  if (value === 'revisions_requested') return 'border-rose-400/25 bg-rose-400/10 text-rose-100';
  return 'border-amber-400/25 bg-amber-400/10 text-amber-100';
}

function chipStatus(value: string): 'draft' | 'in_review' | 'approved' | 'scheduled' | 'live' | 'changes_requested' | 'rejected' {
  if (value === 'approved') return 'approved';
  if (value === 'changes_requested') return 'changes_requested';
  if (value === 'rejected') return 'rejected';
  return 'in_review';
}

function formatDecisionTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function currentStageHref(campaignId: string, view: WorkspaceView): string {
  return `/dashboard/campaigns/${encodeURIComponent(campaignId)}?view=${view}`;
}

function normalizeHttpUrlInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

const PLATFORM_VIDEO_LABELS: Record<string, string> = {
  tiktok: 'TikTok',
  youtube: 'YouTube',
  'youtube-shorts': 'YouTube Shorts',
  instagram: 'Instagram',
  'instagram-reels': 'Instagram Reels',
  meta: 'Meta',
  'meta-ads': 'Meta Ads',
  facebook: 'Facebook',
};

function isRenderedVideoArtifact(artifact: MarketingArtifactCard): artifact is MarketingVideoArtifactCard {
  return (
    'type' in artifact &&
    artifact.type === 'video' &&
    'contentType' in artifact &&
    artifact.contentType === 'video/mp4' &&
    'url' in artifact &&
    typeof artifact.url === 'string' &&
    artifact.url.trim().length > 0
  );
}

function humanizePlatformSlug(platformSlug: string): string {
  const normalized = platformSlug.trim().toLowerCase();
  if (!normalized) {
    return 'Video';
  }
  if (PLATFORM_VIDEO_LABELS[normalized]) {
    return PLATFORM_VIDEO_LABELS[normalized];
  }
  return normalized
    .split(/[-_]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function humanizeFamilyId(familyId: string): string {
  const normalized = familyId.trim().replace(/[-_]+/g, ' ');
  if (!normalized) {
    return 'Variant';
  }
  const lower = normalized.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function RenderedVideosSection(props: { artifacts: MarketingArtifactCard[] | null | undefined }) {
  const videoArtifacts = (props.artifacts || []).filter(isRenderedVideoArtifact);

  if (videoArtifacts.length === 0) {
    return null;
  }

  return (
    <ShellPanel eyebrow="Creative Outputs" title="Rendered videos">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {videoArtifacts.map((artifact) => {
          const platform = humanizePlatformSlug(artifact.platformSlug);
          const family = humanizeFamilyId(artifact.familyId);

          return (
            <div key={artifact.id} className="space-y-3 rounded-[1.25rem] border border-white/10 bg-white/[0.03] p-4">
              <div>
                <p className="text-sm font-medium text-white/82">{platform} — {family}</p>
              </div>
              <MediaPreview
                src={artifact.url}
                poster={artifact.posterUrl}
                contentType="video/mp4"
                alt={`${platform} — ${family}`}
                className="h-48 w-full rounded"
                imageClassName="h-full w-full rounded object-contain bg-black"
                emptyLabel="Rendered video pending"
                nonImageLabel="Rendered video available"
              />
            </div>
          );
        })}
      </div>
    </ShellPanel>
  );
}

export default function AriesCampaignWorkspace(props: { campaignId: string; initialView?: WorkspaceView }) {
  const job = useMarketingJobStatus({ jobId: props.campaignId, autoLoad: true });
  const [notesByReviewId, setNotesByReviewId] = useState<Record<string, string>>({});
  const [busyByReviewId, setBusyByReviewId] = useState<Record<string, boolean>>({});
  const [briefSaving, setBriefSaving] = useState(false);

  const status = job.data && !('error' in job.data) ? job.data : null;
  // Read view from the URL so client-side navigation (Link clicks, back/forward)
  // updates the rendered section. Falls back to server-provided initialView on
  // first render before useSearchParams populates.
  const searchParams = useSearchParams();
  const viewParam = searchParams?.get('view') ?? null;
  const activeView = resolveWorkspaceView(viewParam, props.initialView || 'brand');

  const progressActive = !!(status && deriveGenerationProgressState(status)?.isComplete === false);

  useEffect(() => {
    if (!status || !isActiveJobStatus(status.marketing_job_status)) {
      return;
    }
    if (progressActive) {
      return;
    }

    const timer = window.setInterval(() => {
      void job.load(props.campaignId, { quiet: true });
    }, 5000);

    return () => window.clearInterval(timer);
  }, [job.load, props.campaignId, status, progressActive]);

  useEffect(() => {
    if (!progressActive) {
      return;
    }
    const timer = window.setInterval(() => {
      void job.load(props.campaignId, { quiet: true });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [job.load, props.campaignId, progressActive]);

  if (job.isLoading) {
    return <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-8 text-white/60">Loading campaign...</div>;
  }

  if (job.error) {
    return (
      <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">
        {customerSafeUiErrorMessage(job.error.message, 'This campaign workspace is not available right now.')}
      </div>
    );
  }

  if (!status || status.marketing_job_state === 'not_found') {
    return (
      <EmptyStatePanel
        title="Campaign not found"
        description="We couldn't find a campaign with that id. It may have been removed or never existed."
        action={
          <Link
            href="/dashboard/campaigns"
            className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-4 py-2 text-sm font-medium text-white/80 transition hover:border-white/25 hover:text-white"
          >
            Back to campaigns
          </Link>
        }
      />
    );
  }

  const workflowState = status.workflowState;
  const currentHistory = status.statusHistory || [];
  const publishBlockedReason = status.creativeReview?.publishBlockedReason || null;
  const headerState = deriveWorkspaceHeaderState(status);
  const brandFallback = deriveGateFallbackState(status, 'brand', props.campaignId, publishBlockedReason);
  const strategyFallback = deriveGateFallbackState(status, 'strategy', props.campaignId, publishBlockedReason);
  const creativeFallback = deriveGateFallbackState(status, 'creative', props.campaignId, publishBlockedReason);
  const publishState = derivePublishSurfaceState(status, props.campaignId, publishBlockedReason);
  const generationProgress = deriveGenerationProgressState(status);

  async function submitReviewDecision(
    reviewId: string,
    action: 'approve' | 'changes_requested' | 'reject',
    approvalId?: string,
  ) {
    setBusyByReviewId((current) => ({ ...current, [reviewId]: true }));
    try {
      const response = await fetch(`/api/marketing/reviews/${encodeURIComponent(reviewId)}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action,
          actedBy: 'Client reviewer',
          note: notesByReviewId[reviewId] || '',
          approvalId,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || 'Failed to save review decision.');
      }
      setNotesByReviewId((current) => ({ ...current, [reviewId]: '' }));
      await job.load(props.campaignId, { quiet: false });
    } catch (error) {
      window.alert(
        customerSafeActionErrorMessage(
          error instanceof Error ? error.message : null,
          'The review decision could not be saved right now.',
        ),
      );
    } finally {
      setBusyByReviewId((current) => ({ ...current, [reviewId]: false }));
    }
  }

  async function submitBriefUpdate(body: FormData | Record<string, unknown>) {
    setBriefSaving(true);
    try {
      const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
      const response = await fetch(`/api/marketing/jobs/${encodeURIComponent(props.campaignId)}/brief`, {
        method: 'PATCH',
        headers: isFormData ? undefined : { 'content-type': 'application/json' },
        body: isFormData ? body : JSON.stringify(body),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          customerSafeActionErrorMessage(payload.error || null, 'The campaign brief could not be updated right now.'),
        );
      }

      await job.load(props.campaignId, { quiet: false });
    } finally {
      setBriefSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <ShellPanel eyebrow="Campaign" title={headerState.title}>
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium tracking-[0.03em] ${workflowStateTone(workflowState)}`}>
              {workflowStateLabel(workflowState)}
            </span>
            {headerState.sourceDomain ? (
              <span className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-white/70">
                Current source · {headerState.sourceDomain}
              </span>
            ) : null}
            <span className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-white/70">
              {status.campaignWindow?.start && status.campaignWindow?.end ? `${status.campaignWindow.start} - ${status.campaignWindow.end}` : 'Dates not scheduled yet'}
            </span>
            <span className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-white/70">
              {stageReadyLabel(activeView)}
            </span>
          </div>
          {headerState.sourceUrl ? (
            <a
              href={headerState.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 text-sm text-white/58 transition hover:text-white/78"
            >
              Source website: {headerState.sourceUrl}
              <ArrowUpRight className="h-4 w-4" />
            </a>
          ) : null}
          <p className="max-w-3xl text-sm leading-7 text-white/65">{status.summary.subheadline}</p>
          <div className="grid gap-4 md:grid-cols-4">
            <MetricCard label="Generated assets" value={String(status.dashboard.assets.length)} />
            <MetricCard label="Creative approvals" value={`${status.creativeReview?.approvedCount || 0}/${status.creativeReview?.assets.length || 0}`} />
            <MetricCard label="Publish items" value={String(status.dashboard.publishItems.length)} />
            <MetricCard label="History entries" value={String(currentHistory.length)} />
          </div>
        </div>
      </ShellPanel>

      <div className="flex flex-wrap gap-3">
        {([
          ['brand', 'Brand Review'],
          ['strategy', 'Strategy Review'],
          ['creative', 'Creative Review'],
          ['publish', 'Launch Status'],
        ] as Array<[WorkspaceView, string]>).map(([view, label]) => (
          <Link
            key={view}
            href={currentStageHref(props.campaignId, view)}
            scroll={false}
            aria-current={activeView === view ? 'step' : undefined}
            className={`rounded-full border px-4 py-2.5 text-sm transition ${
              activeView === view
                ? 'border-white/20 bg-white/[0.08] text-white font-bold shadow-[0_0_0_1px_rgba(255,255,255,0.08)]'
                : 'border-white/8 bg-white/[0.03] text-white/55 font-medium hover:border-white/15 hover:text-white'
            }`}
          >
            {activeView === view ? <span className="mr-2 text-[#d6b8ff]">Current:</span> : null}
            {label}
          </Link>
        ))}
      </div>

      {activeView === 'brand' ? (
        <div className="space-y-4">
          {status.campaignBrief ? <BrandBriefCard brief={status.campaignBrief} saving={briefSaving} onSave={submitBriefUpdate} /> : null}
          <StageReviewSurface
            review={status.brandReview}
            fallback={brandFallback}
            note={status.brandReview ? notesByReviewId[status.brandReview.reviewId] || '' : ''}
            onNoteChange={(value) =>
              status.brandReview
                ? setNotesByReviewId((current) => ({ ...current, [status.brandReview!.reviewId]: value }))
                : null
            }
            busy={status.brandReview ? !!busyByReviewId[status.brandReview.reviewId] : false}
            onApprove={
              status.brandReview
                ? () => void submitReviewDecision(status.brandReview!.reviewId, 'approve')
                : undefined
            }
            onChangesRequested={
              status.brandReview
                ? () => void submitReviewDecision(status.brandReview!.reviewId, 'changes_requested')
                : undefined
            }
            nextStageHref={`/dashboard/campaigns/${encodeURIComponent(props.campaignId)}?view=strategy`}
            nextStageLabel="Go to Strategy Review"
          />
        </div>
      ) : null}

      {activeView === 'strategy' ? (
        <StageReviewSurface
          review={status.strategyReview}
          fallback={strategyFallback}
          note={status.strategyReview ? notesByReviewId[status.strategyReview.reviewId] || '' : ''}
          onNoteChange={(value) =>
            status.strategyReview
              ? setNotesByReviewId((current) => ({ ...current, [status.strategyReview!.reviewId]: value }))
              : null
          }
          busy={status.strategyReview ? !!busyByReviewId[status.strategyReview.reviewId] : false}
          onApprove={
            status.strategyReview
              ? () => void submitReviewDecision(status.strategyReview!.reviewId, 'approve', status.approval?.approvalId)
              : undefined
          }
          onChangesRequested={
            status.strategyReview
              ? () => void submitReviewDecision(status.strategyReview!.reviewId, 'changes_requested', status.approval?.approvalId)
              : undefined
          }
          nextStageHref={`/dashboard/campaigns/${encodeURIComponent(props.campaignId)}?view=creative`}
          nextStageLabel="Go to Creative Review"
        />
      ) : null}

      {activeView === 'creative' ? (
        <div className="space-y-4">
          {generationProgress && !generationProgress.isComplete ? (
            <GenerationProgressBar progress={generationProgress} />
          ) : null}
          <RenderedVideosSection artifacts={status.artifacts} />
          <CreativeReviewSurface
            review={status.creativeReview}
            fallback={creativeFallback}
            notesByReviewId={notesByReviewId}
            busyByReviewId={busyByReviewId}
            setNote={(reviewId, value) => setNotesByReviewId((current) => ({ ...current, [reviewId]: value }))}
            onDecision={(reviewId, action) => void submitReviewDecision(reviewId, action, status.approval?.approvalId)}
          />
        </div>
      ) : null}

      {activeView === 'publish' ? (
        <PublishStatusSurface
          workflowState={status.workflowState}
          publishItems={status.dashboard.publishItems}
          history={currentHistory}
          overview={publishState}
        />
      ) : null}

      <ShellPanel eyebrow="Shortcuts" title="Next steps">
        <div className="flex flex-wrap gap-3">
          <SectionLink href="/dashboard/campaigns/new" label="New campaign" />
          <SectionLink href="/dashboard/brand-review" label="Brand review" />
          <SectionLink href="/dashboard/strategy-review" label="Strategy review" />
          <SectionLink href="/dashboard/creative-review" label="Creative review" />
          <SectionLink href="/dashboard/publish-status" label="Publish / status" />
        </div>
      </ShellPanel>
    </div>
  );
}

function GenerationProgressBar(props: { progress: GenerationProgressState }) {
  const { progress } = props;
  const pct = Math.round(Math.max(0, Math.min(1, progress.percentComplete)) * 100);
  return (
    <div className="rounded-[1.25rem] border border-white/10 bg-white/[0.04] px-5 py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-white/85">{progress.title}</p>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-white/55">
          {progress.currentLabel}
        </p>
      </div>
      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-white/[0.08]">
        <div
          className="h-full rounded-full bg-emerald-400/70 transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-3 text-xs leading-5 text-white/60">{progress.description}</p>
      {(progress.imageCount !== null || progress.videoCount !== null) ? (
        <div className="mt-3 flex flex-wrap gap-3 text-[11px] font-medium uppercase tracking-[0.18em] text-white/45">
          {progress.imageCount !== null ? (
            <span className="rounded-full border border-white/10 bg-black/15 px-3 py-1">
              {progress.completedImageCount}/{progress.imageCount} images
            </span>
          ) : null}
          {progress.videoCount !== null ? (
            <span className="rounded-full border border-white/10 bg-black/15 px-3 py-1">
              {progress.completedVideoCount}/{progress.videoCount} videos
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MetricCard(props: { label: string; value: string }) {
  return (
    <div className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">{props.label}</p>
      <p className="mt-2 text-sm text-white/78">{props.value}</p>
    </div>
  );
}

function BrandBriefCard(props: {
  brief: {
    websiteUrl: string;
    brandVoice: string;
    styleVibe: string;
    visualReferences: string[];
    mustUseCopy: string;
    mustAvoidAesthetics: string;
    notes: string;
    brandAssets: Array<{ id: string; name: string; url: string }>;
  };
  saving: boolean;
  onSave: (payload: FormData | Record<string, unknown>) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [websiteUrl, setWebsiteUrl] = useState(props.brief.websiteUrl);
  const [brandVoice, setBrandVoice] = useState(props.brief.brandVoice);
  const [styleVibe, setStyleVibe] = useState(props.brief.styleVibe);
  const [visualReferences, setVisualReferences] = useState(props.brief.visualReferences.join('\n'));
  const [mustUseCopy, setMustUseCopy] = useState(props.brief.mustUseCopy);
  const [mustAvoidAesthetics, setMustAvoidAesthetics] = useState(props.brief.mustAvoidAesthetics);
  const [notes, setNotes] = useState(props.brief.notes);
  const [brandAssets, setBrandAssets] = useState<File[]>([]);
  const [urlTouched, setUrlTouched] = useState(false);
  const editRegionRef = useRef<HTMLDivElement | null>(null);
  const websiteInputRef = useRef<HTMLInputElement | null>(null);

  const normalizedWebsiteUrl = normalizeHttpUrlInput(websiteUrl);
  const trimmedUrl = normalizedWebsiteUrl.trim();
  const urlIsValid = /^https?:\/\/\S+/i.test(trimmedUrl);
  const urlErrorMessage = !trimmedUrl
    ? 'Website URL is required.'
    : !urlIsValid
    ? 'Enter a full URL starting with http:// or https://'
    : '';

  function resetDraftFromBrief() {
    setWebsiteUrl(props.brief.websiteUrl);
    setBrandVoice(props.brief.brandVoice);
    setStyleVibe(props.brief.styleVibe);
    setVisualReferences(props.brief.visualReferences.join('\n'));
    setMustUseCopy(props.brief.mustUseCopy);
    setMustAvoidAesthetics(props.brief.mustAvoidAesthetics);
    setNotes(props.brief.notes);
    setBrandAssets([]);
  }

  function handleCancelEdit() {
    resetDraftFromBrief();
    setEditing(false);
    setUrlTouched(false);
  }

  // H2 (a11y): focus first input when edit region opens, Esc cancels.
  useEffect(() => {
    if (!editing) return;
    websiteInputRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        handleCancelEdit();
      }
    }
    const node = editRegionRef.current;
    node?.addEventListener('keydown', onKeyDown);
    return () => node?.removeEventListener('keydown', onKeyDown);
  }, [editing]);

  useEffect(() => {
    if (editing) {
      return;
    }
    resetDraftFromBrief();
  }, [editing, props.brief]);

  async function handleSave() {
    if (!urlIsValid) {
      setUrlTouched(true);
      return;
    }
    const visualReferenceEntries = visualReferences.split('\n').map((item) => item.trim()).filter(Boolean);

    if (brandAssets.length > 0) {
      const formData = new FormData();
      formData.set('websiteUrl', normalizedWebsiteUrl);
      formData.set('brandVoice', brandVoice.trim());
      formData.set('styleVibe', styleVibe.trim());
      formData.set('mustUseCopy', mustUseCopy.trim());
      formData.set('mustAvoidAesthetics', mustAvoidAesthetics.trim());
      formData.set('notes', notes.trim());
      for (const entry of visualReferenceEntries) {
        formData.append('visualReferences', entry);
      }
      for (const file of brandAssets) {
        formData.append('brandAssets', file);
      }

      await props.onSave(formData);
    } else {
      await props.onSave({
        websiteUrl: normalizedWebsiteUrl,
        brandVoice: brandVoice.trim(),
        styleVibe: styleVibe.trim(),
        visualReferences: visualReferenceEntries,
        mustUseCopy: mustUseCopy.trim(),
        mustAvoidAesthetics: mustAvoidAesthetics.trim(),
        notes: notes.trim(),
      });
    }

    setBrandAssets([]);
    setEditing(false);
    setUrlTouched(false);
  }

  return (
    <ShellPanel eyebrow="Brand brief" title="What Aries is using as the current source brief">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm leading-7 text-white/65">
          Update the current source website, voice direction, references, or revision notes here when the campaign needs a clearer brief.
        </p>
        <div className="flex flex-wrap gap-3">
          {editing ? (
            <>
              <button
                type="button"
                onClick={handleCancelEdit}
                className="rounded-full border border-white/12 px-4 py-2 text-sm text-white/75 transition hover:border-white/20 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={props.saving || !urlIsValid}
                className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-[#11161c] disabled:opacity-60"
              >
                {props.saving ? 'Saving…' : 'Save brief'}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded-full border border-white/12 px-4 py-2 text-sm text-white/75 transition hover:border-white/20 hover:text-white"
            >
              Edit brief
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <div
          ref={editRegionRef}
          role="region"
          aria-label="Edit brief"
          className="grid gap-4 md:grid-cols-2"
        >
          <div className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4 md:col-span-2">
            <label
              htmlFor="edit-brief-website-url"
              className="block text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35"
            >
              Website URL
            </label>
            <input
              ref={websiteInputRef}
              id="edit-brief-website-url"
              type="url"
              required
              inputMode="url"
              pattern="https?://.+"
              placeholder="https://your-brand.com"
              aria-invalid={urlTouched && !urlIsValid}
              aria-describedby={urlTouched && urlErrorMessage ? 'edit-brief-website-url-error' : undefined}
              value={websiteUrl}
              onChange={(event) => setWebsiteUrl(event.target.value)}
              onBlur={() => {
                setWebsiteUrl(normalizeHttpUrlInput(websiteUrl));
                setUrlTouched(true);
              }}
              className="mt-3 w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-sm text-white placeholder:text-white/30"
            />
            {urlTouched && urlErrorMessage ? (
              <p
                id="edit-brief-website-url-error"
                role="alert"
                className="mt-2 text-xs text-rose-300"
              >
                {urlErrorMessage}
              </p>
            ) : null}
          </div>
          <EditableBriefField id="edit-brief-brand-voice" label="Brand voice" multiline rows={4} maxLength={2000} placeholder="Describe how the brand should sound (e.g., confident, playful, direct)." value={brandVoice} onChange={setBrandVoice} />
          <EditableBriefField id="edit-brief-style-vibe" label="Style / vibe" multiline rows={4} maxLength={2000} placeholder="Describe the visual vibe (e.g., minimal editorial, warm and retro)." value={styleVibe} onChange={setStyleVibe} />
          <EditableBriefField id="edit-brief-visual-references" label="Visual references" multiline rows={5} maxLength={3000} placeholder="Paste one reference URL or note per line." value={visualReferences} onChange={setVisualReferences} />
          <EditableBriefField id="edit-brief-must-use" label="Must-use copy" multiline rows={4} maxLength={2000} placeholder="Taglines, claims, CTAs that must appear verbatim." value={mustUseCopy} onChange={setMustUseCopy} />
          <EditableBriefField id="edit-brief-must-avoid" label="Must-avoid aesthetics" multiline rows={4} maxLength={2000} placeholder="Colors, tropes, or styles the brand does not want to see." value={mustAvoidAesthetics} onChange={setMustAvoidAesthetics} />
          <EditableBriefField id="edit-brief-notes" label="Revision notes" multiline rows={5} maxLength={3000} placeholder="Context for this revision: what's changing and why." value={notes} onChange={setNotes} className="md:col-span-2" />

          <div className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4 md:col-span-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Add logos / brand assets</p>
            <label className="mt-3 flex cursor-pointer flex-col gap-3 rounded-[1.25rem] border border-dashed border-white/15 bg-white/[0.03] px-4 py-4 text-sm text-white/65 transition hover:border-white/25 hover:text-white">
              <span>Upload more logos, lockups, guides, or source files.</span>
              <input type="file" multiple className="hidden" onChange={(event) => setBrandAssets(Array.from(event.target.files || []))} />
              <span className="text-white/45">Choose files</span>
            </label>
            {brandAssets.length > 0 ? (
              <div className="mt-3 space-y-2 text-sm text-white/65">
                {brandAssets.map((file) => (
                  <div key={`${file.name}-${file.size}`}>{file.name}</div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {!editing ? (
        <div className="grid gap-4 md:grid-cols-2">
          <BriefField label="Website URL" value={props.brief.websiteUrl || 'Not provided'} />
          <BriefField label="Brand voice" value={props.brief.brandVoice || 'Not provided'} />
          <BriefField label="Style / vibe" value={props.brief.styleVibe || 'Not provided'} />
          <BriefField label="Visual references" value={props.brief.visualReferences.join('\n') || 'Not provided'} />
          <BriefField label="Must-use copy" value={props.brief.mustUseCopy || 'Not provided'} />
          <BriefField label="Must-avoid aesthetics" value={props.brief.mustAvoidAesthetics || 'Not provided'} />
        </div>
      ) : null}

      {!editing && props.brief.notes ? (
        <div className="mt-4 rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Revision notes</p>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-white/68">{props.brief.notes}</p>
        </div>
      ) : null}
      {props.brief.brandAssets.length > 0 ? (
        <div className="mt-4 rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Uploaded brand assets</p>
          <div className="mt-3 flex flex-wrap gap-3">
            {props.brief.brandAssets.map((asset) => (
              <a key={asset.id} href={asset.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full border border-white/12 px-4 py-2 text-sm text-white/80 transition hover:border-white/20 hover:text-white">
                {asset.name}
                <ArrowUpRight className="h-4 w-4" />
              </a>
            ))}
          </div>
        </div>
      ) : null}
    </ShellPanel>
  );
}

function EditableBriefField(props: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  rows?: number;
  className?: string;
  maxLength?: number;
  placeholder?: string;
}) {
  const counterId = `${props.id}-counter`;
  return (
    <div className={`rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4 ${props.className || ''}`}>
      {/* H7 fix: <label> carries only the label text (via htmlFor), so
          screen readers no longer concatenate label + current value. */}
      <label
        htmlFor={props.id}
        className="block text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35"
      >
        {props.label}
      </label>
      {props.multiline ? (
        <textarea
          id={props.id}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          rows={props.rows || 4}
          maxLength={props.maxLength}
          placeholder={props.placeholder}
          aria-describedby={props.maxLength ? counterId : undefined}
          className="mt-3 w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-sm text-white placeholder:text-white/30"
        />
      ) : (
        <input
          id={props.id}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          maxLength={props.maxLength}
          placeholder={props.placeholder}
          aria-describedby={props.maxLength ? counterId : undefined}
          className="mt-3 w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-sm text-white placeholder:text-white/30"
        />
      )}
      {props.maxLength ? (
        <p id={counterId} className="mt-2 text-right text-[11px] text-white/45" aria-live="polite">
          {props.value.length} / {props.maxLength}
        </p>
      ) : null}
    </div>
  );
}

function BriefField(props: { label: string; value: string }) {
  return (
    <div className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">{props.label}</p>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-white/68">{props.value}</p>
    </div>
  );
}

function WorkspaceActionLink(props: { action: WorkspaceAction; tone?: 'default' | 'review' }) {
  const textClass = props.tone === 'review' ? 'text-black' : 'text-[#11161c]';

  return (
    <Link
      href={props.action.href}
      className={`inline-flex cursor-pointer items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-semibold transition hover:translate-y-[-1px] ${textClass}`}
    >
      <span className={textClass}>{props.action.label}</span>
      <ArrowUpRight className={`h-4 w-4 ${textClass}`} />
    </Link>
  );
}

function GateFallbackPanel(props: {
  eyebrow: string;
  fallback: GateFallbackState;
}) {
  return (
    <ShellPanel
      eyebrow={props.eyebrow}
      title={props.fallback.title}
      action={props.fallback.action ? <WorkspaceActionLink action={props.fallback.action} tone="review" /> : undefined}
    >
      <div className="space-y-3">
        <p className="text-sm leading-7 text-white/65">{props.fallback.description}</p>
        {props.fallback.detail ? <p className="text-sm leading-7 text-white/48">{props.fallback.detail}</p> : null}
      </div>
    </ShellPanel>
  );
}

function StageReviewSurface(props: {
  review: MarketingStageReviewPayload | null;
  fallback: GateFallbackState;
  note: string;
  onNoteChange: (value: string) => void | null;
  busy: boolean;
  onApprove?: () => void;
  onChangesRequested?: () => void;
  /** Shown after this review is approved so the user has a clear next step
   * (e.g. "Go to Strategy Review") instead of the stale "Approve" button. */
  nextStageHref?: string;
  nextStageLabel?: string;
}) {
  if (!props.review) {
    return <GateFallbackPanel eyebrow="Checkpoint" fallback={props.fallback} />;
  }

  const isApproved = props.review.status === 'approved';

  return (
    <div className="space-y-4">
      <ShellPanel eyebrow={reviewSurfaceLabel(props.review.reviewType)} title={props.review.title}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <StatusChip status={chipStatus(props.review.status)} />
            {props.review.latestNote ? (
              <span className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-white/70">
                Latest note saved
              </span>
            ) : null}
          </div>
          <p className="text-sm leading-7 text-white/65">{props.review.summary}</p>
        </div>
      </ShellPanel>

      {props.review.reviewType === 'brand' && props.review.brandIdentity ? (
        <ShellPanel eyebrow="Brand identity" title="The core identity Aries will carry forward">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <BriefField label="Identity summary" value={props.review.brandIdentity.summary || 'Brand summary pending.'} />
            <BriefField label="Positioning" value={props.review.brandIdentity.positioning || 'Positioning pending.'} />
            <BriefField label="Audience" value={props.review.brandIdentity.audience || 'Audience summary pending.'} />
            <BriefField label="Offer" value={props.review.brandIdentity.offer || 'Offer summary pending.'} />
            <BriefField label="Brand voice" value={props.review.brandIdentity.toneOfVoice || 'Voice summary pending.'} />
            <BriefField label="Style / vibe" value={props.review.brandIdentity.styleVibe || 'Style summary pending.'} />
          </div>
        </ShellPanel>
      ) : null}

      <div className="space-y-4">
        {props.review.sections.map((section) => (
          <ShellPanel key={section.id} eyebrow="Content" title={section.title}>
            <div className="whitespace-pre-wrap text-sm leading-7 text-white/68">{section.body}</div>
          </ShellPanel>
        ))}

        {isApproved && props.nextStageHref ? (
          <ApprovedNextStageCard
            href={props.nextStageHref}
            label={props.nextStageLabel || 'Continue to next review'}
            stageLabel={reviewSurfaceLabel(props.review.reviewType)}
          />
        ) : (
          <ReviewDecisionCard
            note={props.note}
            onNoteChange={props.onNoteChange}
            busy={props.busy}
            onApprove={isApproved ? undefined : props.onApprove}
            onChangesRequested={isApproved ? undefined : props.onChangesRequested}
            approveLabel={`Authorize ${reviewSurfaceLabel(props.review.reviewType)} review`}
            placeholder={props.review.notePlaceholder}
          />
        )}

        <HistoryCard history={props.review.history} />
      </div>
    </div>
  );
}

function CreativeReviewSurface(props: {
  review: { approvalComplete: boolean; approvedCount: number; pendingCount: number; rejectedCount: number; publishBlockedReason: string | null; assets: MarketingCreativeAssetReviewPayload[]; history: MarketingCampaignStatusHistoryEntry[] } | null;
  fallback: GateFallbackState;
  notesByReviewId: Record<string, string>;
  busyByReviewId: Record<string, boolean>;
  setNote: (reviewId: string, value: string) => void;
  onDecision: (reviewId: string, action: 'approve' | 'changes_requested' | 'reject') => void;
}) {
  if (!props.review) {
    return <GateFallbackPanel eyebrow="Creative Review" fallback={props.fallback} />;
  }

  return (
    <div className="space-y-4">
      <ShellPanel eyebrow="Creative Review" title="Approve every asset before publish unlocks">
        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard label="Approved" value={String(props.review.approvedCount)} />
          <MetricCard label="Pending" value={String(props.review.pendingCount)} />
          <MetricCard label="Rejected" value={String(props.review.rejectedCount)} />
          <MetricCard label="Status" value={props.review.approvalComplete ? 'Complete' : 'Blocked'} />
        </div>
        {props.review.publishBlockedReason ? (
          <p className="mt-4 text-sm leading-7 text-amber-100/85">{props.review.publishBlockedReason}</p>
        ) : null}
      </ShellPanel>

      <div className="grid gap-4">
        {props.review.assets.map((asset) => (
          <ShellPanel key={asset.reviewId} eyebrow={asset.platformLabel} title={asset.title}>
            <div className="grid gap-5 xl:grid-cols-[1.05fr_0.95fr]">
              <div className="space-y-4">
                <MediaPreview
                  src={asset.fullPreviewUrl || asset.previewUrl}
                  alt={asset.title}
                  contentType={asset.contentType}
                  className="min-h-[24rem] overflow-hidden rounded-[1.2rem] border border-white/8 bg-black/20"
                  imageClassName="h-full w-full object-contain bg-black/40"
                  emptyLabel="Preview pending"
                  nonImageLabel={asset.contentType?.includes('html') ? 'Landing page preview available' : 'Asset preview available'}
                />
                <div className="flex flex-wrap items-center gap-3">
                  <StatusChip status={asset.status === 'approved' ? 'approved' : asset.status === 'changes_requested' ? 'changes_requested' : asset.status === 'rejected' ? 'rejected' : 'in_review'} />
                  
                  {asset.fullPreviewUrl ? (
                    <a href={asset.fullPreviewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full border border-white/12 px-4 py-2 text-sm text-white/80 transition hover:border-white/20 hover:text-white">
                      Open full preview
                      <ArrowUpRight className="h-4 w-4" />
                    </a>
                  ) : null}
                  {asset.destinationUrl ? (
                    <a href={asset.destinationUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full border border-white/12 px-4 py-2 text-sm text-white/80 transition hover:border-white/20 hover:text-white">
                      Destination URL
                      <ArrowUpRight className="h-4 w-4" />
                    </a>
                  ) : null}
                </div>
                <div className="whitespace-pre-wrap text-sm leading-7 text-white/65">{asset.notes.join('\n')}</div>
              </div>

              <div className="space-y-4">
                <ReviewDecisionCard
                  note={props.notesByReviewId[asset.reviewId] || ''}
                  onNoteChange={(value) => props.setNote(asset.reviewId, value)}
                  busy={!!props.busyByReviewId[asset.reviewId]}
                  onApprove={() => props.onDecision(asset.reviewId, 'approve')}
                  onChangesRequested={() => props.onDecision(asset.reviewId, 'changes_requested')}
                  onReject={() => props.onDecision(asset.reviewId, 'reject')}
                  approveLabel="Authorize asset review"
                  placeholder="Add per-asset notes or request revisions."
                />
                <HistoryCard history={asset.history} />
              </div>
            </div>
          </ShellPanel>
        ))}
      </div>
    </div>
  );
}

function PublishStatusSurface(props: {
  workflowState: string;
  publishItems: Array<{ id: string; title: string; summary: string; status: string; platformLabel: string; destinationUrl: string | null }>;
  history: MarketingCampaignStatusHistoryEntry[];
  overview: PublishSurfaceState;
}) {
  return (
    <div className="space-y-4">
      <ShellPanel
        eyebrow="Launch status"
        title={props.overview.title}
        action={props.overview.action ? <WorkspaceActionLink action={props.overview.action} /> : undefined}
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium tracking-[0.03em] ${workflowStateTone(props.workflowState)}`}>
              {workflowStateLabel(props.workflowState)}
            </span>
          </div>
          <p className="text-sm leading-7 text-white/65">{props.overview.description}</p>
        </div>
      </ShellPanel>

      <ShellPanel eyebrow="Publish queue" title="Launch-ready items">
        {props.publishItems.length === 0 ? (
          <EmptyStatePanel compact title={props.overview.emptyTitle} description={props.overview.emptyDescription} />
        ) : (
          <div className="space-y-3">
            {props.publishItems.map((item) => {
              const hrefCandidate = safeHref(item.destinationUrl);
              const isExternal = hrefCandidate ? /^https?:\/\//i.test(hrefCandidate) : false;
              const itemBody = (
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-white">{item.title}</p>
                    <p className="text-sm text-white/55">{item.platformLabel}</p>
                    <p className="text-sm text-white/45">{item.summary}</p>
                    {item.destinationUrl ? <p className="text-sm text-white/40">{item.destinationUrl}</p> : null}
                  </div>
                  <StatusChip status={item.status === 'ready_to_publish' ? 'approved' : item.status === 'published_to_meta_paused' ? 'live' : 'in_review'}>
                    {workflowStateLabel(item.status)}
                  </StatusChip>
                </div>
              );
              const cardClass = `block rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4 ${hrefCandidate ? 'transition hover:border-white/20 hover:bg-black/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30' : ''}`;
              if (hrefCandidate && isExternal) {
                return (
                  <a
                    key={item.id}
                    href={hrefCandidate}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cardClass}
                  >
                    {itemBody}
                  </a>
                );
              }
              if (hrefCandidate) {
                return (
                  <Link key={item.id} href={hrefCandidate} className={cardClass}>
                    {itemBody}
                  </Link>
                );
              }
              return (
                <div key={item.id} className={cardClass}>
                  {itemBody}
                </div>
              );
            })}
          </div>
        )}
      </ShellPanel>

      <ShellPanel eyebrow="Status history" title="Recent decisions">
        <ActivityFeed items={props.history.map((entry) => ({ id: entry.id, label: historyTypeLabel(entry.type), detail: entry.note || workflowStateLabel(entry.workflowState), at: formatDecisionTimestamp(entry.at) }))} />
      </ShellPanel>
    </div>
  );
}

function ApprovedNextStageCard(props: { href: string; label: string; stageLabel: string }) {
  return (
    <ShellPanel eyebrow={`${props.stageLabel} approved`} title="Ready for the next review">
      <div className="space-y-4">
        <p className="text-sm leading-7 text-white/65">
          This review has been approved. Continue to the next stage to keep the campaign moving.
        </p>
        <Link
          href={props.href}
          style={{ color: '#11161c' }}
          className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold transition hover:translate-y-[-1px]"
        >
          <CheckCircle2 className="h-4 w-4" />
          {props.label}
          <ArrowUpRight className="h-4 w-4" />
        </Link>
      </div>
    </ShellPanel>
  );
}

function ReviewDecisionCard(props: {
  note: string;
  onNoteChange: (value: string) => void | null;
  busy: boolean;
  onApprove?: () => void;
  onChangesRequested?: () => void;
  onReject?: () => void;
  placeholder?: string;
  approveLabel?: string;
}) {
  const [activeAction, setActiveAction] = useState<DecisionActionKind>('approve');
  const [progressIndex, setProgressIndex] = useState(0);
  const [progressPercent, setProgressPercent] = useState(0);

  useEffect(() => {
    if (!props.busy) {
      setProgressIndex(0);
      setProgressPercent(0);
      return;
    }

    const progressLabels = DECISION_PROGRESS_LABELS[activeAction];
    const startedAt = Date.now();
    setProgressPercent(8);
    setProgressIndex(0);

    const intervalId = window.setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      const easedPercent = Math.round(8 + (1 - Math.exp(-elapsedMs / 4200)) * (DECISION_PROGRESS_MAX_PERCENT - 8));
      const nextPercent = Math.min(DECISION_PROGRESS_MAX_PERCENT, easedPercent);
      const nextIndex = Math.min(
        progressLabels.length - 1,
        Math.floor((nextPercent / 100) * progressLabels.length),
      );

      setProgressPercent(nextPercent);
      setProgressIndex(nextIndex);
    }, 160);

    return () => window.clearInterval(intervalId);
  }, [activeAction, props.busy]);

  const activeProgressLabel = props.busy ? DECISION_PROGRESS_LABELS[activeAction][progressIndex] : null;

  return (
    <ShellPanel eyebrow="Decision" title="Approve or request changes">
      <div className="space-y-4">
        <textarea
          value={props.note}
          onChange={(event) => props.onNoteChange(event.target.value.slice(0, 600))}
          placeholder={props.placeholder || 'Share any revision context for the team'}
          className="w-full rounded-[1.25rem] border border-white/10 bg-black/15 px-4 py-3 text-sm text-white placeholder:text-white/30"
        />
        <div className="flex flex-wrap gap-3">
          {props.onApprove ? (
            <button
              type="button"
              onClick={() => {
                setActiveAction('approve');
                props.onApprove?.();
              }}
              disabled={props.busy}
              /* Inline color bypasses any cascade conflict so the approval
                 label is always visible even if utility layering changes
                 elsewhere. Belt-and-suspenders for the demo-critical CTA. */
              style={{ color: '#11161c', cursor: props.busy ? 'not-allowed' : 'pointer' }}
              className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold hover:cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
            >
              {props.busy && activeAction === 'approve' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {props.busy && activeAction === 'approve' ? activeProgressLabel : props.approveLabel || 'Approve'}
            </button>
          ) : null}
          {props.onChangesRequested ? (
            <button
              type="button"
              onClick={() => {
                setActiveAction('changes_requested');
                props.onChangesRequested?.();
              }}
              disabled={props.busy}
              className="inline-flex items-center gap-2 rounded-full border border-white/12 px-5 py-3 text-sm font-semibold text-white hover:cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
              style={{ cursor: props.busy ? 'not-allowed' : 'pointer' }}
            >
              {props.busy && activeAction === 'changes_requested' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <MessageSquareText className="h-4 w-4" />}
              {props.busy && activeAction === 'changes_requested' ? activeProgressLabel : 'Request changes'}
            </button>
          ) : null}
          {props.onReject ? (
            <button
              type="button"
              onClick={() => {
                setActiveAction('reject');
                props.onReject?.();
              }}
              disabled={props.busy}
              className="inline-flex items-center gap-2 rounded-full border border-rose-300/20 bg-rose-300/10 px-5 py-3 text-sm font-semibold text-rose-50 hover:cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
              style={{ cursor: props.busy ? 'not-allowed' : 'pointer' }}
            >
              {props.busy && activeAction === 'reject' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
              {props.busy && activeAction === 'reject' ? activeProgressLabel : 'Reject'}
            </button>
          ) : null}
        </div>
        {props.busy ? (
          <div className="rounded-[1.25rem] border border-white/10 bg-white/[0.04] px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-white/88">{activeProgressLabel}</p>
              <p className="text-sm font-semibold tabular-nums text-white/72">{progressPercent}%</p>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/[0.08]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-sky-400 via-cyan-300 to-emerald-300 transition-[width] duration-300 ease-out"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <p className="mt-3 text-xs leading-5 text-white/55">
              Aries is saving the decision and refreshing the next review state. This can take a few seconds.
            </p>
          </div>
        ) : null}
      </div>
    </ShellPanel>
  );
}

function HistoryCard(props: { history: MarketingCampaignStatusHistoryEntry[] }) {
  return (
    <ShellPanel eyebrow="History" title="Decision history">
      {props.history.length === 0 ? (
        <p className="text-sm text-white/55">No decision history yet.</p>
      ) : (
        <div className="space-y-3">
          {props.history
            .slice()
            .sort((left, right) => right.at.localeCompare(left.at))
            .map((entry) => (
              <div key={entry.id} className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-white">{historyTypeLabel(entry.type)}</p>
                    <p className="mt-1 text-sm text-white/50">
                      {[visibleActorLabel(entry.actor), formatDecisionTimestamp(entry.at)].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <StatusChip status={chipStatus(entry.status || '')}>
                    {entry.status ? workflowStateLabel(entry.status) : workflowStateLabel(entry.workflowState)}
                  </StatusChip>
                </div>
                {entry.note ? <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-white/60">{entry.note}</p> : null}
              </div>
            ))}
        </div>
      )}
    </ShellPanel>
  );
}
