/**
 * backend/marketing/weekly-results-report.ts
 *
 * S5-1 / AA-110 (gap F1b) — the weekly results report builder.
 * Spec: docs/plans/2026-06-01-weekly-results-next-action.md (phases A + D.2).
 *
 * A READER. It never fetches Meta, never publishes, and writes nothing — the
 * MVP slice is read-only, so its rollback is the flag alone.
 *
 * The governing rule is the honesty contract: NEVER fabricate a winner. When
 * this tenant has no insights account or no synced metrics in the window, the
 * best/weakest sections report `available:false` with a reason. A guessed
 * ranking would be worse than an empty one.
 *
 * Guardrail #1: queries run SEQUENTIALLY on one caller-supplied client. No
 * `Promise.all` fan-out — `/dashboard/results` is already on the slow
 * list-hydration path and this panel must not add pool contention to it.
 *
 * Deliberately NOT used: `backend/memory/perf-insights-read.ts` /
 * `insights-513-contract.ts`. Engagement comes from the shipped insights read
 * model. (Pinned by a source-level test.)
 */

import pool, { type PoolClient } from '@/lib/db';
import { LATEST_POST_METRICS_LATERAL } from '@/backend/insights/latest-post-metrics-sql';
import { resolveReportWeek, type ReportWeek } from './weekly-results-week';

// ── Public shapes ────────────────────────────────────────────────────────────

export interface WeeklyResultsPostRef {
  postId: string;
  platform: string;
  title: string | null;
  permalink: string | null;
  /** Human-readable metric the ranking used, e.g. "1,240 reach". */
  metricLabel: string;
  reach: number;
}

export type RankingUnavailableReason = 'insights_not_connected' | 'no_posts_in_window';

export interface RankedSlot {
  available: boolean;
  reason?: RankingUnavailableReason;
  post?: WeeklyResultsPostRef;
}

export interface WeeklyResultsLearning {
  id: string;
  /** Always null in the MVP — Honcho finding surfacing is the deferred D.1 slice. */
  findingId: null;
  source: 'publish_reliability';
  title: string;
  body: string;
}

export interface WeeklyResultsNextAction {
  title: string;
  body: string;
  href?: string;
}

export interface WeeklyResultsReport {
  week: { iso: string; startYmd: string; endYmd: string; label: string };
  published: { total: number; byChannel: Record<string, number>; bySurface: Record<string, number> };
  skipped: { total: number; note: string };
  blocked: { total: number; failedCount: number; reconnect: boolean; reconnectChannels: string[] };
  /**
   * Dispatches parked for a human to reconcile. Deliberately its own count and
   * NOT folded into `blocked`: a `manual_reconciliation` row may well have
   * reached the platform (the publish path parks it precisely because the
   * outcome is unknown), so calling it "blocked" would state something untrue.
   */
  needsReconciliation: { total: number };
  topChannel: { channel: string | null; basis: 'published_count' | 'reach'; value: number };
  bestPost: RankedSlot;
  weakestPost: RankedSlot;
  insightsConnected: boolean;
  learnings: WeeklyResultsLearning[];
  nextAction: WeeklyResultsNextAction | null;
}

/** Minimal query surface — satisfied by pg.Pool and pg.PoolClient alike. */
export interface WeeklyResultsQueryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

// ── SQL ──────────────────────────────────────────────────────────────────────

/** $1 tenant, $2 week start (inclusive), $3 week end (exclusive). */
export const PUBLISHED_BY_CHANNEL_SQL = `
  SELECT
    COALESCE(NULLIF(lower(platform), ''), 'unknown') AS platform,
    COALESCE(NULLIF(lower(surface), ''), 'feed')     AS surface,
    count(*)::int                                    AS n
  FROM posts
  WHERE tenant_id = $1
    AND published_status = 'published'
    AND platform_post_id IS NOT NULL
    AND published_at >= $2
    AND published_at <  $3
  GROUP BY 1, 2
`;

/**
 * Dispatch outcomes for the week.
 *
 * `skipped` counts rows still 'pending' whose slot has passed — due but never
 * dispatched. The `scheduled_for < now()` clause matters only for a `?week=`
 * override pointing at a future week; without it those rows would be reported
 * as skipped before they were ever due.
 *
 * There is NO per-row failure code on scheduled_posts (no `last_error_code`
 * column), so failures are a single count and the auth signal comes from
 * oauth_connections separately.
 */
