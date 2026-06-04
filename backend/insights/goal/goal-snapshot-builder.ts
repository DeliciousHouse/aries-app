/**
 * backend/insights/goal/goal-snapshot-builder.ts
 *
 * Fetches the goal-relevant metric for (tenant, period, platform) and
 * returns a GoalSnapshot used by the template builder.
 *
 * Goal → primary metric mapping:
 *   lead_generation  → comments classified as is_lead (insights_comment_classifications)
 *   content_growth   → net new followers (SUM of followers_delta)
 *   product_sales    → saves (best native purchase-intent proxy)
 *   brand_awareness  → reach (COALESCE(reach, views))
 *
 * contributors: top 2 posts that drove the goal metric this period.
 */

import pool from '@/lib/db';
import type { NarrativePeriod } from '../narrative/snapshot-builder';

export type GoalType = 'lead_generation' | 'content_growth' | 'product_sales' | 'brand_awareness';

export interface GoalContributor {
  title: string;
  platform: string;
  metricValue: number;
  metricLabel: string;
}

export interface GoalSnapshot {
  goal: GoalType;
  goalLabel: string;
  platform: string;
  period: NarrativePeriod;
  metricValue: number;
  metricValuePrev: number;
  metricDelta: number;
  metricLabel: string;
  secondaryValue: number | null;
  secondaryLabel: string | null;
  contributors: GoalContributor[];
  hasData: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function goalLabel(goal: GoalType): string {
  const labels: Record<GoalType, string> = {
    lead_generation: 'Lead Generation',
    content_growth:  'Content Growth',
    product_sales:   'Product Sales',
    brand_awareness: 'Brand Awareness',
  };
  return labels[goal];
}

function metricLabel(goal: GoalType): string {
  const labels: Record<GoalType, string> = {
    lead_generation: 'leads',
    content_growth:  'new followers',
    product_sales:   'saves',
    brand_awareness: 'people reached',
  };
  return labels[goal];
}

function contributorMetricLabel(goal: GoalType, platform: string): string {
  if (goal === 'lead_generation') return 'leads';
  if (goal === 'content_growth')  return 'reach';
  if (goal === 'product_sales')   return 'saves';
  if (platform === 'youtube')     return 'unique viewers';
  return 'people reached';
}

function periodDays(period: NarrativePeriod): number {
  if (period === 'week')  return 7;
  if (period === '30day') return 30;
  return 90;
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

function pctDelta(current: number, prev: number): number {
  if (prev === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - prev) / prev) * 1000) / 10;
}

// ── Per-goal metric queries ────────────────────────────────────────────────────

async function queryLeadGeneration(
  client: Awaited<ReturnType<typeof pool['connect']>>,
  tenantId: number,
  fromDate: Date,
  prevFrom: Date,
  platformFilter: string | null,
): Promise<{ current: number; prev: number; secondary: null }> {
  const [curr, prev] = await Promise.all([
    client.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM insights_comment_classifications cc
       JOIN insights_comments c ON c.id = cc.comment_id
       WHERE c.tenant_id = $1
         AND c.received_at >= $2
         AND cc.is_lead = true
         AND ($3::text IS NULL OR c.platform = $3)`,
      [tenantId, fromDate, platformFilter],
    ),
    client.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM insights_comment_classifications cc
       JOIN insights_comments c ON c.id = cc.comment_id
       WHERE c.tenant_id = $1
         AND c.received_at >= $2
         AND c.received_at < $3
         AND cc.is_lead = true
         AND ($4::text IS NULL OR c.platform = $4)`,
      [tenantId, prevFrom, fromDate, platformFilter],
    ),
  ]);
  return {
    current:   Number(curr.rows[0].count),
    prev:      Number(prev.rows[0].count),
    secondary: null,
  };
}

