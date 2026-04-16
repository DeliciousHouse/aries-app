'use client';

import Link from 'next/link';
import { ArrowRight, ExternalLink, FileImage, Globe, PauseCircle, Play, Send } from 'lucide-react';

import MediaPreview from '@/frontend/components/media-preview';
import { useRuntimePosts } from '@/hooks/use-runtime-posts';
import { safeHref } from '@/lib/safe-href';
import type {
  AriesDashboardAsset,
  AriesDashboardPost,
  AriesDashboardPublishItem,
  AriesItemStatus,
} from '@/lib/api/aries-v1';

import { customerSafeUiErrorMessage } from './customer-safe-copy';
import { EmptyStatePanel, LoadingStateGrid, ShellPanel, StatusChip } from './components';

type InventoryItem = {
  id: string
  kind: 'asset' | 'post' | 'publish'
  typeLabel: string
  title: string
  summary: string
  campaignName: string
  funnelLabel: string
  destinationUrl: string | null
  previewUrl: string | null
  previewContentType: string | null
  status: AriesItemStatus
  platformLabel: string
  provenanceLabel: string
}

const STATUS_ORDER: AriesItemStatus[] = [
  'ready_to_publish',
  'published_to_meta_paused',
  'ready',
  'scheduled',
  'live',
  'in_review',
  'draft',
]

function statusSectionTitle(status: AriesItemStatus): string {
  switch (status) {
    case 'ready_to_publish':
      return 'Ready to Publish'
    case 'published_to_meta_paused':
      return 'Published to Meta (Paused)'
    case 'ready':
      return 'Ready'
    case 'scheduled':
      return 'Scheduled'
    case 'live':
      return 'Live'
    case 'in_review':
      return 'In Review'
    default:
      return 'Draft'
  }
}

function provenanceLabel(sourceKind: InventoryItem['provenanceLabel'] | AriesDashboardAsset['provenance']['sourceKind']): string {
  if (sourceKind === 'live_platform') return 'Live platform'
  if (sourceKind === 'live_publish_result') return 'Publish result'
  if (sourceKind === 'publish_review') return 'Publish review'
  if (sourceKind === 'creative_output') return 'Creative output'
  return 'Proposal fallback'
}

function assetToInventory(asset: AriesDashboardAsset): InventoryItem {
  return {
    id: asset.id,
    kind: 'asset',
    typeLabel:
      asset.type === 'landing_page'
        ? 'Landing page'
        : asset.type === 'image_ad'
          ? 'Image ad'
          : asset.type === 'script' || asset.type === 'copy'
            ? 'Script / post'
            : 'Asset',
    title: asset.title,
    summary: asset.summary,
    campaignName: asset.campaignName,
    funnelLabel: asset.funnelStage || asset.objective,
    destinationUrl: asset.destinationUrl,
    previewUrl: asset.thumbnailUrl || asset.previewUrl,
    previewContentType: asset.contentType,
    status: asset.status,
    platformLabel: asset.platformLabel,
    provenanceLabel: provenanceLabel(asset.provenance.sourceKind),
  }
}

function postToInventory(post: AriesDashboardPost, assetsById: Map<string, AriesDashboardAsset>): InventoryItem {
  const previewAsset = post.previewAssetId ? assetsById.get(post.previewAssetId) : null
  return {
    id: post.id,
    kind: 'post',
    typeLabel: post.type === 'meta_ad' || post.type === 'pre_publish_ad' ? 'Ad / post' : 'Post concept',
    title: post.title,
    summary: post.summary,
    campaignName: post.campaignName,
    funnelLabel: post.funnelStage || post.objective,
    destinationUrl: post.destinationUrl,
    previewUrl: previewAsset?.thumbnailUrl || previewAsset?.previewUrl || null,
    previewContentType: previewAsset?.contentType || null,
    status: post.status,
    platformLabel: post.platformLabel,
    provenanceLabel: provenanceLabel(post.provenance.sourceKind),
  }
}

