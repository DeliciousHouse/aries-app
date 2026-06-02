/**
 * backend/insights/types.ts
 *
 * Domain types that mirror the insights_* DB tables.
 * Route handlers, read-path queries, and the sync dispatcher
 * all use these shapes — never raw pg row objects.
 *
 * Field names are camelCase equivalents of the DB snake_case columns.
 * Keep this file in sync with scripts/init-db.js (the insights_ block).
 */

// ── Accounts ──────────────────────────────────────────────────────────────────

export interface InsightsAccount {
  id: number;
  tenantId: number;
  platform: string;
  externalAccountId: string;
  displayName: string | null;
  connectedAt: Date;
  lastSyncAt: Date | null;
  backfillCompletedAt: Date | null;
  /** Arbitrary platform-specific data (oauth scopes, channel handle, etc.). */
  platformData: Record<string, unknown>;
}

// ── Posts ─────────────────────────────────────────────────────────────────────

export type PostMediaType = 'video' | 'short' | 'reel' | 'image' | 'carousel' | 'story' | 'text' | 'live';

export interface InsightsPost {
  id: number;
  tenantId: number;
  accountId: number;
  platform: string;
  externalPostId: string;
  publishedAt: Date;              // NOT NULL in DB
  mediaType: PostMediaType;       // NOT NULL in DB
  title: string | null;
  /** YouTube description / Instagram+Facebook caption. */
  caption: string | null;
  permalink: string | null;
  durationSeconds: number | null;
  /** Stores thumbnailUrl and any other platform fields not in dedicated columns. */
  platformData: Record<string, unknown>;
  fetchedAt: Date;
  lastMetricsFetchedAt: Date | null;
}

// ── Account-level daily metrics ───────────────────────────────────────────────

export interface InsightsAccountMetricsDay {
  tenantId: number;
  accountId: number;
  platform: string;
  /** YYYY-MM-DD */
  date: string;
  views: number | null;
  /** Unique viewers. NULL for platforms without this concept (e.g. YouTube). */
  reach: number | null;
  watchTimeMinutes: number | null;
  followers: number | null;
  followersDelta: number | null;
  profileVisits: number | null;
  likes: number | null;
  commentsCount: number | null;
  shares: number | null;
  /** NULL for platforms that don't expose saves. */
  saves: number | null;
  platformData: Record<string, unknown>;
  rawSource: Record<string, unknown>;
}

// ── Post-level daily metrics ──────────────────────────────────────────────────

export interface InsightsPostMetricsDay {
  tenantId: number;
  postId: number;
  platform: string;
  /** YYYY-MM-DD */
  date: string;
  views: number | null;
  reach: number | null;
  watchTimeMinutes: number | null;
  avgViewDurationSec: number | null;
  avgViewPercentage: number | null;
  likes: number | null;
  commentsCount: number | null;
  shares: number | null;
  saves: number | null;
  platformData: Record<string, unknown>;
  rawSource: Record<string, unknown>;
}

// ── Comments ──────────────────────────────────────────────────────────────────

export interface InsightsComment {
  id: number;
  tenantId: number;
  postId: number;
  platform: string;
  externalCommentId: string;
  receivedAt: Date;
  authorHandle: string | null;
  bodyText: string;              // NOT NULL in DB
  platformData: Record<string, unknown>;
}

export interface InsightsCommentClassification {
  commentId: number;
  tenantId: number;
  /** 'positive' | 'neutral' | 'negative' */
  sentiment: string | null;
  isLead: boolean | null;
  /** 'question' | 'compliment' | 'complaint' | 'spam' | 'other' */
  category: string | null;
  classifierVersion: string;
  costCents: number;
  classifiedAt: Date;
}

// ── Audience snapshots ────────────────────────────────────────────────────────

export interface InsightsAudienceSnapshot {
  tenantId: number;
  accountId: number;
  platform: string;
  /** YYYY-MM-DD */
  snapshotDate: string;
  /** Demographics payload — shape varies by platform. NULL when unavailable. */
  demographics: Record<string, unknown> | null;
  unavailableReason: string | null;
  rawSource: Record<string, unknown>;
}

// ── Narratives ────────────────────────────────────────────────────────────────

/** Values match the DB CHECK / convention: 'week' | '30day' | '90day' */
export type NarrativePeriod = 'week' | '30day' | '90day';

export interface InsightsNarrative {
  id: number;
  tenantId: number;
  period: NarrativePeriod;
  /** Platform identifier or 'all' for cross-platform. */
  platform: string;
  /** E.g. 'hero' | 'goal' | 'attention' | 'recommendations' */
  sectionKey: string;
  /** JSONB — shape defined per section_key by the narrative generator. */
  body: Record<string, unknown>;
  promptVersion: string;
  model: string;
  /** SHA-256 of the input data — used to skip regeneration when numbers haven't changed. */
  inputHash: string;
  costCents: number;
  generatedAt: Date;
}

// ── Sync audit ────────────────────────────────────────────────────────────────

/** Values match insights_sync_runs.trigger column. */
export type SyncTrigger = 'interval' | 'handler' | 'backfill';
/** Values match insights_sync_runs.status column. */
export type SyncStatus = 'running' | 'ok' | 'partial' | 'failed';

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
  /** 'classify_comment' | 'generate_narrative' */
  purpose: string;
  model: string;
  costCents: number;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  succeeded: boolean;
  errorCode: string | null;
  calledAt: Date;
}