async function queryContentGrowth(
  client: Awaited<ReturnType<typeof pool['connect']>>,
  tenantId: number,
  fromDate: Date,
  prevFrom: Date,
  platformFilter: string | null,
): Promise<{ current: number; prev: number; secondary: null }> {
  const [curr, prev] = await Promise.all([
    client.query<{ total: string }>(
      `SELECT COALESCE(SUM(followers_delta), 0) AS total
       FROM insights_account_metrics_daily
       WHERE tenant_id = $1
         AND date >= $2
         AND ($3::text IS NULL OR platform = $3)`,
      [tenantId, fromDate, platformFilter],
    ),
    client.query<{ total: string }>(
      `SELECT COALESCE(SUM(followers_delta), 0) AS total
       FROM insights_account_metrics_daily
       WHERE tenant_id = $1
         AND date >= $2
         AND date < $3
         AND ($4::text IS NULL OR platform = $4)`,
      [tenantId, prevFrom, fromDate, platformFilter],
    ),
  ]);
  return {
    current:   Number(curr.rows[0].total),
    prev:      Number(prev.rows[0].total),
    secondary: null,
  };
}

async function queryProductSales(
  client: Awaited<ReturnType<typeof pool['connect']>>,
  tenantId: number,
  fromDate: Date,
  prevFrom: Date,
  platformFilter: string | null,
): Promise<{ current: number; prev: number; secondary: number }> {
  const [curr, prev, visits] = await Promise.all([
    client.query<{ saves: string }>(
      `SELECT COALESCE(SUM(saves), 0) AS saves
       FROM insights_account_metrics_daily
       WHERE tenant_id = $1
         AND date >= $2
         AND ($3::text IS NULL OR platform = $3)`,
      [tenantId, fromDate, platformFilter],
    ),
    client.query<{ saves: string }>(
      `SELECT COALESCE(SUM(saves), 0) AS saves
       FROM insights_account_metrics_daily
       WHERE tenant_id = $1
         AND date >= $2
         AND date < $3
         AND ($4::text IS NULL OR platform = $4)`,
      [tenantId, prevFrom, fromDate, platformFilter],
    ),
    client.query<{ visits: string }>(
      `SELECT COALESCE(SUM(profile_visits), 0) AS visits
       FROM insights_account_metrics_daily
       WHERE tenant_id = $1
         AND date >= $2
         AND ($3::text IS NULL OR platform = $3)`,
      [tenantId, fromDate, platformFilter],
    ),
  ]);
  return {
    current:   Number(curr.rows[0].saves),
    prev:      Number(prev.rows[0].saves),
    secondary: Number(visits.rows[0].visits),
  };
}

async function queryBrandAwareness(
  client: Awaited<ReturnType<typeof pool['connect']>>,
  tenantId: number,
  fromDate: Date,
  prevFrom: Date,
  platformFilter: string | null,
): Promise<{ current: number; prev: number; secondary: null }> {
  const [curr, prev] = await Promise.all([
    client.query<{ reach: string }>(
      `SELECT COALESCE(SUM(COALESCE(reach, views, 0)), 0) AS reach
       FROM insights_account_metrics_daily
       WHERE tenant_id = $1
         AND date >= $2
         AND ($3::text IS NULL OR platform = $3)`,
      [tenantId, fromDate, platformFilter],
    ),
    client.query<{ reach: string }>(
      `SELECT COALESCE(SUM(COALESCE(reach, views, 0)), 0) AS reach
       FROM insights_account_metrics_daily
       WHERE tenant_id = $1
         AND date >= $2
         AND date < $3
         AND ($4::text IS NULL OR platform = $4)`,
      [tenantId, prevFrom, fromDate, platformFilter],
    ),
  ]);
  return {
    current:   Number(curr.rows[0].reach),
    prev:      Number(prev.rows[0].reach),
    secondary: null,
  };
}

// ── Contributor queries ────────────────────────────────────────────────────────

