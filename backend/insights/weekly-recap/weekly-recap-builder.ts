/**
 * backend/insights/weekly-recap/weekly-recap-builder.ts
 *
 * S5-1 / AA-110 (gap F1b) — the weekly recap builder. Relocated out of
 * backend/marketing/ into the insights section family by AA-229/PR2b, section
 * 10 — Weekly Recap (`GET /api/insights/weekly-recap`). The move is required,
 * not cosmetic: tests/insights-route-auth-tenant-isolation.test.ts only scans
 * a handler's tenant-scoped SQL under backend/insights/**, and this module is
 * where that SQL lives.
 * Spec: docs/plans/2026-06-01-weekly-results-next-action.md (phases A + D.2).
 *
 * A READER. It never fetches Meta, never publishes, and writes nothing — the
 * MVP slice is read-only, so its rollback is the flag alone.
 *
 * AA-229/PR2b: best/weakest post ranking has LEFT this section — Section 6
 * (Top Performing Content, `backend/insights/top/`) owns it now. The unbounded
 * per-post ranking query this section used to run purely to compute best/
 * weakest (and, as a by-product, per-channel reach) is gone; `topChannel`'s
 * reach basis is now a bounded GROUP BY aggregate (see CHANNEL_REACH_SQL).
 *
 * Guardrail #1: queries run SEQUENTIALLY on one caller-supplied client — this
 * builder holds no pooled client of its own; the handler
 * (backend/insights/weekly-recap/handler.ts) owns the ONE
 * pool.connect()/release() pair and hands it in. No `Promise.all` fan-out —
 * `/insights` is already on the slow list-hydration path and this section must
 * not add pool contention to it.
 *
 * Engagement comes from the shipped insights read model directly — this
 * module deliberately does not reach through any legacy performance-memory
 * bridge for it. It also deliberately does not narrow its candidate set by
 * publish-source coverage the way some other insights sections do once a
 * tenant backfills past a threshold: that kind of scoping ships default OFF
 * elsewhere, and letting it silently change which posts THIS section counts
 * would make the panel's numbers depend on an unrelated rollout switch. (Both
 * pinned by a source-level test — see tests/insights-weekly-recap-builder.test.ts.)
 */

import { LATEST_POST_METRICS_LATERAL } from '@/backend/insights/latest-post-metrics-sql';
import { resolveReportWeek, type ReportWeek } from './weekly-recap-week';

// ── Public shapes ────────────────────────────────────────────────────────────

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
 * `failure_class` records the dispatch taxonomy, but it is historical evidence,
 * not the connection's current health. The live auth signal therefore comes
 * from oauth_connections separately.
 */
export const DISPATCH_OUTCOMES_SQL = `
  SELECT
    count(*) FILTER (WHERE dispatch_status = 'pending' AND scheduled_for < now())::int AS skipped,
    count(*) FILTER (WHERE dispatch_status IN ('failed', 'dead_letter'))::int           AS failed,
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
 * Per-platform reach for the week, from each post's LATEST lifetime snapshot.
 *
 * AA-229/PR2b: replaces the old unbounded per-post WEEK_POST_RANKING_SQL
 * (every in-window row, no LIMIT) that this section used to run purely to
 * compute best/weakest post — a ranking that has since left this section for
 * Section 6 (Top). Deleting that query outright would have silently
 * downgraded `topChannel`, whose reach-vs-published_count basis was a
 * BY-PRODUCT of the same rows: it would flip from `basis:'reach'` (e.g.
 * "Instagram — 12,400 reach") to `basis:'published_count'` ("Instagram — 4
 * posts") with no error. This aggregate produces the SAME number on the SAME
 * basis with no per-post row transfer.
 *
 * S2-1/AA-92 is still load-bearing: rows in insights_post_metrics_daily are
 * lifetime-CUMULATIVE, so SUMming a post's own dated rows inflates it ~N× over
 * N sync days. `LATEST_POST_METRICS_LATERAL` reads exactly one snapshot per
 * post; the SUM below aggregates ACROSS posts (one snapshot each), never
 * across one post's dated rows.
 */
export const CHANNEL_REACH_SQL = `
  SELECT
    COALESCE(NULLIF(lower(p.platform), ''), 'unknown') AS platform,
    SUM(COALESCE(m.reach, m.views, 0))                  AS reach
  FROM insights_posts p
  ${LATEST_POST_METRICS_LATERAL}
  WHERE p.tenant_id    = $1
    AND p.published_at >= $2
    AND p.published_at <  $3
  GROUP BY 1
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

/**
 * AA-229/PR2b: `db` is now REQUIRED, matching `buildTopSnapshot(…, client)` —
 * the handler already holds a pooled client and this builder must not acquire
 * (or release) a second one.
 */
export async function buildWeeklyResultsReport(
  tenantId: number,
  opts: { weekIso?: string | null; now?: Date } = {},
  db: WeeklyResultsQueryable,
): Promise<WeeklyResultsReport> {
  const week: ReportWeek = resolveReportWeek(opts.weekIso, opts.now ?? new Date());
  const params = [tenantId, week.start, week.end];

  // ── 1. Published (state Aries owns — always available, no insights) ──────
  const publishedRes = await db.query<{ platform: string; surface: string; n: number }>(
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
  const outcomesRes = await db.query<{
    skipped: number;
    failed: number;
    needs_reconciliation: number;
  }>(DISPATCH_OUTCOMES_SQL, params);
  const outcomes = outcomesRes.rows[0];
  const skippedTotal = toInt(outcomes?.skipped);
  const failedCount = toInt(outcomes?.failed);
  const needsReconciliationTotal = toInt(outcomes?.needs_reconciliation);

  // ── 3. Reconnect signal (#519) ──────────────────────────────────────────
  const reconnectRes = await db.query<{ provider: string }>(RECONNECT_CHANNELS_SQL, [tenantId]);
  const reconnectChannels = reconnectRes.rows
    .map((r) => String(r.provider || '').trim())
    .filter(Boolean);

  // ── 4. Is engagement data available for THIS tenant? ────────────────────
  const availabilityRes = await db.query<{
    account_count: number;
    metric_row_count: number;
  }>(INSIGHTS_AVAILABILITY_SQL, params);
  const accountCount = toInt(availabilityRes.rows[0]?.account_count);
  const metricRowCount = toInt(availabilityRes.rows[0]?.metric_row_count);
  const insightsConnected = accountCount > 0 && metricRowCount > 0;

  // ── 5. Per-channel reach — only when we actually have data to aggregate ──
  let reachByChannel: Record<string, number> = {};
  if (insightsConnected) {
    const reachRes = await db.query<{ platform: string; reach: number | string }>(
      CHANNEL_REACH_SQL,
      params,
    );
    reachByChannel = reachRes.rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.platform] = (acc[row.platform] ?? 0) + toInt(row.reach);
      return acc;
    }, {});
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
    insightsConnected,
    learnings,
    nextAction,
  };
}
