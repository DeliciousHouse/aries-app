import crypto from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { resolveCodePath } from '@/lib/runtime-paths'

import type { MarketingCampaignWindow } from './jobs-status'
import { extractPublishReviewBundle } from './publish-review'
import {
  asRecord,
  asString,
  asStringArray,
  loadMarketingJobRuntime,
  listMarketingJobIdsForTenant,
  type MarketingJobRuntimeDocument,
  type MarketingStage,
} from './runtime-state'

export type MarketingDashboardItemStatus =
  | 'draft'
  | 'in_review'
  | 'ready'
  | 'ready_to_publish'
  | 'published_to_meta_paused'
  | 'scheduled'
  | 'live'

export type MarketingDashboardSourceKind =
  | 'live_platform'
  | 'live_publish_result'
  | 'publish_review'
  | 'creative_output'
  | 'proposal'

export type MarketingDashboardAssetType =
  | 'landing_page'
  | 'image_ad'
  | 'script'
  | 'copy'
  | 'contract'
  | 'proposal_document'
  | 'review_package'
  | 'publish_package'

export type MarketingDashboardPostType =
  | 'platform_post'
  | 'meta_ad'
  | 'pre_publish_ad'
  | 'creative_output'
  | 'proposal_concept'

export type MarketingDashboardPublishItemType =
  | 'pre_publish_review'
  | 'publish_package'
  | 'meta_paused_ad'
  | 'scheduled_post'
  | 'live_post'

export type MarketingDashboardCampaignCompatibilityStatus =
  | 'draft'
  | 'in_review'
  | 'approved'
  | 'scheduled'
  | 'live'
  | 'changes_requested'

type MarketingDashboardProvenanceInternal = {
  sourceKind: MarketingDashboardSourceKind
  sourceStage: MarketingStage | 'runtime'
  sourceRunId: string | null
  sourcePath?: string | null
  isDerivedSchedule: boolean
  isPlatformNative: boolean
}

export type MarketingDashboardProvenance = Omit<MarketingDashboardProvenanceInternal, 'sourcePath'>

type MarketingDashboardAssetInternal = {
  id: string
  campaignId: string
  jobId: string
  type: MarketingDashboardAssetType
  title: string
  summary: string
  platform: string
  platformLabel: string
  campaignName: string
  funnelStage: string | null
  objective: string
  destinationUrl: string | null
  previewUrl: string | null
  thumbnailUrl: string | null
  contentType: string | null
  filePath: string | null
  status: MarketingDashboardItemStatus
  createdAt: string | null
  relatedPostIds: string[]
  relatedPublishItemIds: string[]
  provenance: MarketingDashboardProvenanceInternal
}

type MarketingDashboardPostInternal = {
  id: string
  campaignId: string
  jobId: string
  type: MarketingDashboardPostType
  title: string
  summary: string
  platform: string
  platformLabel: string
  campaignName: string
  funnelStage: string | null
  objective: string
  destinationUrl: string | null
  previewAssetId: string | null
  status: MarketingDashboardItemStatus
  createdAt: string | null
  conceptId: string | null
  relatedAssetIds: string[]
  relatedPublishItemIds: string[]
  provenance: MarketingDashboardProvenanceInternal
}

type MarketingDashboardPublishItemInternal = {
  id: string
  campaignId: string
  jobId: string
  type: MarketingDashboardPublishItemType
  title: string
  summary: string
  platform: string
  platformLabel: string
  campaignName: string
  funnelStage: string | null
  objective: string
  destinationUrl: string | null
  previewAssetId: string | null
  status: MarketingDashboardItemStatus
  createdAt: string | null
  relatedAssetIds: string[]
  relatedPostIds: string[]
  provenance: MarketingDashboardProvenanceInternal
}

type MarketingDashboardCalendarEventInternal = {
  id: string
  campaignId: string
  jobId: string
  title: string
  platform: string
  platformLabel: string
  startsAt: string
  endsAt: string | null
  status: MarketingDashboardItemStatus
  statusLabel: string
  campaignName: string
  funnelStage: string | null
  objective: string
  destinationUrl: string | null
  previewAssetId: string | null
  sourcePostId: string | null
  sourcePublishItemId: string | null
  provenance: MarketingDashboardProvenanceInternal
}

type MarketingDashboardCampaignInternal = {
  id: string
  jobId: string
  externalCampaignId: string
  name: string
  objective: string
  funnelStage: string | null
  summary: string
  stageLabel: string
  status: MarketingDashboardItemStatus
  compatibilityStatus: MarketingDashboardCampaignCompatibilityStatus
  campaignWindow: MarketingCampaignWindow | null
  updatedAt: string | null
  approvalRequired: boolean
  approvalActionHref?: string
  previewPostIds: string[]
  previewAssetIds: string[]
  postIds: string[]
  assetIds: string[]
  publishItemIds: string[]
  calendarEventIds: string[]
  counts: {
    posts: number
    landingPages: number
    imageAds: number
    scripts: number
    publishItems: number
    proposalConcepts: number
    ready: number
    readyToPublish: number
    pausedMetaAds: number
    scheduled: number
    live: number
  }
  provenance: MarketingDashboardProvenanceInternal
}

export type MarketingDashboardAsset = Omit<MarketingDashboardAssetInternal, 'filePath' | 'provenance'> & {
  provenance: MarketingDashboardProvenance
}

export type MarketingDashboardPost = Omit<MarketingDashboardPostInternal, 'provenance'> & {
  provenance: MarketingDashboardProvenance
}

export type MarketingDashboardPublishItem = Omit<MarketingDashboardPublishItemInternal, 'provenance'> & {
  provenance: MarketingDashboardProvenance
}

export type MarketingDashboardCalendarEvent = Omit<MarketingDashboardCalendarEventInternal, 'provenance'> & {
  provenance: MarketingDashboardProvenance
}

export type MarketingDashboardCampaign = Omit<MarketingDashboardCampaignInternal, 'provenance'> & {
  provenance: MarketingDashboardProvenance
}

export type MarketingDashboardStatusSummary = {
  countsByStatus: Record<MarketingDashboardItemStatus, number>
}

type MarketingDashboardContentInternal = {
  campaigns: MarketingDashboardCampaignInternal[]
  posts: MarketingDashboardPostInternal[]
  assets: MarketingDashboardAssetInternal[]
  publishItems: MarketingDashboardPublishItemInternal[]
  calendarEvents: MarketingDashboardCalendarEventInternal[]
  statuses: MarketingDashboardStatusSummary
}

export type MarketingDashboardContent = {
  campaigns: MarketingDashboardCampaign[]
  posts: MarketingDashboardPost[]
  assets: MarketingDashboardAsset[]
  publishItems: MarketingDashboardPublishItem[]
  calendarEvents: MarketingDashboardCalendarEvent[]
  statuses: MarketingDashboardStatusSummary
}

export type MarketingDashboardCampaignContent = {
  campaign: MarketingDashboardCampaign | null
  posts: MarketingDashboardPost[]
  assets: MarketingDashboardAsset[]
  publishItems: MarketingDashboardPublishItem[]
  calendarEvents: MarketingDashboardCalendarEvent[]
  statuses: MarketingDashboardStatusSummary
}

export type MarketingDashboardBuildOptions = {
  referenceDate?: Date
}

type CandidateAsset = Omit<MarketingDashboardAssetInternal, 'relatedPostIds' | 'relatedPublishItemIds'>

type CandidatePost = Omit<MarketingDashboardPostInternal, 'id' | 'relatedPublishItemIds'> & {
  dedupeKey: string
  relatedPublishItemIds?: string[]
}

type CandidatePublishItem = Omit<MarketingDashboardPublishItemInternal, 'id' | 'relatedPostIds'>

type CandidateCalendarSeed = {
  entityId: string
  campaignId: string
  jobId: string
  title: string
  platform: string
  platformLabel: string
  destinationUrl: string | null
  previewAssetId: string | null
  sourcePostId: string | null
  sourcePublishItemId: string | null
  status: MarketingDashboardItemStatus
  startsAt: string | null
  endsAt: string | null
  sortPriority: number
  provenance: MarketingDashboardProvenanceInternal
}

type SourcePriority = 1 | 2 | 3 | 4 | 5

type ProposalPlan = {
  campaignName: string | null
  objective: string | null
  primaryCta: string | null
  audience: string | null
  coreMessage: string | null
  offer: string | null
  channelPlans: Array<Record<string, unknown>>
  brandSlug: string | null
  campaignId: string | null
  createdAt: string | null
}

type ContractRecord = {
  filePath: string
  payload: Record<string, unknown>
}

type CampaignBuildContext = {
  jobId: string
  runtimeDoc: MarketingJobRuntimeDocument
  status: DashboardStatusSnapshot
  referenceDate: Date
  proposal: ProposalPlan
  brandSlug: string
  externalCampaignId: string
  campaignName: string
  objective: string
  funnelStage: string | null
  campaignRoot: string | null
  outputRoots: string[]
}

type DashboardStatusSnapshot = {
  tenantName: string | null
  brandWebsiteUrl: string | null
  campaignWindow: MarketingCampaignWindow | null
  currentStage: string | null
  updatedAt: string | null
  approvalRequired: boolean
  approvalActionHref?: string
  summary: {
    headline: string
    subheadline: string
  }
  reviewCampaignName: string | null
}

const ITEM_STATUS_PRIORITY: Record<MarketingDashboardItemStatus, number> = {
  draft: 0,
  in_review: 1,
  ready: 2,
  ready_to_publish: 3,
  published_to_meta_paused: 4,
  scheduled: 5,
  live: 6,
}

const PUBLISHER_STEPS = [
  'meta_ads_publisher',
  'instagram_publisher',
  'x_publisher',
  'tiktok_publisher',
  'youtube_publisher',
  'linkedin_publisher',
  'reddit_publisher',
] as const

const FALLBACK_HOURS = [10, 13, 16] as const

function stableHash(value: unknown): string {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex')
}

function slugify(value: string, fallback = 'item'): string {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || fallback
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ')
}

function stringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return fallback
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    : []
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim())))
}

function uniqueIds(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function nowReference(referenceDate?: Date): Date {
  return referenceDate ? new Date(referenceDate) : new Date()
}

function startOfUtcWeek(referenceDate: Date): Date {
  const date = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), referenceDate.getUTCDate()))
  const day = date.getUTCDay()
  const shift = day === 0 ? -6 : 1 - day
  date.setUTCDate(date.getUTCDate() + shift)
  return date
}