export const DISPATCH_OUTCOMES_SQL = `
  SELECT
    count(*) FILTER (WHERE dispatch_status = 'pending' AND scheduled_for < now())::int AS skipped,
    count(*) FILTER (WHERE dispatch_status = 'failed')::int                            AS failed,
    count(*) FILTER (WHERE dispatch_status = 'manual_reconciliation')::int             AS needs_reconciliation
  FROM scheduled_posts
  WHERE tenant_id = $1
    AND scheduled_for >= $2
    AND scheduled_for <  $3
`;

/** The #519 reconnect surface — the report's ONLY source for "auth blocked". */
export const RECONNECT_CHANNELS_SQL = `
  SELECT DISTINCT lower(provider) AS provider
  FROM oauth_connections
  WHERE tenant_id = $1
    AND status = 'reauthorization_required'
  ORDER BY 1
`;

/**
 * Per-tenant availability check. `insights_accounts` has NO `status` column —
 * a row exists once the account is connected — so connectedness is row
 * existence, paired with "did anything actually sync for this window".
 */
export const INSIGHTS_AVAILABILITY_SQL = `
  SELECT
    (SELECT count(*) FROM insights_accounts WHERE tenant_id = $1)::int AS account_count,
    (SELECT count(*)
       FROM insights_posts p
       JOIN insights_post_metrics_daily d
         ON d.post_id = p.id AND d.tenant_id = p.tenant_id
      WHERE p.tenant_id = $1
        AND p.published_at >= $2
        AND p.published_at <  $3)::int AS metric_row_count
`;

/**
 * In-window posts with their LATEST lifetime snapshot.
 *
 * S2-1/AA-92 is load-bearing here: rows in insights_post_metrics_daily are
 * lifetime-CUMULATIVE, so SUMming a post's dated rows inflates it ~N× over N
 * sync days and would hand the "best post" crown to whichever post has been
 * synced longest. `LATEST_POST_METRICS_LATERAL` is the shared source of truth
 * for reading exactly one snapshot per post; aggregate ACROSS posts, never
 * across one post's rows.
 *
 * Ordered once, descending. Best = first row, weakest = last — literally the
 * same ranking inverted, so the two can never disagree about the ordering.
 *
 * Attribution scope (S4-1) is deliberately NOT applied: that flag ships default
 * OFF, and letting it silently change which posts this report counts would make
 * the panel's numbers depend on an unrelated rollout switch.
 */
