'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, CheckCircle2, MessageSquareText, XCircle } from 'lucide-react';

import MediaPreview from '@/frontend/components/media-preview';
import { useMarketingJobStatus } from '@/hooks/use-marketing-job-status';
import type {
  MarketingCampaignStatusHistoryEntry,
  MarketingCreativeAssetReviewPayload,
  MarketingStageReviewPayload,
} from '@/lib/api/marketing';

import { ActivityFeed, EmptyStatePanel, SectionLink, ShellPanel, StatusChip } from './components';

type WorkspaceView = 'brand' | 'strategy' | 'creative' | 'publish';

function isActiveJobStatus(status: string): boolean {
  return ['accepted', 'running', 'in_progress', 'ready', 'awaiting_approval', 'resumed', 'pending'].includes(
    (status || '').toLowerCase(),
  );
}

function workflowStateLabel(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
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

export default function AriesCampaignWorkspace(props: { campaignId: string; initialView?: WorkspaceView }) {
  const job = useMarketingJobStatus({ jobId: props.campaignId, autoLoad: true });
  const [notesByReviewId, setNotesByReviewId] = useState<Record<string, string>>({});
  const [busyByReviewId, setBusyByReviewId] = useState<Record<string, boolean>>({});
  const [briefSaving, setBriefSaving] = useState(false);

  const status = job.data && !('error' in job.data) ? job.data : null;
  const activeView = props.initialView || 'brand';

  useEffect(() => {
    if (!status || !isActiveJobStatus(status.marketing_job_status)) {
      return;
    }

    const timer = window.setInterval(() => {
      void job.load(props.campaignId, { quiet: true });
    }, 5000);

    return () => window.clearInterval(timer);
  }, [job.load, props.campaignId, status]);

  if (job.isLoading) {
    return <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-8 text-white/60">Loading campaign...</div>;
  }

  if (job.error) {
    return <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">{job.error.message}</div>;
  }

  if (!status) {
    return <EmptyStatePanel title="Campaign not found" description="This campaign could not be loaded from the current runtime state." />;
  }

  const campaignName = status.dashboard.campaign?.name || status.reviewBundle?.campaignName || status.tenantName || `Campaign ${status.jobId}`;
  const workflowState = status.workflowState;
  const currentHistory = status.statusHistory || [];

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
          actedBy: 'operator',
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
      window.alert(error instanceof Error ? error.message : 'Failed to save review decision.');
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
        throw new Error(payload.error || 'Failed to update campaign brief.');
      }

      await job.load(props.campaignId, { quiet: false });
    } finally {
      setBriefSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <ShellPanel eyebrow="Campaign" title={campaignName}>
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium tracking-[0.03em] ${workflowStateTone(workflowState)}`}>
              {workflowStateLabel(workflowState)}
            </span>
            <span className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-white/70">
              {status.campaignWindow?.start && status.campaignWindow?.end ? `${status.campaignWindow.start} - ${status.campaignWindow.end}` : 'Dates not scheduled yet'}
            </span>
            <span className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-white/70">
              {status.summary.headline}
            </span>
          </div>
          <p className="max-w-3xl text-sm leading-7 text-white/65">{status.summary.subheadline}</p>
          <div className="grid gap-4 md:grid-cols-4">
            <MetricCard label="Brand assets" value={String(status.campaignBrief?.brandAssets.length || 0)} />
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
          ['publish', 'Publish / Status'],
        ] as Array<[WorkspaceView, string]>).map(([view, label]) => (
          <Link
            key={view}
            href={currentStageHref(props.campaignId, view)}
            className={`rounded-full border px-4 py-2.5 text-sm font-medium transition ${
              activeView === view
                ? 'border-white/20 bg-white/[0.08] text-white'
                : 'border-white/8 bg-white/[0.03] text-white/55 hover:border-white/15 hover:text-white'
            }`}
          >
            {label}
          </Link>
        ))}
      </div>

      {activeView === 'brand' ? (
        <div className="space-y-4">
          {status.campaignBrief ? <BrandBriefCard brief={status.campaignBrief} saving={briefSaving} onSave={submitBriefUpdate} /> : null}
          <StageReviewSurface
            review={status.brandReview}
            emptyTitle="Brand review is not ready yet"
            emptyDescription="Website analysis, brand bible output, and uploaded brand assets will appear here when available."
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
          />
        </div>
      ) : null}

      {activeView === 'strategy' ? (
        <StageReviewSurface
          review={status.strategyReview}
          emptyTitle="Strategy review is not ready yet"
          emptyDescription="The campaign proposal and strategy packet will appear here when strategy output is available."
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
        />
      ) : null}

      {activeView === 'creative' ? (
        <CreativeReviewSurface
          review={status.creativeReview}
          notesByReviewId={notesByReviewId}
          busyByReviewId={busyByReviewId}
          setNote={(reviewId, value) => setNotesByReviewId((current) => ({ ...current, [reviewId]: value }))}
          onDecision={(reviewId, action) => void submitReviewDecision(reviewId, action, status.approval?.approvalId)}
        />
      ) : null}

      {activeView === 'publish' ? (
        <PublishStatusSurface
          workflowState={status.workflowState}
          publishBlockedReason={status.creativeReview?.publishBlockedReason || null}
          publishItems={status.dashboard.publishItems}
          history={currentHistory}
        />
      ) : null}

      <ShellPanel eyebrow="Shortcuts" title="Navigate the workflow">
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

  useEffect(() => {
    setWebsiteUrl(props.brief.websiteUrl);
    setBrandVoice(props.brief.brandVoice);
    setStyleVibe(props.brief.styleVibe);
    setVisualReferences(props.brief.visualReferences.join('\n'));
    setMustUseCopy(props.brief.mustUseCopy);
    setMustAvoidAesthetics(props.brief.mustAvoidAesthetics);
    setNotes(props.brief.notes);
  }, [props.brief]);

  async function handleSave() {
    const visualReferenceEntries = visualReferences.split('\n').map((item) => item.trim()).filter(Boolean);

    if (brandAssets.length > 0) {
      const formData = new FormData();
      formData.set('websiteUrl', websiteUrl.trim());
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
        websiteUrl: websiteUrl.trim(),
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
  }

  return (
    <ShellPanel eyebrow="Brief" title="Campaign intake">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm leading-7 text-white/65">
          Update the brief in place when brand voice, references, must-use copy, or revision notes change.
        </p>
        <div className="flex flex-wrap gap-3">
          {editing ? (
            <>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-full border border-white/12 px-4 py-2 text-sm text-white/75 transition hover:border-white/20 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={props.saving}
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
        <div className="grid gap-4 md:grid-cols-2">
          <EditableBriefField label="Website URL" value={websiteUrl} onChange={setWebsiteUrl} />
          <EditableBriefField label="Brand voice" multiline rows={4} value={brandVoice} onChange={setBrandVoice} />
          <EditableBriefField label="Style / vibe" multiline rows={4} value={styleVibe} onChange={setStyleVibe} />
          <EditableBriefField label="Visual references" multiline rows={5} value={visualReferences} onChange={setVisualReferences} />
          <EditableBriefField label="Must-use copy" multiline rows={4} value={mustUseCopy} onChange={setMustUseCopy} />
          <EditableBriefField label="Must-avoid aesthetics" multiline rows={4} value={mustAvoidAesthetics} onChange={setMustAvoidAesthetics} />
          <EditableBriefField label="Revision notes" multiline rows={5} value={notes} onChange={setNotes} className="md:col-span-2" />

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
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  rows?: number;
  className?: string;
}) {
  return (
    <label className={`rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4 block ${props.className || ''}`}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">{props.label}</p>
      {props.multiline ? (
        <textarea
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          rows={props.rows || 4}
          className="mt-3 w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-sm text-white placeholder:text-white/30"
        />
      ) : (
        <input
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          className="mt-3 w-full rounded-[1rem] border border-white/10 bg-black/20 px-4 py-3 text-sm text-white placeholder:text-white/30"
        />
      )}
    </label>
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

function StageReviewSurface(props: {
  review: MarketingStageReviewPayload | null;
  emptyTitle: string;
  emptyDescription: string;
  note: string;
  onNoteChange: (value: string) => void | null;
  busy: boolean;
  onApprove?: () => void;
  onChangesRequested?: () => void;
}) {
  if (!props.review) {
    return <EmptyStatePanel title={props.emptyTitle} description={props.emptyDescription} />;
  }

  return (
    <div className="space-y-4">
      <ShellPanel eyebrow={props.review.reviewType === 'brand' ? 'Brand Review' : 'Strategy Review'} title={props.review.title}>
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

      <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-4">
          {props.review.sections.map((section) => (
            <ShellPanel key={section.id} eyebrow="Content" title={section.title}>
              <div className="whitespace-pre-wrap text-sm leading-7 text-white/68">{section.body}</div>
            </ShellPanel>
          ))}
        </div>

        <div className="space-y-4">
          <ShellPanel eyebrow="Attachments" title="Generated artifacts">
            {props.review.attachments.length === 0 ? (
              <p className="text-sm text-white/55">No attachments yet.</p>
            ) : (
              <div className="space-y-3">
                {props.review.attachments.map((attachment) => (
                  <a key={attachment.id} href={attachment.url} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-4 rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4 text-sm text-white/80 transition hover:border-white/16 hover:text-white">
                    <span>{attachment.label}</span>
                    <ArrowUpRight className="h-4 w-4" />
                  </a>
                ))}
              </div>
            )}
          </ShellPanel>

          <ReviewDecisionCard
            note={props.note}
            onNoteChange={props.onNoteChange}
            busy={props.busy}
            onApprove={props.onApprove}
            onChangesRequested={props.onChangesRequested}
            placeholder={props.review.notePlaceholder}
          />

          <HistoryCard history={props.review.history} />
        </div>
      </div>
    </div>
  );
}

function CreativeReviewSurface(props: {
  review: { approvalComplete: boolean; approvedCount: number; pendingCount: number; rejectedCount: number; publishBlockedReason: string | null; assets: MarketingCreativeAssetReviewPayload[]; history: MarketingCampaignStatusHistoryEntry[] } | null;
  notesByReviewId: Record<string, string>;
  busyByReviewId: Record<string, boolean>;
  setNote: (reviewId: string, value: string) => void;
  onDecision: (reviewId: string, action: 'approve' | 'changes_requested' | 'reject') => void;
}) {
  if (!props.review) {
    return (
      <EmptyStatePanel
        title="Creative review is not ready yet"
        description="Reviewable assets will appear here when production outputs are available."
      />
    );
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
  publishBlockedReason: string | null;
  publishItems: Array<{ id: string; title: string; summary: string; status: string; platformLabel: string; destinationUrl: string | null }>;
  history: MarketingCampaignStatusHistoryEntry[];
}) {
  return (
    <div className="space-y-4">
      <ShellPanel eyebrow="Publish / Status" title="Truthful readiness and gating">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium tracking-[0.03em] ${workflowStateTone(props.workflowState)}`}>
              {workflowStateLabel(props.workflowState)}
            </span>
            <span className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-white/70">
              Publish remains gated until approvals are complete
            </span>
          </div>
          <p className="text-sm leading-7 text-white/65">
            {props.publishBlockedReason || 'All required approvals are complete. Publish-ready items can now move forward.'}
          </p>
        </div>
      </ShellPanel>

      <ShellPanel eyebrow="Publish queue" title="Visible publish items">
        {props.publishItems.length === 0 ? (
          <EmptyStatePanel compact title="No publish items yet" description="Publish packages and paused platform artifacts will appear here once the workflow reaches them." />
        ) : (
          <div className="space-y-3">
            {props.publishItems.map((item) => (
              <div key={item.id} className="rounded-[1.25rem] border border-white/8 bg-black/12 px-4 py-4">
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
              </div>
            ))}
          </div>
        )}
      </ShellPanel>

      <ShellPanel eyebrow="Status history" title="Workflow trail">
        <ActivityFeed items={props.history.map((entry) => ({ id: entry.id, label: workflowStateLabel(entry.type), detail: entry.note || workflowStateLabel(entry.workflowState), at: formatDecisionTimestamp(entry.at) }))} />
      </ShellPanel>
    </div>
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
}) {
  return (
    <ShellPanel eyebrow="Decision" title="Choose what happens next">
      <div className="space-y-4">
        <textarea
          value={props.note}
          onChange={(event) => props.onNoteChange(event.target.value.slice(0, 600))}
          placeholder={props.placeholder || 'Add context for the team'}
          className="w-full rounded-[1.25rem] border border-white/10 bg-black/15 px-4 py-3 text-sm text-white placeholder:text-white/30"
        />
        <div className="flex flex-wrap gap-3">
          {props.onApprove ? (
            <button
              type="button"
              onClick={props.onApprove}
              disabled={props.busy}
              className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#11161c] disabled:opacity-60"
            >
              <CheckCircle2 className="h-4 w-4" />
              {props.busy ? 'Saving...' : 'Approve'}
            </button>
          ) : null}
          {props.onChangesRequested ? (
            <button
              type="button"
              onClick={props.onChangesRequested}
              disabled={props.busy}
              className="inline-flex items-center gap-2 rounded-full border border-white/12 px-5 py-3 text-sm font-semibold text-white disabled:opacity-60"
            >
              <MessageSquareText className="h-4 w-4" />
              Request changes
            </button>
          ) : null}
          {props.onReject ? (
            <button
              type="button"
              onClick={props.onReject}
              disabled={props.busy}
              className="inline-flex items-center gap-2 rounded-full border border-rose-300/20 bg-rose-300/10 px-5 py-3 text-sm font-semibold text-rose-50 disabled:opacity-60"
            >
              <XCircle className="h-4 w-4" />
              Reject
            </button>
          ) : null}
        </div>
      </div>
    </ShellPanel>
  );
}

function HistoryCard(props: { history: MarketingCampaignStatusHistoryEntry[] }) {
  return (
    <ShellPanel eyebrow="History" title="Status history">
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
                    <p className="text-sm font-medium text-white">{workflowStateLabel(entry.type)}</p>
                    <p className="mt-1 text-sm text-white/50">
                      {entry.actor} · {formatDecisionTimestamp(entry.at)}
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