function startOfUtcMonth(referenceDate: Date): Date {
  return new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), 1))
}

function addUtcDays(date: Date, days: number): Date {
  const copy = new Date(date)
  copy.setUTCDate(copy.getUTCDate() + days)
  return copy
}

function setUtcHour(date: Date, hour: number): Date {
  const copy = new Date(date)
  copy.setUTCHours(hour, 0, 0, 0)
  return copy
}

function formatDateRange(window: MarketingCampaignWindow | null): string {
  if (window?.start && window.end) {
    return `${window.start} - ${window.end}`
  }
  return 'Dates not scheduled yet'
}

function nextScheduledText(event: MarketingDashboardCalendarEventInternal | null): string {
  if (!event) {
    return 'Nothing scheduled yet'
  }
  return `${event.startsAt} · ${event.statusLabel}${event.platformLabel ? ` · ${event.platformLabel}` : ''}`
}

function compatibilityStatusFor(itemStatus: MarketingDashboardItemStatus): MarketingDashboardCampaignCompatibilityStatus {
  switch (itemStatus) {
    case 'live':
      return 'live'
    case 'scheduled':
      return 'scheduled'
    case 'published_to_meta_paused':
    case 'ready_to_publish':
    case 'ready':
      return 'approved'
    case 'in_review':
      return 'in_review'
    default:
      return 'draft'
  }
}