function publishToInventory(item: AriesDashboardPublishItem, assetsById: Map<string, AriesDashboardAsset>): InventoryItem {
  const previewAsset = item.previewAssetId ? assetsById.get(item.previewAssetId) : null
  return {
    id: item.id,
    kind: 'publish',
    typeLabel:
      item.type === 'meta_paused_ad'
        ? 'Paused Meta ad'
        : item.type === 'pre_publish_review'
          ? 'Pre-publish review'
          : 'Publish item',
    title: item.title,
    summary: item.summary,
    campaignName: item.campaignName,
    funnelLabel: item.funnelStage || item.objective,
    destinationUrl: item.destinationUrl,
    previewUrl: previewAsset?.thumbnailUrl || previewAsset?.previewUrl || null,
    previewContentType: previewAsset?.contentType || null,
    status: item.status,
    platformLabel: item.platformLabel,
    provenanceLabel: provenanceLabel(item.provenance.sourceKind),
  }
}

function previewCard(item: InventoryItem) {
  // Fall back to destinationUrl only if previewUrl is absent OR fails scheme
  // validation — keeps clickability while rejecting javascript:/data:/etc.
  const openHref = safeHref(item.previewUrl) || safeHref(item.destinationUrl)
  return (
    <MediaPreview
      src={item.previewUrl}
      alt={item.title}
      contentType={item.previewContentType}
      href={openHref}
      className="h-28 overflow-hidden rounded-[1.2rem] border border-white/8 bg-black/20"
      emptyLabel={item.kind === 'asset' ? 'Preview pending' : item.kind === 'publish' ? 'Publish preview pending' : 'Post preview pending'}
      nonImageLabel={item.kind === 'asset' ? 'Open asset preview' : item.kind === 'publish' ? 'Open publish package' : 'Open post preview'}
    />
  )
}

