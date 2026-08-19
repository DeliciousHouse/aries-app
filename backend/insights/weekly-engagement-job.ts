import { mostRecentCompletedWeek } from './weekly-recap/weekly-recap-week';

export const ENGAGEMENT_TREND_FLAT_THRESHOLD_PCT = 5;

export interface WeeklyEngagementQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface WeeklyEngagementScheduleState {
  completedWeekIso: string | null;
}

export const WEEKLY_ENGAGEMENT_METRICS_SQL = `
  SELECT
    p.tenant_id,
    CASE WHEN p.published_at >= ($3::date::timestamp AT TIME ZONE 'UTC')
      THEN 'current' ELSE 'previous' END AS period,
    m.likes,
    m.comments_count,
    m.shares,
    m.saves
  FROM insights_posts p
  JOIN LATERAL (
    SELECT d.likes, d.comments_count, d.shares, d.saves
    FROM insights_post_metrics_daily d
    WHERE d.tenant_id = p.tenant_id
      AND d.post_id = p.id
      AND d.date < CASE
        WHEN p.published_at >= ($3::date::timestamp AT TIME ZONE 'UTC') THEN $2::date
        ELSE $3::date
      END
    ORDER BY d.date DESC
    LIMIT 1
  ) m ON true
  WHERE p.published_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
    AND p.published_at < ($2::date::timestamp AT TIME ZONE 'UTC')
  ORDER BY p.tenant_id, p.published_at, p.id
`;

export const WEEKLY_ENGAGEMENT_UPSERT_SQL = `
  INSERT INTO insights_engagement_trends_weekly (
    tenant_id,
    week_start,
    current_post_count,
    previous_post_count,
    current_average,
    previous_average,
    change_percent,
    direction,
    computed_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
  ON CONFLICT (tenant_id, week_start)
  DO UPDATE SET
    current_post_count = EXCLUDED.current_post_count,
    previous_post_count = EXCLUDED.previous_post_count,
    current_average = EXCLUDED.current_average,
    previous_average = EXCLUDED.previous_average,
    change_percent = EXCLUDED.change_percent,
    direction = EXCLUDED.direction,
    computed_at = now()
`;

export interface EngagementMetricRow {
  tenant_id: number;
  period: 'current' | 'previous';
  likes: number | string | null;
  comments_count: number | string | null;
  shares: number | string | null;
  saves: number | string | null;
}

export type EngagementTrendDirection =
  | 'upward'
  | 'downward'
  | 'flat'
  | 'insufficient_data';

export interface EngagementTrendSummary {
  tenantId: number;
  currentPostCount: number;
  previousPostCount: number;
  currentAverage: number | null;
  previousAverage: number | null;
  changePercent: number | null;
  direction: EngagementTrendDirection;
}

type Totals = {
  current: { engagement: number; posts: number };
  previous: { engagement: number; posts: number };
};

function metricNumber(value: number | string | null): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function summarizeEngagementRows(
  rows: readonly EngagementMetricRow[],
): EngagementTrendSummary[] {
  const byTenant = new Map<number, Totals>();
  for (const row of rows) {
    const totals = byTenant.get(row.tenant_id) ?? {
      current: { engagement: 0, posts: 0 },
      previous: { engagement: 0, posts: 0 },
    };
    const bucket = totals[row.period];
    bucket.engagement +=
      metricNumber(row.likes) +
      metricNumber(row.comments_count) +
      metricNumber(row.shares) +
      metricNumber(row.saves);
    bucket.posts += 1;
    byTenant.set(row.tenant_id, totals);
  }

  return [...byTenant.entries()]
    .sort(([a], [b]) => a - b)
    .map(([tenantId, totals]) => {
      const currentAverage = totals.current.posts
        ? round(totals.current.engagement / totals.current.posts, 2)
        : null;
      const previousAverage = totals.previous.posts
        ? round(totals.previous.engagement / totals.previous.posts, 2)
        : null;

      let changePercent: number | null = null;
      let direction: EngagementTrendDirection = 'insufficient_data';
      if (currentAverage !== null && previousAverage !== null) {
        if (previousAverage === 0) {
          direction = currentAverage === 0 ? 'flat' : 'upward';
        } else {
          changePercent = round(((currentAverage - previousAverage) / previousAverage) * 100, 1);
          direction =
            changePercent > ENGAGEMENT_TREND_FLAT_THRESHOLD_PCT
              ? 'upward'
              : changePercent < -ENGAGEMENT_TREND_FLAT_THRESHOLD_PCT
                ? 'downward'
                : 'flat';
        }
      }

      return {
        tenantId,
        currentPostCount: totals.current.posts,
        previousPostCount: totals.previous.posts,
        currentAverage,
        previousAverage,
        changePercent,
        direction,
      };
    });
}

export async function materializeWeeklyEngagementTrends(
  db: WeeklyEngagementQueryable,
  now: Date = new Date(),
): Promise<{ weekIso: string; tenantsScanned: number; summariesWritten: number }> {
  const week = mostRecentCompletedWeek(now);
  const previousStart = new Date(week.start.getTime() - 7 * 24 * 60 * 60 * 1000);
  const previousStartYmd = previousStart.toISOString().slice(0, 10);
  const metricResult = await db.query(WEEKLY_ENGAGEMENT_METRICS_SQL, [
    previousStartYmd,
    week.endYmd,
    week.startYmd,
  ]);
  const summaries = summarizeEngagementRows(metricResult.rows as EngagementMetricRow[]);
  let summariesWritten = 0;

  for (const summary of summaries) {
    await db.query(WEEKLY_ENGAGEMENT_UPSERT_SQL, [
      summary.tenantId,
      week.startYmd,
      summary.currentPostCount,
      summary.previousPostCount,
      summary.currentAverage,
      summary.previousAverage,
      summary.changePercent,
      summary.direction,
    ]);
    summariesWritten += 1;
  }

  return {
    weekIso: week.iso,
    tenantsScanned: summaries.length,
    summariesWritten,
  };
}

export async function runWeeklyEngagementIfDue(
  db: WeeklyEngagementQueryable,
  state: WeeklyEngagementScheduleState,
  now: Date = new Date(),
): Promise<Awaited<ReturnType<typeof materializeWeeklyEngagementTrends>> | null> {
  const weekIso = mostRecentCompletedWeek(now).iso;
  if (state.completedWeekIso === weekIso) return null;

  const report = await materializeWeeklyEngagementTrends(db, now);
  state.completedWeekIso = report.weekIso;
  return report;
}