function contentTypeForAsset(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.svg':
      return 'image/svg+xml'
    case '.html':
      return 'text/html; charset=utf-8'
    case '.md':
    case '.txt':
      return 'text/plain; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

function buildAssetUrl(jobId: string, assetId: string): string {
  return `/api/marketing/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(assetId)}`
}

function sourcePriority(kind: MarketingDashboardSourceKind): SourcePriority {
  if (kind === 'live_platform') return 1
  if (kind === 'live_publish_result') return 2
  if (kind === 'publish_review') return 3
  if (kind === 'creative_output') return 4
  return 5
}

function explicitSourcePriority(value: SourcePriority): number {
  return value
}

function statusLabel(status: MarketingDashboardItemStatus): string {
  switch (status) {
    case 'live':
      return 'Live'
    case 'scheduled':
      return 'Scheduled'
    case 'published_to_meta_paused':
      return 'Published to Meta (Paused)'
    case 'ready_to_publish':
      return 'Ready to Publish'
    case 'ready':
      return 'Awaiting Schedule'
    default:
      return 'Planned'
  }
}

function rawPublishReviewBundle(runtimeDoc: MarketingJobRuntimeDocument): Record<string, unknown> | null {
  return extractPublishReviewBundle(runtimeDoc)
}

function envCacheRoot(stage: 1 | 2 | 3 | 4): string {
  const envKey =
    stage === 1
      ? 'LOBSTER_STAGE1_CACHE_DIR'
      : stage === 2
        ? 'LOBSTER_STAGE2_CACHE_DIR'
        : stage === 3
          ? 'LOBSTER_STAGE3_CACHE_DIR'
          : 'LOBSTER_STAGE4_CACHE_DIR'
  const fallback =
    stage === 1
      ? 'lobster-stage1-cache'
      : stage === 2
        ? 'lobster-stage2-cache'
        : stage === 3
          ? 'lobster-stage3-cache'
          : 'lobster-stage4-cache'
  return process.env[envKey]?.trim() || path.join(tmpdir(), fallback)
}

function stageFolder(stage: 1 | 2 | 3 | 4): string {
  if (stage === 1) return 'stage-1-research'
  if (stage === 2) return 'stage-2-strategy'
  if (stage === 3) return 'stage-3-production'
  return 'stage-4-publish-optimize'
}

function lobsterRoots(): string[] {
  return uniqueStrings([
    process.env.OPENCLAW_LOBSTER_CWD,
    resolveCodePath('lobster'),
  ]).map((root) => path.resolve(root))
}

function lobsterOutputRoots(): string[] {
  return lobsterRoots().map((root) => path.join(root, 'output'))
}

function readJsonIfExists(filePath: string | null | undefined): Record<string, unknown> | null {
  if (!filePath || !existsSync(filePath)) {
    return null
  }
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function readTextIfExists(filePath: string | null | undefined): string | null {
  if (!filePath || !existsSync(filePath)) {
    return null
  }
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

function listFiles(directoryPath: string | null | undefined, predicate?: (fileName: string) => boolean): string[] {
  if (!directoryPath || !existsSync(directoryPath)) {
    return []
  }
  try {
    return readdirSync(directoryPath)
      .filter((fileName) => (predicate ? predicate(fileName) : true))
      .map((fileName) => path.join(directoryPath, fileName))
  } catch {
    return []
  }
}

function readStageStepPayload(stage: 1 | 2 | 3 | 4, runId: string | null, stepName: string): Record<string, unknown> | null {
  if (!runId) {
    return null
  }

  const cachePath = path.join(envCacheRoot(stage), runId, `${stepName}.json`)
  const cached = readJsonIfExists(cachePath)
  if (cached) {
    return cached
  }

  for (const outputRoot of lobsterOutputRoots()) {
    const logPath = path.join(outputRoot, 'logs', runId, stageFolder(stage), `${stepName}.json`)
    const logged = readJsonIfExists(logPath)
    if (logged) {
      return logged
    }
  }

  return null
}

function normalizePlatformSlug(value: string | null | undefined): string {
  const cleaned = slugify(value || '', 'campaign')
  if (['meta', 'facebook', 'facebook-ads', 'meta-ads'].includes(cleaned)) return 'meta-ads'
  if (['instagram', 'instagram-feed', 'instagram-reels'].includes(cleaned)) return 'instagram'
  if (['x', 'twitter', 'x-post'].includes(cleaned)) return 'x'
  if (['youtube', 'youtube-shorts', 'youtube-longform'].includes(cleaned)) return 'youtube'
  if (['linkedin', 'linkedin-video'].includes(cleaned)) return 'linkedin'
  if (['landing-page', 'landing-page-campaign', 'landing'].includes(cleaned)) return 'landing-page'
  if (['short-video', 'video', 'tiktok', 'stories', 'instagram-feed-video'].includes(cleaned)) {
    return cleaned === 'tiktok' ? 'tiktok' : 'video'
  }
  return cleaned
}

function platformLabel(platformSlug: string): string {
  if (platformSlug === 'meta-ads') return 'Meta Ads'
  if (platformSlug === 'landing-page') return 'Landing Page'
  if (platformSlug === 'tiktok') return 'TikTok'
  if (platformSlug === 'x') return 'X'
  return titleCase(platformSlug)
}

function extractBrandSlug(runtimeDoc: MarketingJobRuntimeDocument, planner: ProposalPlan): string {
  if (planner.brandSlug) {
    return planner.brandSlug
  }

  const runtimeBrand = stringValue(runtimeDoc.brand_kit?.brand_name)
  if (runtimeBrand) {
    return slugify(runtimeBrand, 'campaign')
  }

  const website = stringValue(runtimeDoc.inputs.brand_url)
  if (website) {
    try {
      const url = new URL(website)
      return slugify(url.hostname.replace(/^www\./, ''), 'campaign')
    } catch {}
  }

  return slugify(runtimeDoc.tenant_id || runtimeDoc.job_id, 'campaign')
}

function parseProposalPlan(runtimeDoc: MarketingJobRuntimeDocument): ProposalPlan {
  const planner = readStageStepPayload(2, runtimeDoc.stages.strategy.run_id, 'campaign_planner')
  const plan = recordValue(planner?.campaign_plan) ?? {}
  const brandProfiles = recordValue(planner?.brand_profiles_record) ?? {}
  return {
    campaignName: stringValue(plan.campaign_name) || null,
    objective: stringValue(plan.objective) || null,
    primaryCta: stringValue(plan.primary_cta) || null,
    audience: stringValue(plan.audience) || null,
    coreMessage: stringValue(plan.core_message) || null,
    offer: stringValue(plan.offer) || null,
    channelPlans: recordArray(plan.channel_plans),
    brandSlug: stringValue(planner?.brand_slug || brandProfiles.brand_slug) || null,
    campaignId: stringValue(plan.campaign_name) || null,
    createdAt: stringValue(brandProfiles.created_at || planner?.created_at) || null,
  }
}

function extractCampaignName(runtimeDoc: MarketingJobRuntimeDocument, status: DashboardStatusSnapshot, proposal: ProposalPlan): string {
  return (
    status.reviewCampaignName ||
    proposal.campaignName ||
    status.tenantName ||
    runtimeDoc.brand_kit?.brand_name ||
    `Campaign ${runtimeDoc.job_id}`
  )
}

function extractObjective(status: DashboardStatusSnapshot, proposal: ProposalPlan): string {
  return proposal.objective || status.summary.headline || 'Campaign in progress'
}

function extractFunnelStage(...values: unknown[]): string | null {
  for (const value of values) {
    const text = stringValue(value)
    if (text && /(awareness|consideration|conversion|top of funnel|middle of funnel|bottom of funnel|tof|mof|bof)/i.test(text)) {
      return text
    }
  }
  return null
}

function extractCampaignId(runtimeDoc: MarketingJobRuntimeDocument, proposal: ProposalPlan): string {
  if (proposal.campaignId) {
    return proposal.campaignId
  }

  const publishBundle = rawPublishReviewBundle(runtimeDoc)
  const reviewCampaignName = stringValue(publishBundle?.campaign_id || publishBundle?.campaign_name)
  if (reviewCampaignName) {
    return slugify(reviewCampaignName, runtimeDoc.job_id)
  }

  return runtimeDoc.job_id
}

function campaignRootForBrand(brandSlug: string): string | null {
  for (const outputRoot of lobsterOutputRoots()) {
    const candidate = path.join(outputRoot, `${brandSlug}-campaign`)
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return lobsterOutputRoots()[0] ? path.join(lobsterOutputRoots()[0], `${brandSlug}-campaign`) : null
}

function proposalDocumentPaths(brandSlug: string): string[] {
  const files: string[] = []
  for (const outputRoot of lobsterOutputRoots()) {
    files.push(path.join(outputRoot, `${brandSlug}-campaign-proposal.md`))
    files.push(path.join(outputRoot, `${brandSlug}-campaign-proposal.html`))
  }
  return files
}

function extractTitleFromCopyPayload(filePath: string | null | undefined): string | null {
  const payload = readJsonIfExists(filePath)
  if (payload) {
    return stringValue(payload.headline || payload.title || payload.hook) || null
  }

  const text = readTextIfExists(filePath)
  if (!text) {
    return null
  }

  const heading = text.split('\n').find((line) => line.trim().startsWith('#'))
  return heading ? heading.replace(/^#+\s*/, '').trim() : null
}

function extractSummaryFromCopyPayload(filePath: string | null | undefined): string {
  const payload = readJsonIfExists(filePath)
  if (payload) {
    const bodyLines = asStringArray(payload.body_lines)
    if (bodyLines.length > 0) {
      return bodyLines.slice(0, 2).join(' ')
    }
    return stringValue(payload.summary || payload.caption || payload.description)
  }

  const text = readTextIfExists(filePath)
  if (!text) {
    return ''
  }

  return text
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .filter(Boolean)
    .slice(1, 3)
    .join(' ')
}

function extractDestinationUrl(runtimeDoc: MarketingJobRuntimeDocument, contractPayload: Record<string, unknown> | null): string | null {
  const slug = stringValue(recordValue(contractPayload?.landing_page)?.slug)
  const brandUrl = stringValue(runtimeDoc.inputs.brand_url || runtimeDoc.brand_kit?.source_url)
  if (slug && brandUrl) {
    try {
      return new URL(slug, brandUrl).toString()
    } catch {}
  }
  if (slug) {
    return slug
  }
  return brandUrl || null
}

function isProductionReady(runtimeDoc: MarketingJobRuntimeDocument): boolean {
  return runtimeDoc.stages.production.status === 'completed' || runtimeDoc.stages.publish.status !== 'not_started'
}

function proposalStatus(runtimeDoc: MarketingJobRuntimeDocument): MarketingDashboardItemStatus {
  if (runtimeDoc.approvals.current?.stage === 'strategy') {
    return 'in_review'
  }
  if (runtimeDoc.stages.strategy.status === 'completed' || runtimeDoc.stages.production.status !== 'not_started') {
    return 'ready'
  }
  return 'draft'
}

function creativeStatus(runtimeDoc: MarketingJobRuntimeDocument): MarketingDashboardItemStatus {
  if (runtimeDoc.approvals.current?.stage === 'production') {
    return 'in_review'
  }
  if (isProductionReady(runtimeDoc)) {
    return 'ready'
  }
  return 'draft'
}

function publishReadyStatus(runtimeDoc: MarketingJobRuntimeDocument): MarketingDashboardItemStatus {
  if (runtimeDoc.approvals.current?.stage === 'publish') {
    return 'ready_to_publish'
  }
  if (runtimeDoc.stages.publish.status === 'completed') {
    return 'ready_to_publish'
  }
  return 'ready'
}

function campaignProvenance(kind: MarketingDashboardSourceKind, stage: MarketingStage | 'runtime', runtimeDoc: MarketingJobRuntimeDocument): MarketingDashboardProvenanceInternal {
  return {
    sourceKind: kind,
    sourceStage: stage,
    sourceRunId:
      stage === 'strategy'
        ? runtimeDoc.stages.strategy.run_id
        : stage === 'production'
          ? runtimeDoc.stages.production.run_id
          : stage === 'publish'
            ? runtimeDoc.stages.publish.run_id
            : runtimeDoc.current_stage === 'research'
              ? runtimeDoc.stages.research.run_id
              : runtimeDoc.stages.publish.run_id,
    isDerivedSchedule: false,
    isPlatformNative: kind === 'live_platform',
  }
}

function makeAssetId(jobId: string, prefix: string, key: string): string {
  return `${prefix}-${slugify(path.basename(key, path.extname(key)) || prefix, prefix)}-${stableHash([jobId, prefix, key]).slice(0, 8)}`
}

function sanitizeProvenance(provenance: MarketingDashboardProvenanceInternal): MarketingDashboardProvenance {
  return {
    sourceKind: provenance.sourceKind,
    sourceStage: provenance.sourceStage,
    sourceRunId: provenance.sourceRunId,
    isDerivedSchedule: provenance.isDerivedSchedule,
    isPlatformNative: provenance.isPlatformNative,
  }
}

function sanitizeAsset(asset: MarketingDashboardAssetInternal): MarketingDashboardAsset {
  const { filePath: _filePath, provenance, ...rest } = asset
  return { ...rest, provenance: sanitizeProvenance(provenance) }
}

function sanitizePost(post: MarketingDashboardPostInternal): MarketingDashboardPost {
  const { provenance, ...rest } = post
  return { ...rest, provenance: sanitizeProvenance(provenance) }
}

function sanitizePublishItem(item: MarketingDashboardPublishItemInternal): MarketingDashboardPublishItem {
  const { provenance, ...rest } = item
  return { ...rest, provenance: sanitizeProvenance(provenance) }
}

function sanitizeCalendarEvent(event: MarketingDashboardCalendarEventInternal): MarketingDashboardCalendarEvent {
  const { provenance, ...rest } = event
  return { ...rest, provenance: sanitizeProvenance(provenance) }
}

function sanitizeCampaign(campaign: MarketingDashboardCampaignInternal): MarketingDashboardCampaign {
  const { provenance, ...rest } = campaign
  return { ...rest, provenance: sanitizeProvenance(provenance) }
}

function deriveSourceTimestamp(...values: unknown[]): string | null {
  for (const value of values) {
    const text = stringValue(value)
    if (text && Number.isFinite(Date.parse(text))) {
      return text
    }
  }
  return null
}

function contractFilePaths(explicitPaths: string[], directoryPath: string | null): string[] {
  const jsonFiles = directoryPath
    ? listFiles(directoryPath, (fileName) => fileName.endsWith('.json') && !fileName.startsWith('master-') && fileName !== 'platform-index.json')
    : []
  return uniqueStrings([...explicitPaths, ...jsonFiles])
}

function loadContracts(explicitPaths: string[], directoryPath: string | null): ContractRecord[] {
  return contractFilePaths(explicitPaths, directoryPath)
    .map((filePath) => {
      const payload = readJsonIfExists(filePath)
      return payload ? { filePath, payload } : null
    })
    .filter((entry): entry is ContractRecord => !!entry)
}

function extractPlatformFromFilename(filePath: string): string {
  const base = slugify(path.basename(filePath, path.extname(filePath)), 'asset')
  if (base.startsWith('meta')) return 'meta-ads'
  if (base.startsWith('instagram')) return 'instagram'
  if (base.startsWith('tiktok')) return 'tiktok'
  if (base.startsWith('youtube')) return 'youtube'
  if (base.startsWith('linkedin')) return 'linkedin'
  if (base.startsWith('reddit')) return 'reddit'
  if (base.startsWith('x')) return 'x'
  if (base.startsWith('landing')) return 'landing-page'
  if (base.includes('video')) return 'video'
  if (base.includes('script')) return 'video'
  return 'campaign'
}

function isPausedPublishResult(value: unknown): boolean {
  const text = JSON.stringify(value).toUpperCase()
  return text.includes('PAUSED')
}

function isLivePublishResult(value: unknown): boolean {
  const text = JSON.stringify(value).toLowerCase()
  return text.includes('"status":"live"') || text.includes('"publish_status":"live"')
}

function scheduledTimestamp(value: Record<string, unknown> | null): string | null {
  return deriveSourceTimestamp(
    value?.scheduled_for,
    value?.scheduledAt,
    value?.schedule_time,
    value?.publish_at,
    value?.published_at,
    value?.created_at,
  )
}

function summaryFromStatus(context: CampaignBuildContext): string {
  return context.status.summary.subheadline || context.proposal.coreMessage || 'Campaign status is available for review.'
}

function buildCampaignWindowSnapshot(runtimeDoc: MarketingJobRuntimeDocument): MarketingCampaignWindow | null {
  const reviewBundle = rawPublishReviewBundle(runtimeDoc)
  const summary = recordValue(reviewBundle?.summary)
  const campaignWindow = recordValue(summary?.campaign_window)
  const start = stringValue(campaignWindow?.start) || null
  const end = stringValue(campaignWindow?.end) || null
  if (!start && !end) {
    return null
  }
  return { start, end }
}

function buildStatusSnapshot(runtimeDoc: MarketingJobRuntimeDocument, proposal: ProposalPlan): DashboardStatusSnapshot {
  const reviewBundle = rawPublishReviewBundle(runtimeDoc)
  const summaryHeadline =
    proposal.objective ||
    stringValue(runtimeDoc.summary?.headline) ||
    stringValue(recordValue(reviewBundle?.summary)?.core_message) ||
    'Campaign in progress'
  const summarySubheadline =
    stringValue(runtimeDoc.summary?.subheadline) ||
    stringValue(recordValue(reviewBundle?.summary)?.offer_summary) ||
    proposal.coreMessage ||
    'Campaign status is available for review.'
  const approvalActionHref = runtimeDoc.approvals.current ? `/marketing/job-approve?jobId=${encodeURIComponent(runtimeDoc.job_id)}` : undefined

  return {
    tenantName: runtimeDoc.brand_kit?.brand_name || null,
    brandWebsiteUrl: runtimeDoc.brand_kit?.source_url || runtimeDoc.inputs.brand_url || null,
    campaignWindow: buildCampaignWindowSnapshot(runtimeDoc),
    currentStage: runtimeDoc.current_stage || null,
    updatedAt: runtimeDoc.updated_at || null,
    approvalRequired: !!runtimeDoc.approvals.current,
    approvalActionHref,
    summary: {
      headline: summaryHeadline,
      subheadline: summarySubheadline,
    },
    reviewCampaignName: stringValue(reviewBundle?.campaign_name) || null,
  }
}

function createEmptyStatusSummary(): MarketingDashboardStatusSummary {
  return {
    countsByStatus: {
      draft: 0,
      in_review: 0,
      ready: 0,
      ready_to_publish: 0,
      published_to_meta_paused: 0,
      scheduled: 0,
      live: 0,
    },
  }
}

function incrementStatus(summary: MarketingDashboardStatusSummary, status: MarketingDashboardItemStatus) {
  summary.countsByStatus[status] += 1
}

function calendarSeedsToEvents(
  seeds: CandidateCalendarSeed[],
  window: MarketingCampaignWindow | null,
  referenceDate: Date,
): MarketingDashboardCalendarEventInternal[] {
  if (seeds.length === 0) {
    return []
  }

  const sortedSeeds = seeds
    .slice()
    .sort((left, right) => left.sortPriority - right.sortPriority || left.entityId.localeCompare(right.entityId))

  const fallbackCount = sortedSeeds.filter((seed) => !seed.startsAt).length
  const weekBase = startOfUtcWeek(referenceDate)
  const monthBase = startOfUtcMonth(referenceDate)
  const start = window?.start && Number.isFinite(Date.parse(window.start)) ? new Date(window.start) : null
  const end = window?.end && Number.isFinite(Date.parse(window.end)) ? new Date(window.end) : null
  const totalWindowDays =
    start && end && end.getTime() >= start.getTime()
      ? Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1
      : null

  let derivedIndex = 0

  return sortedSeeds.map((seed, index) => {
    let startsAt = seed.startsAt
    if (!startsAt) {
      let baseDate: Date
      let dayOffset = 0
      const slot = FALLBACK_HOURS[derivedIndex % FALLBACK_HOURS.length]

      if (start && totalWindowDays && totalWindowDays > 0) {
        baseDate = start
        dayOffset = fallbackCount <= 1 ? 0 : Math.min(totalWindowDays - 1, Math.floor((derivedIndex * totalWindowDays) / fallbackCount))
      } else if (fallbackCount <= 7) {
        baseDate = weekBase
        dayOffset = Math.min(6, derivedIndex)
      } else {
        const daysInMonth = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth() + 1, 0)).getUTCDate()
        baseDate = monthBase
        dayOffset = fallbackCount <= 1 ? 0 : Math.min(daysInMonth - 1, Math.floor((derivedIndex * daysInMonth) / fallbackCount))
      }

      startsAt = setUtcHour(addUtcDays(baseDate, dayOffset), slot).toISOString()
      derivedIndex += 1
    }

    return {
      id: `${seed.campaignId}::calendar::${slugify(seed.title || seed.entityId, 'event')}-${index + 1}`,
      campaignId: seed.campaignId,
      jobId: seed.jobId,
      title: seed.title,
      platform: seed.platform,
      platformLabel: seed.platformLabel,
      startsAt,
      endsAt: seed.endsAt,
      status: seed.status,
      statusLabel: statusLabel(seed.status),
      campaignName: '',
      funnelStage: null,
      objective: '',
      destinationUrl: seed.destinationUrl,
      previewAssetId: seed.previewAssetId,
      sourcePostId: seed.sourcePostId,
      sourcePublishItemId: seed.sourcePublishItemId,
      provenance: {
        ...seed.provenance,
        isDerivedSchedule: !seed.startsAt || seed.provenance.isDerivedSchedule,
      },
    }
  })
}

function buildLivePlatformEvents(
  context: CampaignBuildContext,
): CandidateCalendarSeed[] {
  const publishStage = context.runtimeDoc.stages.publish
  const sources = [
    recordValue(publishStage.outputs.live_platform_events),
    recordValue(publishStage.outputs.platform_events),
    recordValue(publishStage.outputs.live_schedule),
    recordValue(publishStage.primary_output),
  ].filter((entry): entry is Record<string, unknown> => !!entry)

  const events = sources.flatMap((source) => {
    const directEvents = recordArray(source.events)
    const nestedEvents = recordArray(source.live_platform_events).concat(recordArray(source.platform_events))
    return [...directEvents, ...nestedEvents]
  })

  const mapped = events.map((event, index): CandidateCalendarSeed | null => {
      const startsAt = deriveSourceTimestamp(event.starts_at, event.scheduled_for, event.scheduledAt, event.publish_at)
      if (!startsAt) {
        return null
      }

      const platform = normalizePlatformSlug(stringValue(event.platform || event.platform_slug || event.channel, 'campaign'))
      const rawStatus = stringValue(event.status || event.publish_status, 'scheduled').toLowerCase()
      const status: MarketingDashboardItemStatus = rawStatus.includes('live') || rawStatus.includes('published') ? 'live' : 'scheduled'
      return {
        entityId: stringValue(event.id, `live-${index + 1}`),
        campaignId: context.jobId,
        jobId: context.jobId,
        title: stringValue(event.title, `${platformLabel(platform)} scheduled post`),
        platform,
        platformLabel: platformLabel(platform),
        destinationUrl: stringValue(event.destination_url) || context.status.brandWebsiteUrl,
        previewAssetId: null,
        sourcePostId: null,
        sourcePublishItemId: null,
        status,
        startsAt,
        endsAt: deriveSourceTimestamp(event.ends_at),
        sortPriority: explicitSourcePriority(1),
        provenance: {
          sourceKind: 'live_platform',
          sourceStage: 'runtime',
          sourceRunId: context.runtimeDoc.stages.publish.run_id,
          sourcePath: null,
          isDerivedSchedule: false,
          isPlatformNative: true,
        },
      }
    })
  return mapped.filter((event): event is CandidateCalendarSeed => !!event)
}

function publicFromInternal(content: MarketingDashboardContentInternal): MarketingDashboardContent {
  return {
    campaigns: content.campaigns.map(sanitizeCampaign),
    posts: content.posts.map(sanitizePost),
    assets: content.assets.map(sanitizeAsset),
    publishItems: content.publishItems.map(sanitizePublishItem),
    calendarEvents: content.calendarEvents.map(sanitizeCalendarEvent),
    statuses: content.statuses,
  }
}

function dedupePostKey(input: {
  campaignId: string
  platform: string
  conceptId: string | null
  title: string
  destinationUrl: string | null
}): string {
  if (input.conceptId) {
    return `${input.campaignId}::${input.platform}::${input.conceptId}`
  }
  return `${input.campaignId}::${input.platform}::${stableHash([input.title, input.destinationUrl || '', input.platform])}`
}

function buildCampaignContext(jobId: string, runtimeDoc: MarketingJobRuntimeDocument, options: MarketingDashboardBuildOptions): CampaignBuildContext {
  const proposal = parseProposalPlan(runtimeDoc)
  const status = buildStatusSnapshot(runtimeDoc, proposal)
  const brandSlug = extractBrandSlug(runtimeDoc, proposal)
  const externalCampaignId = extractCampaignId(runtimeDoc, proposal)
  return {
    jobId,
    runtimeDoc,
    status,
    referenceDate: nowReference(options.referenceDate),
    proposal,
    brandSlug,
    externalCampaignId,
    campaignName: extractCampaignName(runtimeDoc, status, proposal),
    objective: extractObjective(status, proposal),
    funnelStage: extractFunnelStage(
      proposal.objective,
      recordValue(rawPublishReviewBundle(runtimeDoc)?.summary)?.funnel_stage,
    ),
    campaignRoot: campaignRootForBrand(brandSlug),
    outputRoots: lobsterOutputRoots(),
  }
}

function makeCandidateAsset(input: CandidateAsset): MarketingDashboardAssetInternal {
  return {
    ...input,
    relatedPostIds: [],
    relatedPublishItemIds: [],
  }
}

function buildCampaignContentInternal(context: CampaignBuildContext): MarketingDashboardContentInternal {
  const assetByKey = new Map<string, { priority: number; asset: MarketingDashboardAssetInternal }>()
  const postCandidates: Array<{ priority: number; post: CandidatePost }> = []
  const publishByKey = new Map<string, { priority: number; item: MarketingDashboardPublishItemInternal }>()
  const explicitCalendarSeeds: CandidateCalendarSeed[] = []
  const derivedCalendarSeeds: CandidateCalendarSeed[] = []

  const campaignId = context.jobId
  const campaignName = context.campaignName
  const objective = context.objective
  const funnelStage = context.funnelStage
  const brandUrl = context.status.brandWebsiteUrl || context.runtimeDoc.inputs.brand_url || null

  const addAsset = (candidate: CandidateAsset) => {
    const key = candidate.filePath || candidate.id
    const priority = sourcePriority(candidate.provenance.sourceKind)
    const existing = assetByKey.get(key)
    const asset = makeCandidateAsset(candidate)
    if (!existing || priority < existing.priority) {
      assetByKey.set(key, { priority, asset })
      return asset
    }

    const merged = existing.asset
    merged.previewUrl ||= asset.previewUrl
    merged.thumbnailUrl ||= asset.thumbnailUrl
    merged.destinationUrl ||= asset.destinationUrl
    if (ITEM_STATUS_PRIORITY[asset.status] > ITEM_STATUS_PRIORITY[merged.status]) {
      merged.status = asset.status
      merged.provenance = asset.provenance
    }
    if (!merged.summary && asset.summary) {
      merged.summary = asset.summary
    }
    return merged
  }

  const addPostCandidate = (post: CandidatePost) => {
    postCandidates.push({ priority: sourcePriority(post.provenance.sourceKind), post })
  }

  const addPublishItem = (item: CandidatePublishItem, keySeed?: string) => {
    const key = keySeed || `${item.campaignId}::${item.platform}::${item.title}::${item.status}`
    const priority = sourcePriority(item.provenance.sourceKind)
    const existing = publishByKey.get(key)
    const candidate: MarketingDashboardPublishItemInternal = {
      ...item,
      id: `${item.campaignId}::publish::${slugify(item.title || item.platform, 'publish')}-${stableHash([key, item.status]).slice(0, 8)}`,
      relatedPostIds: [],
    }
    if (!existing || priority < existing.priority) {
      publishByKey.set(key, { priority, item: candidate })
      return candidate
    }

    existing.item.relatedAssetIds = uniqueIds([...existing.item.relatedAssetIds, ...candidate.relatedAssetIds])
    existing.item.destinationUrl ||= candidate.destinationUrl
    existing.item.previewAssetId ||= candidate.previewAssetId
    if (ITEM_STATUS_PRIORITY[candidate.status] > ITEM_STATUS_PRIORITY[existing.item.status]) {
      existing.item.status = candidate.status
      existing.item.provenance = candidate.provenance
    }
    return existing.item
  }

  const addProposalDocumentAssets = () => {
    for (const filePath of proposalDocumentPaths(context.brandSlug)) {
      if (!existsSync(filePath)) {
        continue
      }
      const assetId = makeAssetId(campaignId, 'proposal', filePath)
      addAsset({
        id: assetId,
        campaignId,
        jobId: campaignId,
        type: 'proposal_document',
        title: path.extname(filePath) === '.html' ? 'Campaign proposal preview' : 'Campaign proposal',
        summary: 'Approved proposal artifact from the planning stage.',
        platform: 'campaign',
        platformLabel: 'Campaign',
        campaignName,
        funnelStage,
        objective,
        destinationUrl: brandUrl,
        previewUrl: buildAssetUrl(campaignId, assetId),
        thumbnailUrl: null,
        contentType: contentTypeForAsset(filePath),
        filePath,
        status: proposalStatus(context.runtimeDoc),
        createdAt: context.proposal.createdAt || context.status.updatedAt,
        provenance: {
          sourceKind: 'proposal',
          sourceStage: 'strategy',
          sourceRunId: context.runtimeDoc.stages.strategy.run_id,
          sourcePath: filePath,
          isDerivedSchedule: false,
          isPlatformNative: false,
        },
      })
    }
  }

  const addProposalConcepts = () => {
    const status = proposalStatus(context.runtimeDoc)
    for (const [index, channelPlan] of context.proposal.channelPlans.entries()) {
      const platform = normalizePlatformSlug(stringValue(channelPlan.channel, 'campaign'))
      const title =
        stringValue(channelPlan.message) ||
        stringValue(channelPlan.goal) ||
        `${platformLabel(platform)} creative concept`
      addPostCandidate({
        campaignId,
        jobId: campaignId,
        type: 'proposal_concept',
        title,
        summary:
          stringValue(channelPlan.creative_bias) ||
          stringValue(channelPlan.goal) ||
          'Creative concept approved at the proposal stage.',
        platform,
        platformLabel: platformLabel(platform),
        campaignName,
        funnelStage,
        objective,
        destinationUrl: brandUrl,
        previewAssetId: null,
        status,
        createdAt: context.proposal.createdAt || context.status.updatedAt,
        conceptId: slugify(stringValue(channelPlan.channel, `concept-${index + 1}`)),
        relatedAssetIds: [],
        relatedPublishItemIds: [],
        provenance: {
          sourceKind: 'proposal',
          sourceStage: 'strategy',
          sourceRunId: context.runtimeDoc.stages.strategy.run_id,
          sourcePath: null,
          isDerivedSchedule: false,
          isPlatformNative: false,
        },
        dedupeKey: dedupePostKey({
          campaignId,
          platform,
          conceptId: slugify(stringValue(channelPlan.channel, `concept-${index + 1}`)),
          title,
          destinationUrl: brandUrl,
        }),
      })
    }
  }

  addProposalDocumentAssets()
  addProposalConcepts()

  const staticContractRoot = context.outputRoots[0]
    ? path.join(context.outputRoots[0], 'static-contracts', context.externalCampaignId)
    : null
  const videoContractRoot = context.outputRoots[0]
    ? path.join(context.outputRoots[0], 'video-contracts', context.externalCampaignId)
    : null

  const productionFinalize = readStageStepPayload(3, context.runtimeDoc.stages.production.run_id, 'creative_director_finalize')
  const productionHandoff = recordValue(productionFinalize?.production_handoff) ?? {}
  const contractHandoffs = recordValue(productionHandoff.contract_handoffs) ?? {}
  const staticPaths = asStringArray(recordValue(contractHandoffs.static)?.platform_contract_paths)
  const videoPaths = asStringArray(recordValue(contractHandoffs.video)?.platform_contract_paths)
  const contracts = [
    ...loadContracts(staticPaths, staticContractRoot),
    ...loadContracts(videoPaths, videoContractRoot),
  ]

  const creativeAssetStatus = creativeStatus(context.runtimeDoc)

  const landingPageFiles = listFiles(context.campaignRoot ? path.join(context.campaignRoot, 'landing-pages') : null, (fileName) => fileName.endsWith('.html'))
  const adImageFiles = listFiles(context.campaignRoot ? path.join(context.campaignRoot, 'ad-images') : null, (fileName) =>
    /\.(png|jpe?g|gif|webp|svg)$/i.test(fileName),
  )
  const scriptFiles = listFiles(context.campaignRoot ? path.join(context.campaignRoot, 'scripts') : null, (fileName) =>
    /\.(md|txt|json)$/i.test(fileName),
  )

  const contractByPlatform = new Map<string, ContractRecord>()
  for (const contract of contracts) {
    const platform = normalizePlatformSlug(stringValue(contract.payload.platform_slug || contract.payload.platform))
    if (!contractByPlatform.has(platform)) {
      contractByPlatform.set(platform, contract)
    }
  }

  const creativeAssetIdsByPlatform = new Map<string, string[]>()

  const rememberCreativeAsset = (platform: string, assetId: string) => {
    creativeAssetIdsByPlatform.set(platform, uniqueIds([...(creativeAssetIdsByPlatform.get(platform) || []), assetId]))
  }

  for (const filePath of landingPageFiles) {
    const contract = contractByPlatform.get('landing-page')
    const assetId = makeAssetId(campaignId, 'landing-page', filePath)
    const destinationUrl = extractDestinationUrl(context.runtimeDoc, contract?.payload || null)
    addAsset({
      id: assetId,
      campaignId,
      jobId: campaignId,
      type: 'landing_page',
      title: 'Landing page',
      summary: 'Generated landing page ready for review and publishing.',
      platform: 'landing-page',
      platformLabel: 'Landing Page',
      campaignName,
      funnelStage,
      objective,
      destinationUrl,
      previewUrl: buildAssetUrl(campaignId, assetId),
      thumbnailUrl: buildAssetUrl(campaignId, assetId),
      contentType: contentTypeForAsset(filePath),
      filePath,
      status: creativeAssetStatus,
      createdAt: context.status.updatedAt,
      provenance: {
        sourceKind: 'creative_output',
        sourceStage: 'production',
        sourceRunId: context.runtimeDoc.stages.production.run_id,
        sourcePath: filePath,
        isDerivedSchedule: false,
        isPlatformNative: false,
      },
    })
    rememberCreativeAsset('landing-page', assetId)
  }

  for (const filePath of adImageFiles) {
    const platform = extractPlatformFromFilename(filePath)
    const assetId = makeAssetId(campaignId, 'image', filePath)
    addAsset({
      id: assetId,
      campaignId,
      jobId: campaignId,
      type: 'image_ad',
      title: `${platformLabel(platform)} image`,
      summary: 'Generated ad image ready for publishing workflows.',
      platform,
      platformLabel: platformLabel(platform),
      campaignName,
      funnelStage,
      objective,
      destinationUrl: extractDestinationUrl(context.runtimeDoc, contractByPlatform.get(platform)?.payload || null),
      previewUrl: buildAssetUrl(campaignId, assetId),
      thumbnailUrl: buildAssetUrl(campaignId, assetId),
      contentType: contentTypeForAsset(filePath),
      filePath,
      status: creativeAssetStatus,
      createdAt: context.status.updatedAt,
      provenance: {
        sourceKind: 'creative_output',
        sourceStage: 'production',
        sourceRunId: context.runtimeDoc.stages.production.run_id,
        sourcePath: filePath,
        isDerivedSchedule: false,
        isPlatformNative: false,
      },
    })
    rememberCreativeAsset(platform, assetId)
  }

  for (const filePath of scriptFiles) {
    const platform = extractPlatformFromFilename(filePath)
    const assetId = makeAssetId(campaignId, 'script', filePath)
    addAsset({
      id: assetId,
      campaignId,
      jobId: campaignId,
      type: path.extname(filePath).toLowerCase() === '.json' ? 'copy' : 'script',
      title: extractTitleFromCopyPayload(filePath) || `${platformLabel(platform)} script`,
      summary: extractSummaryFromCopyPayload(filePath) || 'Generated script or post concept ready for publishing workflows.',
      platform,
      platformLabel: platformLabel(platform),
      campaignName,
      funnelStage,
      objective,
      destinationUrl: extractDestinationUrl(context.runtimeDoc, contractByPlatform.get(platform)?.payload || null),
      previewUrl: buildAssetUrl(campaignId, assetId),
      thumbnailUrl: null,
      contentType: contentTypeForAsset(filePath),
      filePath,
      status: creativeAssetStatus,
      createdAt: context.status.updatedAt,
      provenance: {
        sourceKind: 'creative_output',
        sourceStage: 'production',
        sourceRunId: context.runtimeDoc.stages.production.run_id,
        sourcePath: filePath,
        isDerivedSchedule: false,
        isPlatformNative: false,
      },
    })
    rememberCreativeAsset(platform, assetId)
  }

  for (const contract of contracts) {
    const payload = contract.payload
    const platform = normalizePlatformSlug(stringValue(payload.platform_slug || payload.platform))
    const conceptId = stringValue(payload.concept_id) || null
    const title =
      stringValue(recordValue(payload.creative)?.headline || recordValue(payload.creative)?.hook) ||
      `${platformLabel(platform)} creative`
    const destinationUrl = extractDestinationUrl(context.runtimeDoc, payload)
    addPostCandidate({
      campaignId,
      jobId: campaignId,
      type: platform === 'meta-ads' ? 'meta_ad' : 'creative_output',
      title,
      summary:
        stringValue(recordValue(payload.landing_page)?.hero_subheadline) ||
        asStringArray(recordValue(payload.creative)?.body_lines)[0] ||
        'Generated creative output ready for publishing workflows.',
      platform,
      platformLabel: platformLabel(platform),
      campaignName,
      funnelStage: extractFunnelStage(payload.funnel_stage, funnelStage),
      objective,
      destinationUrl,
      previewAssetId: (creativeAssetIdsByPlatform.get(platform) || creativeAssetIdsByPlatform.get('landing-page') || [])[0] || null,
      status: creativeAssetStatus,
      createdAt: context.status.updatedAt,
      conceptId,
      relatedAssetIds: uniqueIds([
        ...(creativeAssetIdsByPlatform.get(platform) || []),
        ...(platform !== 'landing-page' ? creativeAssetIdsByPlatform.get('landing-page') || [] : []),
      ]),
      relatedPublishItemIds: [],
      provenance: {
        sourceKind: 'creative_output',
        sourceStage: 'production',
        sourceRunId: context.runtimeDoc.stages.production.run_id,
        sourcePath: contract.filePath,
        isDerivedSchedule: false,
        isPlatformNative: false,
      },
      dedupeKey: dedupePostKey({
        campaignId,
        platform,
        conceptId,
        title,
        destinationUrl,
      }),
    })
  }

  if (contracts.length === 0) {
    for (const [platform, assetIds] of creativeAssetIdsByPlatform.entries()) {
      addPostCandidate({
        campaignId,
        jobId: campaignId,
        type: platform === 'meta-ads' ? 'meta_ad' : 'creative_output',
        title: `${platformLabel(platform)} creative`,
        summary: 'Generated creative assets are ready for publishing workflows.',
        platform,
        platformLabel: platformLabel(platform),
        campaignName,
        funnelStage,
        objective,
        destinationUrl: brandUrl,
        previewAssetId: assetIds[0] || null,
        status: creativeAssetStatus,
        createdAt: context.status.updatedAt,
        conceptId: null,
        relatedAssetIds: assetIds,
        relatedPublishItemIds: [],
        provenance: {
          sourceKind: 'creative_output',
          sourceStage: 'production',
          sourceRunId: context.runtimeDoc.stages.production.run_id,
          sourcePath: null,
          isDerivedSchedule: false,
          isPlatformNative: false,
        },
        dedupeKey: dedupePostKey({
          campaignId,
          platform,
          conceptId: null,
          title: `${platformLabel(platform)} creative`,
          destinationUrl: brandUrl,
        }),
      })
    }
  }

  const publishBundle = rawPublishReviewBundle(context.runtimeDoc)
  const platformPreviews = recordArray(publishBundle?.platform_previews)
  const reviewCalendarEvents = recordArray(recordValue(publishBundle?.content_calendar)?.events)
  const publishStatus = publishReadyStatus(context.runtimeDoc)

  for (const [index, preview] of platformPreviews.entries()) {
    const platform = normalizePlatformSlug(stringValue(preview.platform_slug || preview.platform_name, 'campaign'))
    const assetPaths = recordValue(preview.asset_paths) ?? {}
    const mediaPaths = asStringArray(preview.media_paths)
    const assetIds: string[] = []

    mediaPaths.forEach((filePath, mediaIndex) => {
      const assetId = `platform-preview-${platform}-media-${mediaIndex + 1}`
      addAsset({
        id: assetId,
        campaignId,
        jobId: campaignId,
        type: 'image_ad',
        title: `${platformLabel(platform)} media ${mediaIndex + 1}`,
        summary: stringValue(preview.summary) || 'Preview media ready for publish review.',
        platform,
        platformLabel: platformLabel(platform),
        campaignName,
        funnelStage,
        objective,
        destinationUrl: stringValue(assetPaths.landing_page_path) || brandUrl,
        previewUrl: buildAssetUrl(campaignId, assetId),
        thumbnailUrl: buildAssetUrl(campaignId, assetId),
        contentType: contentTypeForAsset(filePath),
        filePath,
        status: publishStatus,
        createdAt: deriveSourceTimestamp(preview.generated_at, context.status.updatedAt),
        provenance: {
          sourceKind: 'publish_review',
          sourceStage: 'publish',
          sourceRunId: context.runtimeDoc.stages.publish.run_id,
          sourcePath: filePath,
          isDerivedSchedule: false,
          isPlatformNative: false,
        },
      })
      assetIds.push(assetId)
    })

    ;[
      ['contract', stringValue(assetPaths.contract_path), 'contract'],
      ['brief', stringValue(assetPaths.brief_path), 'contract'],
      ['landing-page', stringValue(assetPaths.landing_page_path), 'landing_page'],
    ].forEach(([label, filePath, type]) => {
      if (!filePath) {
        return
      }
      const suffix = label === 'contract' ? 'contract' : label === 'brief' ? 'brief' : 'landing-page'
      const assetId = `platform-preview-${platform}-asset-${suffix}`
      addAsset({
        id: assetId,
        campaignId,
        jobId: campaignId,
        type: type as MarketingDashboardAssetType,
        title: `${platformLabel(platform)} ${label}`,
        summary: stringValue(preview.summary) || 'Preview asset ready for publish review.',
        platform,
        platformLabel: platformLabel(platform),
        campaignName,
        funnelStage,
        objective,
        destinationUrl: label === 'landing-page' ? filePath : brandUrl,
        previewUrl: buildAssetUrl(campaignId, assetId),
        thumbnailUrl: type === 'landing_page' ? buildAssetUrl(campaignId, assetId) : null,
        contentType: contentTypeForAsset(filePath),
        filePath,
        status: publishStatus,
        createdAt: context.status.updatedAt,
        provenance: {
          sourceKind: 'publish_review',
          sourceStage: 'publish',
          sourceRunId: context.runtimeDoc.stages.publish.run_id,
          sourcePath: filePath,
          isDerivedSchedule: false,
          isPlatformNative: false,
        },
      })
      assetIds.push(assetId)
    })

    const title = stringValue(preview.headline || preview.platform_name, `${platformLabel(platform)} preview`)
    const postDedupeKey = dedupePostKey({
      campaignId,
      platform,
      conceptId: slugify(title, `preview-${index + 1}`),
      title,
      destinationUrl: stringValue(assetPaths.landing_page_path) || brandUrl,
    })

    const publishItem = addPublishItem({
      campaignId,
      jobId: campaignId,
      type: 'pre_publish_review',
      title,
      summary: stringValue(preview.summary) || 'Pre-publish review item is ready for launch review.',
      platform,
      platformLabel: platformLabel(platform),
      campaignName,
      funnelStage,
      objective,
      destinationUrl: stringValue(assetPaths.landing_page_path) || brandUrl,
      previewAssetId: assetIds[0] || null,
      status: publishStatus,
      createdAt: deriveSourceTimestamp(preview.generated_at, context.status.updatedAt),
      relatedAssetIds: assetIds,
      provenance: {
        sourceKind: 'publish_review',
        sourceStage: 'publish',
        sourceRunId: context.runtimeDoc.stages.publish.run_id,
        sourcePath: null,
        isDerivedSchedule: false,
        isPlatformNative: false,
      },
    }, postDedupeKey)

    addPostCandidate({
      campaignId,
      jobId: campaignId,
      type: platform === 'meta-ads' ? 'pre_publish_ad' : 'platform_post',
      title,
      summary: stringValue(preview.caption_text || preview.summary),
      platform,
      platformLabel: platformLabel(platform),
      campaignName,
      funnelStage,
      objective,
      destinationUrl: stringValue(assetPaths.landing_page_path) || brandUrl,
      previewAssetId: assetIds[0] || null,
      status: publishStatus,
      createdAt: deriveSourceTimestamp(preview.generated_at, context.status.updatedAt),
      conceptId: slugify(title, `preview-${index + 1}`),
      relatedAssetIds: assetIds,
      relatedPublishItemIds: [publishItem.id],
      provenance: {
        sourceKind: 'publish_review',
        sourceStage: 'publish',
        sourceRunId: context.runtimeDoc.stages.publish.run_id,
        sourcePath: null,
        isDerivedSchedule: false,
        isPlatformNative: false,
      },
      dedupeKey: postDedupeKey,
    })
  }

  for (const [index, event] of reviewCalendarEvents.entries()) {
    const platform = normalizePlatformSlug(stringValue(event.platform, 'campaign'))
    const rawStatus = stringValue(event.status, 'planned').toLowerCase()
    const eventStatus: MarketingDashboardItemStatus =
      rawStatus.includes('published') || rawStatus.includes('live')
        ? 'live'
        : rawStatus.includes('scheduled')
          ? 'scheduled'
          : rawStatus.includes('created')
            ? 'ready_to_publish'
            : 'ready'

    explicitCalendarSeeds.push({
      entityId: stringValue(event.id, `review-calendar-${index + 1}`),
      campaignId,
      jobId: campaignId,
      title: stringValue(event.title, `${platformLabel(platform)} planned item`),
      platform,
      platformLabel: platformLabel(platform),
      destinationUrl: brandUrl,
      previewAssetId: stringValue(event.asset_preview_id) || null,
      sourcePostId: null,
      sourcePublishItemId: null,
      status: eventStatus,
      startsAt: deriveSourceTimestamp(event.starts_at),
      endsAt: deriveSourceTimestamp(event.ends_at),
      sortPriority: explicitSourcePriority(3),
      provenance: {
        sourceKind: 'publish_review',
        sourceStage: 'publish',
        sourceRunId: context.runtimeDoc.stages.publish.run_id,
        sourcePath: null,
        isDerivedSchedule: false,
        isPlatformNative: false,
      },
    })
  }

  const publisherPayloads = PUBLISHER_STEPS.map((stepName) => {
    const payload = readStageStepPayload(4, context.runtimeDoc.stages.publish.run_id, stepName)
    return payload ? { stepName, payload } : null
  }).filter((entry): entry is { stepName: typeof PUBLISHER_STEPS[number]; payload: Record<string, unknown> } => !!entry)

  const reviewPackagePaths = new Set<string>()

  for (const { payload } of publisherPayloads) {
    const platform = normalizePlatformSlug(stringValue(payload.platform) || stringValue(payload.type))
    const publishPackage = recordValue(payload.publish_package) ?? {}
    const liveDraftPublish = recordValue(payload.live_draft_publish)
    const contractPath = stringValue(payload.contract_path)
    const copyPath = stringValue(publishPackage.copy_path)
    const imagePath = stringValue(publishPackage.image_path)
    const fallbackSvgPath = stringValue(publishPackage.fallback_svg_path)
    const reviewPackagePath = stringValue(publishPackage.review_package_path)
    if (reviewPackagePath) {
      reviewPackagePaths.add(reviewPackagePath)
    }

    const paused = isPausedPublishResult(liveDraftPublish)
    const live = isLivePublishResult(liveDraftPublish)
    const explicitStatus: MarketingDashboardItemStatus =
      live
        ? 'live'
        : paused
          ? 'published_to_meta_paused'
          : publishStatus

    const createdAt = deriveSourceTimestamp(
      payload.generated_at,
      liveDraftPublish?.created_at,
      context.status.updatedAt,
    )
    const title =
      extractTitleFromCopyPayload(copyPath) ||
      stringValue(recordValue(readJsonIfExists(contractPath)?.creative)?.headline) ||
      `${platformLabel(platform)} package`
    const summary =
      extractSummaryFromCopyPayload(copyPath) ||
      `Publish-ready ${platformLabel(platform).toLowerCase()} package is available.`

    const assetIds: string[] = []
    ;[
      ['publish-image', imagePath, 'image_ad'],
      ['publish-copy', copyPath, 'copy'],
      ['publish-fallback', fallbackSvgPath, 'image_ad'],
      ['publish-contract', contractPath, 'contract'],
    ].forEach(([prefix, filePath, type]) => {
      if (!filePath) {
        return
      }
      const assetId = makeAssetId(campaignId, String(prefix), filePath)
      addAsset({
        id: assetId,
        campaignId,
        jobId: campaignId,
        type: type as MarketingDashboardAssetType,
        title: `${platformLabel(platform)} ${String(prefix).replace(/^publish-/, '')}`,
        summary,
        platform,
        platformLabel: platformLabel(platform),
        campaignName,
        funnelStage,
        objective,
        destinationUrl: brandUrl,
        previewUrl: buildAssetUrl(campaignId, assetId),
        thumbnailUrl: /\.(png|jpe?g|gif|webp|svg)$/i.test(filePath) ? buildAssetUrl(campaignId, assetId) : null,
        contentType: contentTypeForAsset(filePath),
        filePath,
        status: explicitStatus,
        createdAt,
        provenance: {
          sourceKind: paused || live ? 'live_publish_result' : 'publish_review',
          sourceStage: 'publish',
          sourceRunId: context.runtimeDoc.stages.publish.run_id,
          sourcePath: filePath,
          isDerivedSchedule: false,
          isPlatformNative: false,
        },
      })
      assetIds.push(assetId)
    })

    const publishItem = addPublishItem({
      campaignId,
      jobId: campaignId,
      type: paused
        ? 'meta_paused_ad'
        : live
          ? 'live_post'
          : 'publish_package',
      title,
      summary,
      platform,
      platformLabel: platformLabel(platform),
      campaignName,
      funnelStage,
      objective,
      destinationUrl: brandUrl,
      previewAssetId: assetIds[0] || null,
      status: explicitStatus,
      createdAt,
      relatedAssetIds: assetIds,
      provenance: {
        sourceKind: paused || live ? 'live_publish_result' : 'publish_review',
        sourceStage: 'publish',
        sourceRunId: context.runtimeDoc.stages.publish.run_id,
        sourcePath: reviewPackagePath || copyPath || imagePath || contractPath || null,
        isDerivedSchedule: false,
        isPlatformNative: false,
      },
    }, `${campaignId}::${platform}::${title}`)

    const postStatus =
      explicitStatus === 'published_to_meta_paused' || explicitStatus === 'live'
        ? explicitStatus
        : publishStatus

    addPostCandidate({
      campaignId,
      jobId: campaignId,
      type: platform === 'meta-ads' ? 'meta_ad' : 'platform_post',
      title,
      summary,
      platform,
      platformLabel: platformLabel(platform),
      campaignName,
      funnelStage,
      objective,
      destinationUrl: brandUrl,
      previewAssetId: assetIds[0] || null,
      status: postStatus,
      createdAt,
      conceptId: slugify(title, platform),
      relatedAssetIds: assetIds,
      relatedPublishItemIds: [publishItem.id],
      provenance: {
        sourceKind: paused || live ? 'live_publish_result' : 'publish_review',
        sourceStage: 'publish',
        sourceRunId: context.runtimeDoc.stages.publish.run_id,
        sourcePath: reviewPackagePath || copyPath || imagePath || contractPath || null,
        isDerivedSchedule: false,
        isPlatformNative: false,
      },
      dedupeKey: dedupePostKey({
        campaignId,
        platform,
        conceptId: slugify(title, platform),
        title,
        destinationUrl: brandUrl,
      }),
    })

    const startsAt = liveDraftPublish ? scheduledTimestamp(liveDraftPublish) : null
    if (startsAt || paused || live) {
      explicitCalendarSeeds.push({
        entityId: publishItem.id,
        campaignId,
        jobId: campaignId,
        title,
        platform,
        platformLabel: platformLabel(platform),
        destinationUrl: brandUrl,
        previewAssetId: assetIds[0] || null,
        sourcePostId: null,
        sourcePublishItemId: publishItem.id,
        status: explicitStatus,
        startsAt,
        endsAt: null,
        sortPriority: explicitSourcePriority(paused || live ? 2 : 3),
        provenance: {
          sourceKind: paused || live ? 'live_publish_result' : 'publish_review',
          sourceStage: 'publish',
          sourceRunId: context.runtimeDoc.stages.publish.run_id,
          sourcePath: reviewPackagePath || null,
          isDerivedSchedule: !startsAt,
          isPlatformNative: false,
        },
      })
    }
  }

  for (const reviewPackagePath of reviewPackagePaths) {
    const reviewPackage = readJsonIfExists(reviewPackagePath)
    if (!reviewPackage) {
      continue
    }

    const entries = recordArray(reviewPackage.entries)
    const packageRecords = entries.length > 0 ? entries : [reviewPackage]
    for (const [index, entry] of packageRecords.entries()) {
      const assetPaths = recordValue(entry.asset_paths) ?? recordValue(reviewPackage.asset_paths) ?? {}
      const platform = normalizePlatformSlug(
        stringValue(entry.platform || reviewPackage.platform || path.basename(path.dirname(reviewPackagePath))),
      )
      const copyPath = stringValue(assetPaths.copy_path)
      const imagePath = stringValue(assetPaths.image_path || assetPaths.poster_image_path)
      const landingPath = stringValue(assetPaths.landing_page_path)
      const title =
        stringValue(entry.title) ||
        extractTitleFromCopyPayload(copyPath) ||
        `${platformLabel(platform)} review item ${entries.length > 0 ? index + 1 : ''}`.trim()
      const summary =
        extractSummaryFromCopyPayload(copyPath) ||
        stringValue(entry.summary) ||
        'Review-ready publish package awaiting scheduling or activation.'

      const assetIds: string[] = []
      ;[
        ['review-image', imagePath, 'image_ad'],
        ['review-copy', copyPath, 'copy'],
        ['review-landing-page', landingPath, 'landing_page'],
        ['review-package', reviewPackagePath, 'review_package'],
      ].forEach(([prefix, filePath, type]) => {
        if (!filePath) {
          return
        }
        const assetId = makeAssetId(campaignId, String(prefix), `${filePath}-${index}`)
        addAsset({
          id: assetId,
          campaignId,
          jobId: campaignId,
          type: type as MarketingDashboardAssetType,
          title: `${platformLabel(platform)} ${String(prefix).replace(/^review-/, '')}`,
          summary,
          platform,
          platformLabel: platformLabel(platform),
          campaignName,
          funnelStage,
          objective,
          destinationUrl: landingPath || brandUrl,
          previewUrl: buildAssetUrl(campaignId, assetId),
          thumbnailUrl: /\.(png|jpe?g|gif|webp|svg|html)$/i.test(filePath) ? buildAssetUrl(campaignId, assetId) : null,
          contentType: contentTypeForAsset(filePath),
          filePath,
          status: publishStatus,
          createdAt: context.status.updatedAt,
          provenance: {
            sourceKind: 'publish_review',
            sourceStage: 'publish',
            sourceRunId: context.runtimeDoc.stages.publish.run_id,
            sourcePath: reviewPackagePath,
            isDerivedSchedule: false,
            isPlatformNative: false,
          },
        })
        assetIds.push(assetId)
      })

      const publishItem = addPublishItem({
        campaignId,
        jobId: campaignId,
        type: 'pre_publish_review',
        title,
        summary,
        platform,
        platformLabel: platformLabel(platform),
        campaignName,
        funnelStage,
        objective,
        destinationUrl: landingPath || brandUrl,
        previewAssetId: assetIds[0] || null,
        status: publishStatus,
        createdAt: context.status.updatedAt,
        relatedAssetIds: assetIds,
        provenance: {
          sourceKind: 'publish_review',
          sourceStage: 'publish',
          sourceRunId: context.runtimeDoc.stages.publish.run_id,
          sourcePath: reviewPackagePath,
          isDerivedSchedule: false,
          isPlatformNative: false,
        },
      }, `${campaignId}::review-package::${platform}::${title}`)

      addPostCandidate({
        campaignId,
        jobId: campaignId,
        type: platform === 'meta-ads' ? 'pre_publish_ad' : 'platform_post',
        title,
        summary,
        platform,
        platformLabel: platformLabel(platform),
        campaignName,
        funnelStage,
        objective,
        destinationUrl: landingPath || brandUrl,
        previewAssetId: assetIds[0] || null,
        status: publishStatus,
        createdAt: context.status.updatedAt,
        conceptId: slugify(title, `${platform}-${index + 1}`),
        relatedAssetIds: assetIds,
        relatedPublishItemIds: [publishItem.id],
        provenance: {
          sourceKind: 'publish_review',
          sourceStage: 'publish',
          sourceRunId: context.runtimeDoc.stages.publish.run_id,
          sourcePath: reviewPackagePath,
          isDerivedSchedule: false,
          isPlatformNative: false,
        },
        dedupeKey: dedupePostKey({
          campaignId,
          platform,
          conceptId: slugify(title, `${platform}-${index + 1}`),
          title,
          destinationUrl: landingPath || brandUrl,
        }),
      })
    }
  }

  for (const seed of buildLivePlatformEvents(context)) {
    explicitCalendarSeeds.push(seed)
  }

  const postsByKey = new Map<string, { priority: number; post: MarketingDashboardPostInternal }>()
  for (const candidate of postCandidates.sort((left, right) => left.priority - right.priority)) {
    const existing = postsByKey.get(candidate.post.dedupeKey)
    const basePost: MarketingDashboardPostInternal = {
      ...candidate.post,
      id: `${candidate.post.campaignId}::post::${slugify(candidate.post.platform, 'platform')}::${stableHash(candidate.post.dedupeKey).slice(0, 8)}`,
      relatedPublishItemIds: uniqueIds(candidate.post.relatedPublishItemIds || []),
    }
    delete (basePost as { dedupeKey?: string }).dedupeKey

    if (!existing) {
      postsByKey.set(candidate.post.dedupeKey, { priority: candidate.priority, post: basePost })
      continue
    }

    existing.post.relatedAssetIds = uniqueIds([...existing.post.relatedAssetIds, ...basePost.relatedAssetIds])
    existing.post.relatedPublishItemIds = uniqueIds([...existing.post.relatedPublishItemIds, ...basePost.relatedPublishItemIds])
    existing.post.destinationUrl ||= basePost.destinationUrl
    existing.post.previewAssetId ||= basePost.previewAssetId
    if (ITEM_STATUS_PRIORITY[basePost.status] > ITEM_STATUS_PRIORITY[existing.post.status]) {
      existing.post.status = basePost.status
      existing.post.provenance = basePost.provenance
    }
  }

  const posts = Array.from(postsByKey.values()).map((entry) => entry.post)
  const assets = Array.from(assetByKey.values()).map((entry) => entry.asset)
  const publishItems = Array.from(publishByKey.values()).map((entry) => entry.item)

  const postById = new Map(posts.map((post) => [post.id, post]))
  const publishItemById = new Map(publishItems.map((item) => [item.id, item]))
  const assetById = new Map(assets.map((asset) => [asset.id, asset]))

  for (const post of posts) {
    for (const assetId of post.relatedAssetIds) {
      const asset = assetById.get(assetId)
      if (asset) {
        asset.relatedPostIds = uniqueIds([...asset.relatedPostIds, post.id])
      }
    }
    for (const publishItemId of post.relatedPublishItemIds) {
      const item = publishItemById.get(publishItemId)
      if (item) {
        item.relatedPostIds = uniqueIds([...item.relatedPostIds, post.id])
      }
    }
  }

  for (const publishItem of publishItems) {
    for (const assetId of publishItem.relatedAssetIds) {
      const asset = assetById.get(assetId)
      if (asset) {
        asset.relatedPublishItemIds = uniqueIds([...asset.relatedPublishItemIds, publishItem.id])
      }
    }
  }

  for (const publishItem of publishItems) {
    derivedCalendarSeeds.push({
      entityId: publishItem.id,
      campaignId,
      jobId: campaignId,
      title: publishItem.title,
      platform: publishItem.platform,
      platformLabel: publishItem.platformLabel,
      destinationUrl: publishItem.destinationUrl,
      previewAssetId: publishItem.previewAssetId,
      sourcePostId: null,
      sourcePublishItemId: publishItem.id,
      status: publishItem.status,
      startsAt: null,
      endsAt: null,
      sortPriority: publishItem.status === 'published_to_meta_paused' ? 2 : 1,
      provenance: {
        ...publishItem.provenance,
        isDerivedSchedule: true,
      },
    })
  }

  for (const asset of assets) {
    const sortPriority =
      asset.type === 'landing_page'
        ? 3
        : asset.type === 'image_ad'
          ? 4
          : asset.type === 'script' || asset.type === 'copy'
            ? 5
            : 6
    derivedCalendarSeeds.push({
      entityId: asset.id,
      campaignId,
      jobId: campaignId,
      title: asset.title,
      platform: asset.platform,
      platformLabel: asset.platformLabel,
      destinationUrl: asset.destinationUrl,
      previewAssetId: asset.id,
      sourcePostId: asset.relatedPostIds[0] || null,
      sourcePublishItemId: asset.relatedPublishItemIds[0] || null,
      status: asset.status === 'draft' ? 'ready' : asset.status,
      startsAt: null,
      endsAt: null,
      sortPriority,
      provenance: {
        ...asset.provenance,
        isDerivedSchedule: true,
      },
    })
  }

  for (const post of posts.filter((post) => post.provenance.sourceKind === 'proposal')) {
    derivedCalendarSeeds.push({
      entityId: post.id,
      campaignId,
      jobId: campaignId,
      title: post.title,
      platform: post.platform,
      platformLabel: post.platformLabel,
      destinationUrl: post.destinationUrl,
      previewAssetId: post.previewAssetId,
      sourcePostId: post.id,
      sourcePublishItemId: post.relatedPublishItemIds[0] || null,
      status: post.status === 'draft' ? 'ready' : post.status,
      startsAt: null,
      endsAt: null,
      sortPriority: 6,
      provenance: {
        ...post.provenance,
        isDerivedSchedule: true,
      },
    })
  }

  const explicitCalendarEvents = calendarSeedsToEvents(explicitCalendarSeeds, context.status.campaignWindow, context.referenceDate)
  const derivedCalendarEvents = calendarSeedsToEvents(
    derivedCalendarSeeds.filter((seed) => explicitCalendarSeeds.every((existing) => existing.entityId !== seed.entityId)),
    context.status.campaignWindow,
    context.referenceDate,
  )

  const calendarEvents = [...explicitCalendarEvents, ...derivedCalendarEvents]
    .map((event) => ({
      ...event,
      campaignName,
      funnelStage,
      objective,
    }))
    .sort((left, right) =>
      Number(right.provenance.isPlatformNative) - Number(left.provenance.isPlatformNative) ||
      ITEM_STATUS_PRIORITY[right.status] - ITEM_STATUS_PRIORITY[left.status] ||
      left.startsAt.localeCompare(right.startsAt)
    )

  let campaignStatus: MarketingDashboardItemStatus = 'draft'
  for (const item of [...posts, ...publishItems, ...calendarEvents]) {
    if (ITEM_STATUS_PRIORITY[item.status] > ITEM_STATUS_PRIORITY[campaignStatus]) {
      campaignStatus = item.status
    }
  }

  const counts = {
    posts: posts.length,
    landingPages: assets.filter((asset) => asset.type === 'landing_page').length,
    imageAds: assets.filter((asset) => asset.type === 'image_ad').length,
    scripts: assets.filter((asset) => asset.type === 'script' || asset.type === 'copy').length,
    publishItems: publishItems.length,
    proposalConcepts: posts.filter((post) => post.provenance.sourceKind === 'proposal').length,
    ready: 0,
    readyToPublish: 0,
    pausedMetaAds: 0,
    scheduled: 0,
    live: 0,
  }

  const statusSummary = createEmptyStatusSummary()
  for (const item of [...posts, ...publishItems]) {
    incrementStatus(statusSummary, item.status)
    if (item.status === 'ready') counts.ready += 1
    if (item.status === 'ready_to_publish') counts.readyToPublish += 1
    if (item.status === 'published_to_meta_paused') counts.pausedMetaAds += 1
    if (item.status === 'scheduled') counts.scheduled += 1
    if (item.status === 'live') counts.live += 1
  }

  const campaign: MarketingDashboardCampaignInternal = {
    id: campaignId,
    jobId: campaignId,
    externalCampaignId: context.externalCampaignId,
    name: campaignName,
    objective,
    funnelStage,
    summary: summaryFromStatus(context),
    stageLabel: context.status.currentStage || 'campaign',
    status: campaignStatus,
    compatibilityStatus: compatibilityStatusFor(campaignStatus),
    campaignWindow: context.status.campaignWindow,
    updatedAt: context.status.updatedAt,
    approvalRequired: context.status.approvalRequired,
    approvalActionHref: context.status.approvalActionHref,
    previewPostIds: posts.slice(0, 3).map((post) => post.id),
    previewAssetIds: assets.slice(0, 3).map((asset) => asset.id),
    postIds: posts.map((post) => post.id),
    assetIds: assets.map((asset) => asset.id),
    publishItemIds: publishItems.map((item) => item.id),
    calendarEventIds: calendarEvents.map((event) => event.id),
    counts,
    provenance: campaignProvenance(
      campaignStatus === 'live' || campaignStatus === 'scheduled'
        ? 'live_platform'
        : publishItems.length > 0
          ? 'publish_review'
          : assets.length > 0
            ? 'creative_output'
            : 'proposal',
      context.status.currentStage === 'publish' || publishItems.length > 0
        ? 'publish'
        : assets.length > 0
          ? 'production'
          : 'strategy',
      context.runtimeDoc,
    ),
  }

  return {
    campaigns: [campaign],
    posts,
    assets,
    publishItems,
    calendarEvents,
    statuses: statusSummary,
  }
}

function mergeContent(items: MarketingDashboardContentInternal[]): MarketingDashboardContentInternal {
  const merged: MarketingDashboardContentInternal = {
    campaigns: [],
    posts: [],
    assets: [],
    publishItems: [],
    calendarEvents: [],
    statuses: createEmptyStatusSummary(),
  }

  for (const item of items) {
    merged.campaigns.push(...item.campaigns)
    merged.posts.push(...item.posts)
    merged.assets.push(...item.assets)
    merged.publishItems.push(...item.publishItems)
    merged.calendarEvents.push(...item.calendarEvents)
    for (const status of Object.keys(merged.statuses.countsByStatus) as MarketingDashboardItemStatus[]) {
      merged.statuses.countsByStatus[status] += item.statuses.countsByStatus[status]
    }
  }

  merged.campaigns.sort((left, right) => {
    const leftUpdated = Date.parse(left.updatedAt || '')
    const rightUpdated = Date.parse(right.updatedAt || '')
    return (Number.isFinite(rightUpdated) ? rightUpdated : 0) - (Number.isFinite(leftUpdated) ? leftUpdated : 0)
  })
  merged.calendarEvents.sort((left, right) => left.startsAt.localeCompare(right.startsAt))

  return merged
}

export function getMarketingDashboardContentInternal(jobId: string, options: MarketingDashboardBuildOptions = {}): MarketingDashboardContentInternal {
  const runtimeDoc = loadMarketingJobRuntime(jobId)
  if (!runtimeDoc) {
    return {
      campaigns: [],
      posts: [],
      assets: [],
      publishItems: [],
      calendarEvents: [],
      statuses: createEmptyStatusSummary(),
    }
  }

  return buildCampaignContentInternal(buildCampaignContext(jobId, runtimeDoc, options))
}

export function getMarketingDashboardContent(jobId: string, options: MarketingDashboardBuildOptions = {}): MarketingDashboardContent {
  return publicFromInternal(getMarketingDashboardContentInternal(jobId, options))
}

export function getMarketingDashboardCampaignContent(jobId: string, options: MarketingDashboardBuildOptions = {}): MarketingDashboardCampaignContent {
  const internal = getMarketingDashboardContentInternal(jobId, options)
  return {
    campaign: internal.campaigns[0] ? sanitizeCampaign(internal.campaigns[0]) : null,
    posts: internal.posts.map(sanitizePost),
    assets: internal.assets.map(sanitizeAsset),
    publishItems: internal.publishItems.map(sanitizePublishItem),
    calendarEvents: internal.calendarEvents.map(sanitizeCalendarEvent),
    statuses: internal.statuses,
  }
}

export function getMarketingDashboardContentForTenantInternal(
  tenantId: string,
  options: MarketingDashboardBuildOptions = {},
): MarketingDashboardContentInternal {
  const jobIds = listMarketingJobIdsForTenant(tenantId)
  return mergeContent(jobIds.map((jobId) => getMarketingDashboardContentInternal(jobId, options)))
}

export function getMarketingDashboardContentForTenant(
  tenantId: string,
  options: MarketingDashboardBuildOptions = {},
): MarketingDashboardContent {
  return publicFromInternal(getMarketingDashboardContentForTenantInternal(tenantId, options))
}

export function listMarketingDashboardAssetsForJob(jobId: string, options: MarketingDashboardBuildOptions = {}): MarketingDashboardAssetInternal[] {
  return getMarketingDashboardContentInternal(jobId, options).assets
}

export function dashboardDateRangeText(window: MarketingCampaignWindow | null): string {
  return formatDateRange(window)
}

export function dashboardNextScheduledText(events: MarketingDashboardCalendarEventInternal[]): string {
  return nextScheduledText(events[0] || null)
}