export default function AriesPostsScreen() {
  const posts = useRuntimePosts({ autoLoad: true })
  const data = posts.data

  if (posts.isLoading) {
    return <LoadingStateGrid />
  }

  if (posts.error) {
    return (
      <div className="rounded-[1.5rem] border border-red-500/20 bg-red-500/10 p-5 text-red-100">
        {customerSafeUiErrorMessage(posts.error.message, 'The publish inventory is not available right now.')}
      </div>
    )
  }

  if (!data || (data.campaigns.length === 0 && data.posts.length === 0 && data.assets.length === 0 && data.publishItems.length === 0)) {
    return (
      <EmptyStatePanel
        title="No publish-ready inventory yet"
        description="Proposal concepts, generated assets, review packages, and paused platform ads will appear here as soon as the workflow produces them."
      />
    )
  }

  const assetsById = new Map(data.assets.map((asset) => [asset.id, asset]))
  const inventory = [
    ...data.publishItems.map((item) => publishToInventory(item, assetsById)),
    ...data.posts.map((item) => postToInventory(item, assetsById)),
    ...data.assets.map((item) => assetToInventory(item)),
  ]

  const grouped = STATUS_ORDER
    .map((status) => ({
      status,
      items: inventory.filter((item) => item.status === status),
    }))
    .filter((group) => group.items.length > 0)

  const readyCount = data.statuses.countsByStatus.ready + data.statuses.countsByStatus.ready_to_publish
  const pausedCount = data.statuses.countsByStatus.published_to_meta_paused

  return (
    <div className="space-y-5">
      <ShellPanel
        eyebrow="Posts"
        title="Ready-to-publish inventory"
        action={
          <Link href="/dashboard/calendar" className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-primary">
            Open calendar
            <ArrowRight className="h-4 w-4 text-primary" />
          </Link>
        }
      >
        <div className="grid gap-4 md:grid-cols-4">
          <Metric label="Campaigns" value={String(data.campaigns.length)} detail="Visible from proposal through paused platform state." />
          <Metric label="Ready assets" value={String(readyCount)} detail="Images, scripts, and landing pages prepared for use." />
          <Metric label="Paused Meta ads" value={String(pausedCount)} detail="Created in Meta but intentionally not activated." />
          <Metric label="Publish items" value={String(data.publishItems.length)} detail="Pre-publish review and publish package entries." />
        </div>
      </ShellPanel>

      <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <ShellPanel eyebrow="Queue" title="What is ready now">
          <div className="space-y-3">
            {data.publishItems.length === 0 ? (
              <EmptyStatePanel compact title="No publish queue entries yet" description="Generated publish-review items and paused platform ads will appear here automatically." />
            ) : (
              data.publishItems.slice(0, 5).map((item) => (
                <div key={item.id} className="flex items-start justify-between gap-4 rounded-[1.2rem] border border-white/8 bg-black/15 px-4 py-4">
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-white">{item.title}</p>
                    <p className="text-sm text-white/55">{item.campaignName} · {item.platformLabel}</p>
                    <p className="text-sm text-white/45">{item.summary}</p>
                  </div>
                  <StatusChip status={item.status} />
                </div>
              ))
            )}
          </div>
        </ShellPanel>

        <ShellPanel eyebrow="Coverage" title="What this surface includes">
          <div className="space-y-3 text-sm leading-7 text-white/65">
            <p>Image ads ready for use, script and post assets, landing pages, pre-publish review items, and paused Meta ads all live here.</p>
            <p>The labels stay truthful. Planned work never appears as live, and paused Meta inventory is separated from scheduled or live platform activity.</p>
          </div>
        </ShellPanel>
      </div>

      {grouped.map((group) => (
        <ShellPanel key={group.status} eyebrow="Inventory" title={statusSectionTitle(group.status)}>
          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {group.items.map((item) => {
              // Validate hrefs once per item so the conditional rendering and
              // the anchor `href=` agree, and unsafe schemes are never rendered.
              const safePreviewHref = safeHref(item.previewUrl)
              const safeDestinationHref = safeHref(item.destinationUrl)
              return (
                <article key={item.id} className="overflow-hidden rounded-[1.6rem] border border-white/10 bg-white/[0.04]">
                  <div className="p-4">
                    {previewCard(item)}
                  </div>
                  <div className="space-y-4 border-t border-white/8 px-5 py-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">{item.typeLabel}</p>
                        <h3 className="text-lg font-semibold text-white">{item.title}</h3>
                        <p className="text-sm text-white/55">{item.campaignName} · {item.platformLabel}</p>
                      </div>
                      <StatusChip status={item.status} />
                    </div>

                    <p className="text-sm leading-6 text-white/60">{item.summary}</p>

                    <div className="space-y-2 text-sm text-white/55">
                      <div>{item.funnelLabel}</div>
                      <div>{item.provenanceLabel}</div>
                      {safePreviewHref ? (
                        <a
                          href={safePreviewHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 text-primary transition hover:text-primary/80"
                        >
                          {item.previewContentType === 'text/html' ? (
                            <Globe className="h-4 w-4" />
                          ) : item.previewContentType?.startsWith('video/') ? (
                            <Play className="h-4 w-4" />
                          ) : (
                            <FileImage className="h-4 w-4" />
                          )}
                          <span>
                            {item.kind === 'publish'
                              ? 'Open publish package'
                              : item.previewContentType?.startsWith('video/')
                                ? 'Open video preview'
                                : item.previewContentType === 'text/html'
                                  ? 'Open landing page'
                                  : 'Open asset preview'}
                          </span>
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      ) : null}
                      {safeDestinationHref ? (
                        <a
                          href={safeDestinationHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 text-white transition hover:text-white/75"
                        >
                          <Globe className="h-4 w-4 text-white/50" />
                          <span className="truncate">{safeDestinationHref}</span>
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      ) : !safePreviewHref ? (
                        <span className="inline-flex items-center gap-2">
                          {item.status === 'published_to_meta_paused' ? <PauseCircle className="h-4 w-4 text-white/50" /> : <Send className="h-4 w-4 text-white/50" />}
                          No preview or destination yet
                        </span>
                      ) : null}
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        </ShellPanel>
      ))}
    </div>
  )
}

function Metric(props: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-[1.25rem] border border-white/8 bg-white/[0.035] px-5 py-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">{props.label}</p>
      <p className="mt-3 text-3xl font-semibold text-white">{props.value}</p>
      <p className="mt-2 text-sm text-white/55">{props.detail}</p>
    </div>
  )
}
