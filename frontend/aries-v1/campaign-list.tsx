'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, FileImage, FileText, Layers3, Plus, Trash2, Undo2 } from 'lucide-react';

import MediaPreview from '@/frontend/components/media-preview';
import { useRuntimeCampaigns } from '@/hooks/use-runtime-campaigns';
import type {
  AriesDashboardAsset,
  AriesDashboardPost,
  RuntimeCampaignListItem,
} from '@/lib/api/aries-v1';

import { customerSafeUiErrorMessage } from './customer-safe-copy';
import { EmptyStatePanel, LoadingStateGrid, ShellPanel, StatusChip } from './components';

export default function AriesCampaignListScreen() {
  const campaigns = useRuntimeCampaigns({ autoLoad: true });
  const items = campaigns.data?.campaigns ?? [];
  const deletedItems = campaigns.data?.deletedCampaigns ?? [];

  if (campaigns.isLoading) {
    return <LoadingStateGrid />;
  }

  if (campaigns.error) {
    return (
      <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">
        {customerSafeUiErrorMessage(campaigns.error.message, 'Campaigns are not available right now.')}
      </div>
    );
  }

  if (items.length === 0 && deletedItems.length === 0) {
    return (
      <EmptyStatePanel
        title="No campaigns yet"
        description="Aries will turn your business and goals into a review-ready marketing plan once you create your first campaign."
        action={
          <Link
            href="/dashboard/campaigns/new"
            className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#11161c] transition-colors"
          >
            Create first campaign
            <ArrowRight className="h-4 w-4" />
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-5">
      <ShellPanel
        eyebrow="Campaigns"
        title="Every campaign in one place"
        action={
          <Link
            href="/dashboard/campaigns/new"
            className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-[#11161c] transition-colors"
          >
            <Plus className="h-4 w-4" />
            New campaign
          </Link>
        }
      >
        <p className="max-w-3xl text-sm leading-7 text-white/65">
          Review the current state of each campaign, open what needs attention, and jump directly into review, schedule, or results.
        </p>
      </ShellPanel>

      {campaigns.actionError ? (
        <div className="rounded-[1.25rem] border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
          {campaigns.actionError}
        </div>
      ) : null}

      <div className="grid gap-4">
        {items.map((campaign) => (
          <CampaignRow
            key={campaign.id}
            campaign={campaign}
            busyCampaignId={campaigns.busyCampaignId}
            onDelete={(jobId) => void campaigns.deleteCampaign(jobId)}
          />
        ))}
      </div>

      {deletedItems.length > 0 ? (
        <DeletedCampaignsSection
          items={deletedItems}
          busyCampaignId={campaigns.busyCampaignId}
          onRestore={(jobId) => void campaigns.restoreCampaign(jobId)}
        />
      ) : null}
    </div>
  );
}

function CampaignRow(props: {
  campaign: RuntimeCampaignListItem;
  busyCampaignId: string | null;
  onDelete: (jobId: string) => void;
}) {
  const { campaign } = props;
  const isBusy = props.busyCampaignId === campaign.jobId;

  return (
    <div className="rounded-[2rem] border border-white/10 bg-white/[0.04] px-6 py-5 transition hover:border-white/16 hover:bg-white/[0.06]">
      <div className="mb-4 flex items-start justify-between gap-3">
        <Link
          href={`/dashboard/campaigns/${campaign.id}`}
          className="flex-1 space-y-3"
        >
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-2xl font-semibold text-white">{campaign.name}</h2>
            <StatusChip status={campaign.dashboardStatus} />
          </div>
          <p className="text-sm leading-7 text-white/62">{campaign.summary}</p>
        </Link>
        <DeleteButton
          onConfirm={() => props.onDelete(campaign.jobId)}
          busy={isBusy}
          label="Delete campaign"
        />
      </div>

      <Link
        href={`/dashboard/campaigns/${campaign.id}`}
        className="block"
      >
        <div className="grid gap-5 xl:grid-cols-[1.15fr_0.9fr]">
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <CountPill icon={<Layers3 className="h-4 w-4" />} label="Posts" value={campaign.counts.posts} />
              <CountPill icon={<FileImage className="h-4 w-4" />} label="Image ads" value={campaign.counts.imageAds} />
              <CountPill icon={<FileText className="h-4 w-4" />} label="Scripts" value={campaign.counts.scripts} />
              <CountPill icon={<ArrowRight className="h-4 w-4" />} label="Publish items" value={campaign.counts.publishItems} />
            </div>

            <div className="grid gap-3 md:grid-cols-3 text-sm text-white/62">
              <InfoRow label="Objective" value={campaign.objective} />
              <InfoRow label="Funnel stage" value={campaign.funnelStage || 'Using campaign objective'} />
              <InfoRow label="Window" value={campaign.dateRange} />
              <InfoRow label="Next up" value={campaign.nextScheduled} />
              <InfoRow label="Pending approvals" value={String(campaign.pendingApprovals)} />
              <InfoRow label="Current stage" value={campaign.stageLabel} />
            </div>
          </div>

          <div className="space-y-4">
            <PreviewGroup
              title="Posts"
              items={campaign.previewPosts}
              assets={campaign.dashboard.assets}
              emptyLabel="Proposal concepts and generated posts will appear here."
            />
            <PreviewAssetGroup title="Assets" items={campaign.previewAssets} emptyLabel="Landing pages, image ads, and scripts will appear here." />
          </div>
        </div>
      </Link>
    </div>
  );
}

/** Two-step click destructive action: first press arms the button
 * ("Click again to confirm"), second press within 4s fires the callback.
 * The state auto-resets if the user doesn't confirm — lightweight friction
 * that prevents accidental clicks without a full modal. */
function DeleteButton(props: {
  onConfirm: () => void;
  busy: boolean;
  label: string;
}) {
  const [armed, setArmed] = useState(false);

  // Reset the armed state after 4s of inactivity so the button doesn't stay
  // primed indefinitely if the user clicks once and wanders off.
  function arm() {
    setArmed(true);
    window.setTimeout(() => setArmed(false), 4000);
  }

  if (props.busy) {
    return (
      <span
        aria-live="polite"
        className="inline-flex shrink-0 items-center gap-2 rounded-full border border-white/10 bg-black/20 px-4 py-2 text-xs font-semibold text-white/70"
      >
        <Trash2 className="h-4 w-4" />
        Deleting…
      </span>
    );
  }

  if (!armed) {
    return (
      <button
        type="button"
        onClick={arm}
        aria-label={props.label}
        className="inline-flex shrink-0 items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-xs font-semibold text-white/70 transition hover:border-red-400/40 hover:bg-red-500/10 hover:text-red-100"
      >
        <Trash2 className="h-4 w-4" />
        Delete
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setArmed(false);
        props.onConfirm();
      }}
      className="inline-flex shrink-0 items-center gap-2 rounded-full border border-red-400/60 bg-red-500/15 px-3 py-1.5 text-xs font-semibold text-red-100 transition hover:bg-red-500/25"
    >
      <Trash2 className="h-4 w-4" />
      Click again to confirm
    </button>
  );
}

function DeletedCampaignsSection(props: {
  items: RuntimeCampaignListItem[];
  busyCampaignId: string | null;
  onRestore: (jobId: string) => void;
}) {
  return (
    <ShellPanel
      eyebrow="Recycle bin"
      title={`Deleted campaigns (${props.items.length})`}
    >
      <p className="mb-4 text-sm leading-7 text-white/55">
        These campaigns have been soft-deleted and hidden from the main list. Restore any campaign to bring it back.
      </p>
      <div className="space-y-3">
        {props.items.map((campaign) => {
          const isBusy = props.busyCampaignId === campaign.jobId;
          return (
            <div
              key={campaign.id}
              className="flex flex-wrap items-center justify-between gap-4 rounded-[1.25rem] border border-white/10 bg-black/20 px-4 py-3"
            >
              <div className="space-y-1">
                <p className="text-sm font-medium text-white/85">{campaign.name}</p>
                <p className="text-xs text-white/45">
                  {campaign.deletedAt
                    ? `Deleted ${formatDeletedAt(campaign.deletedAt)}`
                    : 'Deleted'}
                </p>
              </div>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => props.onRestore(campaign.jobId)}
                className="inline-flex shrink-0 items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-2 text-xs font-semibold text-white/85 transition hover:border-white/25 hover:text-white disabled:opacity-60"
              >
                <Undo2 className="h-4 w-4" />
                {isBusy ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          );
        })}
      </div>
    </ShellPanel>
  );
}

function formatDeletedAt(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(parsed));
}

function InfoRow(props: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">{props.label}</p>
      <p className="mt-1 text-white/80">{props.value}</p>
    </div>
  );
}