async function queryContributors(
  client: Awaited<ReturnType<typeof pool['connect']>>,
  tenantId: number,
  goal: GoalType,
  fromDate: Date,
  platformFilter: string | null,
): Promise<GoalContributor[]> {
  let rows: Array<{ title: string | null; platform: string; metric: string }> = [];

  if (goal === 'lead_generation') {
    const res = await client.query<{ title: string | null; platform: string; metric: string }>(
      `SELECT p.title, p.platform, COUNT(cc.comment_id) AS metric
       FROM insights_posts p
       JOIN insights_comments c ON c.post_id = p.id AND c.tenant_id = p.tenant_id
       JOIN insights_comment_classifications cc ON cc.comment_id = c.id
       WHERE p.tenant_id = $1
         AND p.published_at >= $2
         AND cc.is_lead = true
         AND ($3::text IS NULL OR p.platform = $3)
       GROUP BY p.id, p.title, p.platform
       ORDER BY metric DESC
       LIMIT 2`,
      [tenantId, fromDate, platformFilter],
    );
    rows = res.rows;
  } else {
    const metricCol = goal === 'product_sales'
      ? 'COALESCE(SUM(m.saves), 0)'
      : 'COALESCE(SUM(COALESCE(m.reach, m.views, 0)), 0)';

    const res = await client.query<{ title: string | null; platform: string; metric: string }>(
      `SELECT p.title, p.platform, ${metricCol} AS metric
       FROM insights_posts p
       LEFT JOIN insights_post_metrics_daily m
              ON m.post_id = p.id AND m.tenant_id = p.tenant_id
       WHERE p.tenant_id = $1
         AND p.published_at >= $2
         AND ($3::text IS NULL OR p.platform = $3)
       GROUP BY p.id, p.title, p.platform
       ORDER BY metric DESC
       LIMIT 2`,
      [tenantId, fromDate, platformFilter],
    );
    rows = res.rows;
  }

  return rows
    .filter((r) => Number(r.metric) > 0)
    .map((r) => ({
      title:       r.title || 'Untitled',
      platform:    r.platform,
      metricValue: Number(r.metric),
      metricLabel: contributorMetricLabel(goal, r.platform),
    }));
}

// ── Main builder ──────────────────────────────────────────────────────────────

export async function buildGoalSnapshot(
  tenantId: number,
  period: NarrativePeriod,
  platform: string,
): Promise<GoalSnapshot | null> {
  const days          = periodDays(period);
  const fromDate      = daysAgo(days);
  const prevFrom      = daysAgo(days * 2);
  const platformFilter = platform === 'all' ? null : platform;

  const client = await pool.connect();
  try {
    // Fetch primary_goal from business profile
    const profileRes = await client.query<{ primary_goal: string | null }>(
      `SELECT primary_goal FROM business_profiles WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );
    const rawGoal = profileRes.rows[0]?.primary_goal ?? null;
    if (!rawGoal) return null;

    const goal = rawGoal as GoalType;

    // Fetch metric for current + previous period
    let current: number;
    let prev: number;
    let secondary: number | null;

    if (goal === 'lead_generation') {
      ({ current, prev, secondary } = await queryLeadGeneration(client, tenantId, fromDate, prevFrom, platformFilter));
    } else if (goal === 'content_growth') {
      ({ current, prev, secondary } = await queryContentGrowth(client, tenantId, fromDate, prevFrom, platformFilter));
    } else if (goal === 'product_sales') {
      ({ current, prev, secondary } = await queryProductSales(client, tenantId, fromDate, prevFrom, platformFilter));
    } else {
      ({ current, prev, secondary } = await queryBrandAwareness(client, tenantId, fromDate, prevFrom, platformFilter));
    }

    const contributors = await queryContributors(client, tenantId, goal, fromDate, platformFilter);

    return {
      goal,
      goalLabel:      goalLabel(goal),
      platform,
      period,
      metricValue:    current,
      metricValuePrev: prev,
      metricDelta:    pctDelta(current, prev),
      metricLabel:    metricLabel(goal),
      secondaryValue: secondary,
      secondaryLabel: goal === 'product_sales' ? 'profile visits' : null,
      contributors,
      hasData:        current > 0 || prev > 0,
    };
  } finally {
    client.release();
  }
}