export const WEEK_POST_RANKING_SQL = `
  WITH post_metrics AS (
    SELECT
      p.id                                AS id,
      COALESCE(NULLIF(lower(p.platform), ''), 'unknown') AS platform,
      p.title                             AS title,
      p.caption                           AS caption,
      p.permalink                         AS permalink,
      COALESCE(m.reach, m.views, 0)       AS reach
    FROM insights_posts p
    ${LATEST_POST_METRICS_LATERAL}
    WHERE p.tenant_id    = $1
      AND p.published_at >= $2
      AND p.published_at <  $3
  )
  SELECT * FROM post_metrics
  ORDER BY reach DESC, id ASC
`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function toInt(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function titleCaseChannel(channel: string): string {
  if (channel === 'unknown') return 'Unknown';
  return channel.charAt(0).toUpperCase() + channel.slice(1);
}

function postTitle(row: { title: string | null; caption: string | null }): string | null {
  const t = row.title?.trim();
  if (t) return t;
  const c = row.caption?.trim();
  if (!c) return null;
  return c.length > 80 ? `${c.slice(0, 77)}…` : c;
}

function unavailable(reason: RankingUnavailableReason): RankedSlot {
  return { available: false, reason };
}

interface RankingRow extends Record<string, unknown> {
  id: number | string;
  platform: string;
  title: string | null;
  caption: string | null;
  permalink: string | null;
  reach: number | string;
}

function toPostRef(row: RankingRow): WeeklyResultsPostRef {
  const reach = toInt(row.reach);
  return {
    postId: String(row.id),
    platform: row.platform,
    title: postTitle(row),
    permalink: row.permalink,
    metricLabel: `${reach.toLocaleString('en-US')} reach`,
    reach,
  };
}

/**
 * D.2 — the derived, insights-free publish-reliability learning + the single
 * next action. Pure so the priority order is unit-testable on its own.
 *
 * Priority: reconnect > other failures > skipped > calm. Reconnect wins because
 * it is the only one the operator can act on before the next run, and it blocks
 * every future post on that channel rather than one week's.
 *
 * Every learning carries `findingId: null` — these are report-derived and
 * informational, not Honcho findings, so nothing here is promotable to memory.
 * The approve-able cards arrive with the deferred D.1/E slice.
 */
export function deriveLearnings(input: {
  blocked: WeeklyResultsReport['blocked'];
  skipped: WeeklyResultsReport['skipped'];
  needsReconciliation: WeeklyResultsReport['needsReconciliation'];
  published: { total: number };
}): { learnings: WeeklyResultsLearning[]; nextAction: WeeklyResultsNextAction | null } {
  const learnings: WeeklyResultsLearning[] = [];
  let nextAction: WeeklyResultsNextAction | null = null;

  const RECONNECT_HREF = '/dashboard/settings/channel-integrations';

  if (input.blocked.reconnect) {
    const channels = input.blocked.reconnectChannels.map(titleCaseChannel);
    const list = channels.length > 0 ? channels.join(' and ') : 'A connected channel';
    learnings.push({
      id: 'reconnect-required',
      findingId: null,
      source: 'publish_reliability',
      title: 'A channel connection needs reauthorizing',
      body:
        `${list} ${channels.length === 1 ? 'needs' : 'need'} to be reconnected. ` +
        'Posts cannot publish to a channel whose connection has expired.',
    });
    nextAction = {
      title: `Reconnect ${list} before next week's run`,
      body: 'Reauthorize the connection so the next scheduled posts can publish.',
      href: RECONNECT_HREF,
    };
  }

  if (input.blocked.failedCount > 0) {
    const n = input.blocked.failedCount;
    learnings.push({
      id: 'dispatch-failures',
      findingId: null,
      source: 'publish_reliability',
      title: `${n} post${n === 1 ? '' : 's'} failed to publish`,
      body:
        `${n} scheduled post${n === 1 ? '' : 's'} ended in a failed dispatch this week. ` +
        'Open the publish queue to see the recorded error for each.',
    });
    nextAction ??= {
      title: 'Review this week’s failed posts',
      body: 'Check the publish queue for the recorded error before the next run.',
      href: '/dashboard/publish-status',
    };
  }

  if (input.skipped.total > 0) {
    const n = input.skipped.total;
    learnings.push({
      id: 'skipped-posts',
      findingId: null,
      source: 'publish_reliability',
      title: `${n} scheduled post${n === 1 ? '' : 's'} never dispatched`,
      body:
        n === 1
          ? '1 post was still waiting in the queue after its scheduled time passed.'
          : `${n} posts were still waiting in the queue after their scheduled times passed.`,
    });
    nextAction ??= {
      title: 'Check why scheduled posts did not dispatch',
      body: 'Posts left pending past their slot never reached a platform.',
      href: '/dashboard/publish-status',
    };
  }

  if (input.needsReconciliation.total > 0) {
    const n = input.needsReconciliation.total;
    learnings.push({
      id: 'needs-reconciliation',
      findingId: null,
      source: 'publish_reliability',
      title: `${n} post${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} manual confirmation`,
      body:
        'The platform did not confirm the outcome, so these were parked for a human to ' +
        'check rather than retried automatically. They may or may not have gone live.',
    });
    nextAction ??= {
      title: 'Confirm the posts awaiting reconciliation',
      body: 'Check whether these reached the platform before re-publishing them.',
      href: '/dashboard/publish-status',
    };
  }

  if (learnings.length === 0) {
    learnings.push({
      id: 'clean-week',
      findingId: null,
      source: 'publish_reliability',
      title:
        input.published.total > 0
          ? 'Every scheduled post published cleanly'
          : 'No posts were scheduled this week',
      body:
        input.published.total > 0
          ? 'Nothing was blocked, skipped, or left waiting.'
          : 'There is nothing to review for this week.',
    });
  }

  return { learnings, nextAction };
}

// ── Main builder ─────────────────────────────────────────────────────────────

export async function buildWeeklyResultsReport(
  tenantId: number,
  opts: { weekIso?: string | null; now?: Date } = {},
  db?: WeeklyResultsQueryable,
): Promise<WeeklyResultsReport> {
  const week: ReportWeek = resolveReportWeek(opts.weekIso, opts.now ?? new Date());

  let client: PoolClient | null = null;
  let queryable: WeeklyResultsQueryable;
  if (db) {
    queryable = db;
  } else {
    client = await pool.connect();
    queryable = client as unknown as WeeklyResultsQueryable;
  }

  const params = [tenantId, week.start, week.end];

  try {
    // ── 1. Published (state Aries owns — always available, no insights) ──────
    const publishedRes = await queryable.query<{ platform: string; surface: string; n: number }>(
      PUBLISHED_BY_CHANNEL_SQL,
      params,
    );
    const byChannel: Record<string, number> = {};
    const bySurface: Record<string, number> = {};
    let publishedTotal = 0;
    for (const row of publishedRes.rows) {
      const n = toInt(row.n);
      byChannel[row.platform] = (byChannel[row.platform] ?? 0) + n;
      bySurface[row.surface] = (bySurface[row.surface] ?? 0) + n;
      publishedTotal += n;
    }

    // ── 2. Dispatch outcomes ────────────────────────────────────────────────
    const outcomesRes = await queryable.query<{
      skipped: number;
      failed: number;
      needs_reconciliation: number;
    }>(DISPATCH_OUTCOMES_SQL, params);
    const outcomes = outcomesRes.rows[0];
    const skippedTotal = toInt(outcomes?.skipped);
    const failedCount = toInt(outcomes?.failed);
    const needsReconciliationTotal = toInt(outcomes?.needs_reconciliation);

    // ── 3. Reconnect signal (#519) ──────────────────────────────────────────
    const reconnectRes = await queryable.query<{ provider: string }>(RECONNECT_CHANNELS_SQL, [
      tenantId,
    ]);
    const reconnectChannels = reconnectRes.rows
      .map((r) => String(r.provider || '').trim())
      .filter(Boolean);

    // ── 4. Is engagement ranking available for THIS tenant? ─────────────────
    const availabilityRes = await queryable.query<{
      account_count: number;
      metric_row_count: number;
    }>(INSIGHTS_AVAILABILITY_SQL, params);
    const accountCount = toInt(availabilityRes.rows[0]?.account_count);
    const metricRowCount = toInt(availabilityRes.rows[0]?.metric_row_count);
    const insightsConnected = accountCount > 0 && metricRowCount > 0;

    // ── 5. Ranking — only when we actually have data to rank ────────────────
    let bestPost: RankedSlot = unavailable('insights_not_connected');
    let weakestPost: RankedSlot = unavailable('insights_not_connected');
    let reachByChannel: Record<string, number> = {};

    if (insightsConnected) {
      const rankingRes = await queryable.query<RankingRow>(WEEK_POST_RANKING_SQL, params);
      const rows = rankingRes.rows;
      if (rows.length === 0) {
        bestPost = unavailable('no_posts_in_window');
        weakestPost = unavailable('no_posts_in_window');
      } else {
        bestPost = { available: true, post: toPostRef(rows[0]) };
        // Same ordering, inverted. With a single post best === weakest, which is
        // truthful: it is both the best and the worst post of the week.
        weakestPost = { available: true, post: toPostRef(rows[rows.length - 1]) };
        reachByChannel = rows.reduce<Record<string, number>>((acc, row) => {
          acc[row.platform] = (acc[row.platform] ?? 0) + toInt(row.reach);
          return acc;
        }, {});
      }
    }

    // ── 6. Top channel — basis follows the data, and is always labeled ──────
    const reachTotal = Object.values(reachByChannel).reduce((a, b) => a + b, 0);
    const useReach = insightsConnected && reachTotal > 0;
    const basisSource = useReach ? reachByChannel : byChannel;
    let topChannel: WeeklyResultsReport['topChannel'] = {
      channel: null,
      basis: useReach ? 'reach' : 'published_count',
      value: 0,
    };
    for (const [channel, value] of Object.entries(basisSource)) {
      if (value > topChannel.value) {
        topChannel = { channel, basis: useReach ? 'reach' : 'published_count', value };
      }
    }

    const blocked = {
      total: failedCount,
      failedCount,
      reconnect: reconnectChannels.length > 0,
      reconnectChannels,
    };
    const skipped = {
      total: skippedTotal,
      note: 'Scheduled posts still pending after their slot passed.',
    };
    const needsReconciliation = { total: needsReconciliationTotal };

    const { learnings, nextAction } = deriveLearnings({
      blocked,
      skipped,
      needsReconciliation,
      published: { total: publishedTotal },
    });

    return {
      week: { iso: week.iso, startYmd: week.startYmd, endYmd: week.endYmd, label: week.label },
      published: { total: publishedTotal, byChannel, bySurface },
      skipped,
      blocked,
      needsReconciliation,
      topChannel,
      bestPost,
      weakestPost,
      insightsConnected,
      learnings,
      nextAction,
    };
  } finally {
    client?.release();
  }
}