function CountPill(props: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="inline-flex items-center gap-3 rounded-full border border-white/10 bg-black/18 px-4 py-3 text-sm text-white/75">
      <span className="text-white/50">{props.icon}</span>
      <span>{props.label}</span>
      <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs font-semibold text-white">{props.value}</span>
    </div>
  );
}

function PreviewGroup(props: { title: string; items: AriesDashboardPost[]; assets: AriesDashboardAsset[]; emptyLabel: string }) {
  const assetsById = new Map(props.assets.map((asset) => [asset.id, asset] as const));
  return (
    <div className="rounded-[1.4rem] border border-white/8 bg-black/15 px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">{props.title}</p>
      {props.items.length === 0 ? (
        <p className="mt-3 text-sm text-white/45">{props.emptyLabel}</p>
      ) : (
        <div className="mt-3 space-y-3">
          {props.items.slice(0, 3).map((item) => (
            <div key={item.id} className="rounded-[1rem] border border-white/8 bg-white/[0.035] px-4 py-3">
              <MediaPreview
                src={item.previewAssetId ? (assetsById.get(item.previewAssetId)?.thumbnailUrl || assetsById.get(item.previewAssetId)?.previewUrl) : null}
                alt={item.title}
                contentType={item.previewAssetId ? assetsById.get(item.previewAssetId)?.contentType || null : null}
                className="mb-3 h-24 overflow-hidden rounded-[0.9rem] border border-white/8 bg-black/20"
                emptyLabel="Post preview pending"
                nonImageLabel="Post preview available"
              />
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-white">{item.title}</p>
                  <p className="text-sm text-white/50">{item.platformLabel}</p>
                </div>
                <StatusChip status={item.status} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PreviewAssetGroup(props: { title: string; items: AriesDashboardAsset[]; emptyLabel: string }) {
  return (
    <div className="rounded-[1.4rem] border border-white/8 bg-black/15 px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">{props.title}</p>
      {props.items.length === 0 ? (
        <p className="mt-3 text-sm text-white/45">{props.emptyLabel}</p>
      ) : (
        <div className="mt-3 space-y-3">
          {props.items.slice(0, 3).map((item) => (
            <div key={item.id} className="rounded-[1rem] border border-white/8 bg-white/[0.035] px-4 py-3">
              <MediaPreview
                src={item.thumbnailUrl || item.previewUrl}
                alt={item.title}
                contentType={item.contentType}
                className="mb-3 h-24 overflow-hidden rounded-[0.9rem] border border-white/8 bg-black/20"
                emptyLabel="Asset preview pending"
                nonImageLabel={item.type === 'landing_page' ? 'Landing page preview available' : 'Asset preview available'}
              />
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-white">{item.title}</p>
                  <p className="text-sm text-white/50">{item.type.replace(/_/g, ' ')}</p>
                </div>
                <StatusChip status={item.status} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
