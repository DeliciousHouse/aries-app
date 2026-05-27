/**
 * backend/insights/types.ts
 *
 * Domain types that mirror the insights_* DB tables.
 * Route handlers, read-path queries, and the sync dispatcher
 * all use these shapes — never raw pg row objects.
 */

// ── Accounts ──────────────────────────────────────────────────────────────────

export interface InsightsAccount {
  id: number;
  tenantId: number;
  platform: string;
  externalAccountId: string;
  displayName: string | null;
  connectedAt: Date | null;
  lastSyncAt: Date | null;
  backfillCompletedAt: Date | null;
  metadata: Record<string, unknown>;
}

// ── Posts ─────────────────────────────────────────────────────────────────────

export type PostMediaType = 'video' | 'short' | 'reel' | 'image' | 'carousel';

export interface InsightsPost {
  id: number;
  tenantId: number;
  accountId: number;
  platform: string;
  externalPostId: string;
  publishedAt: Date | null;
  mediaType: PostMediaType | null;
  title: string | null;
  caption: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  lastMetricsFetchedAt: Date | null;
  rawFirstSeenAt: Date;
}

// ── Account-level daily metrics ───────────────────────────────────────────────

export interface InsightsAccountMetricsDay {
  id: number;
  tenantId: number;
  accountId: number;
  platform: string;
  /** YYYY-MM-DD */
  date: string;
  views: number;
  watchTimeMinutes: number;
  followers: number;
  followersDelta: number;
  likes: number;
  commentsCount: number;
  shares: number;
}

// ── Post-level daily metrics ──────────────────────────────────────────────────

export interface InsightsPostMetricsDay {
  id: number;
  tenantId: number;
  postId: number;
  platform: string;
  /** YYYY-MM-DD */
  date: string;
  views: number;
  watchTimeMinutes: number;
  avgViewDurationSec: number;
  avgViewPercentage: number;
  likes: number;
  commentsCount: number;
  shares: number;
}

// ── Comments ──────────────────────────────────────────────────────────────────

export interface InsightsComment {
  id: number;
  tenantId: number;
  postId: number;
  platform: string;
  externalCommentId: string;
  receivedAt: Date | null;
  authorHandle: string | null;
  bodyText: string | null;
  /** Filled by the LLM classification worker (Phase 6). */
  sentimentLabel: string | null;
}

export interface InsightsCommentClassification {
  commentId: number;
  tenantId: number;
  sentimentLabel: string;
  sentimentScore: number | null;
  intentLabel: string | null;
  classifiedAt: Date;
  modelId: string | null;
  promptVersion: string | null;
}

// ── Audience snapshots ────────────────────────────────────────────────────────

export interface InsightsAudienceSnapshot {
  id: number;
  tenantId: number;
  accountId: number;
  platform: string;
  /** YYYY-MM-DD */
  snapshotDate: string;
  data: Record<string, unknown>;
}

// ── Narratives ────────────────────────────────────────────────────────────────

export type NarrativePeriod = 'weekly' | 'monthly';

export interface InsightsNarrative {
  id: number;
  tenantId: number;
  period: NarrativePeriod;
  periodStartDate: string; // YYYY-MM-DD
  periodEndDate: string;   // YYYY-MM-DD
  platform: string;
  sectionKey: string;
  bodyMarkdown: string | null;
  generatedAt: Date;
  modelId: string | null;
  promptVersion: string | null;
}

// ── Sync audit ────────────────────────────────────────────────────────────────

export type SyncTrigger = 'interval' | 'manual' | 'backfill' | 'webhook';
export type SyncStatus = 'running' | 'ok' | 'error';

export interface InsightsSyncRun {
  id: number;
  tenantId: number;
  accountId: number;
  platform: string;
  trigger: SyncTrigger;
  startedAt: Date;
  finishedAt: Date | null;
  status: SyncStatus;
  postsSeen: number;
  commentsSeen: number;
  apiUnitsUsed: number;
  errorMessage: string | null;
}

// ── LLM call audit ────────────────────────────────────────────────────────────

export interface InsightsLlmCall {
  id: number;
  tenantId: number;
  purpose: string;
  modelId: string;
  promptTokens: number | null;
  completionTokens: number | null;
  costCents: number | null;
  calledAt: Date;
  durationMs: number | null;
  success: boolean;
  errorMessage: string | null;
}
