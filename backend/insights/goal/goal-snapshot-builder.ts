/**
 * backend/insights/goal/goal-snapshot-builder.ts
 *
 * Fetches the goal-relevant metric for (tenant, period, platform) and
 * returns a GoalSnapshot used by the template builder.
 *
 * Goal → primary metric mapping:
 *   lead_generation  → comments classified as is_lead (insights_comment_classifications)
 *   content_growth   → net new followers (SUM of followers_delta)
 *   product_sales    → saves (best native purchase-intent proxy). S4-2: read
 *                      per-POST via LATEST_POST_METRICS_LATERAL — the account
 *                      table's saves column has no writer and never will.
 *                      Its secondary metric (profile visits) has no source
 *                      either and is returned as NULL, not 0, so the UI omits
 *                      the line instead of asserting a measured zero.
 *   brand_awareness  → reach (COALESCE(reach, views))
 *
 * contributors: top 2 posts that drove the goal metric this period.
 */

import type { PoolClient } from '@/lib/db';
import type { NarrativePeriod } from '../narrative/snapshot-builder';
import { LATEST_POST_METRICS_LATERAL } from '../latest-post-metrics-sql';
import { resolveTenantInsightsTimeZone } from '../tenant-timezone';
import { tenantZonePeriodStart, tenantZonePeriodStartDateKey } from '@/lib/format-timestamp';
import {
  GOAL_FALLBACK,
  GOAL_KEYWORD_FAMILIES,
  isGoalType,
  type GoalType,
} from './goal-type-classification';

export type { GoalType };
export type GoalProvenance = 'explicit' | 'inferred';

export interface GoalContributor {
  title: string;
  platform: string;
  contentType: string | null;
  metricValue: number;
  metricLabel: string;
}

/** Goal metric grouped by content category (for the 30/90-day "what contributed" view). */
export interface GoalCategory {
  contentType: string;   // raw content_type or 'other'
  label: string;         // display label, e.g. "Educational"
  postCount: number;
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
  contributors: GoalContributor[];   // top posts (used for the week view)
  categories: GoalCategory[];        // grouped by content type (used for 30/90-day)
  hasData: boolean;
  /**
   * True when `normalizeGoal` could not confidently map the stored free-text
   * goal and fell back to the default bucket — i.e. Aries is GUESSING. The UI
   * renders a "Goal inferred — confirm in Settings" chip so the user can fix a
   * misclassification (S1-5 / AA-84).
   */
  goalInferred: boolean;
}

function categoryLabel(contentType: string): string {
  if (contentType === 'other') return 'Other';
  return contentType.charAt(0).toUpperCase() + contentType.slice(1);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// `business_profiles.primary_goal` is a FREE-FORM string (set at onboarding /
// written by Hermes brand-enrichment as natural language like "Generate more
// leads"), NOT one of the four canonical GoalType keys. A blind
// `rawGoal as GoalType` therefore produced an unmapped goal → empty goalLabel,
// empty metricLabel and an empty Aries narrative, while the metric silently fell
// through to brand awareness. Normalise any stored vocabulary to a canonical
// goal by keyword, defaulting to brand_awareness (the most universal metric) so
// the label + narrative are never blank.
//
// Returns { goal, inferred }. `inferred` is true ONLY on the terminal
// fallthrough — when neither an exact canonical key nor any keyword matched, so
// the default is a GUESS, not a confident mapping. Exact and keyword matches are
// inferred:false. On a guess we also log the original free text so an unmatched
// onboarding preset (e.g. "Increase social media presence") is visible to us,
// instead of silently landing on brand_awareness (S1-5 / AA-84). Exported for
// direct unit testing.
function normalizeGoalValue(
  raw: string,
  options: { warnOnFallback: boolean },
): { goal: GoalType; inferred: boolean } {
  const s = raw.trim().toLowerCase();
  if (!s) return { goal: GOAL_FALLBACK, inferred: true };
  // Exact canonical match wins.
  if (isGoalType(s)) return { goal: s, inferred: false };
  // Keyword match on free-form text (most specific intent first). The families
  // and their order live in goal-type-classification.ts so the S6-2 backfill
  // classifies with the SAME vocabulary this read path resolves with — a
  // confidently backfilled goal_type can then never disagree with the goal a
  // tenant already sees.
  for (const { goal, pattern } of GOAL_KEYWORD_FAMILIES) {
    if (pattern.test(s)) return { goal, inferred: false };
  }
  // No keyword matched — we are GUESSING. Log the original text for our
  // visibility and mark the result inferred so the UI asks the user to confirm.
  if (options.warnOnFallback) {
    console.warn(`[insights.goal] unmatched primary_goal ${JSON.stringify(raw)} → defaulting to brand_awareness (inferred)`);
  }
  return { goal: GOAL_FALLBACK, inferred: true };
}

export function normalizeGoal(raw: string): { goal: GoalType; inferred: boolean } {
  return normalizeGoalValue(raw, { warnOnFallback: true });
}

/**
 * Resolve the goal to render, and whether Aries is still guessing at it.
 *
 * `storedGoalType` (S6-2 / AA-115) is the canonical `business_profiles.goal_type`
 * column. It is only ever written from a CONFIDENT classification — an exact
 * canonical key or a single matching keyword family — so when it is present the
 * bucket is settled and the S1-5 confirm chip has nothing to ask about. It also
 * short-circuits the regex re-derivation, which is the point of having a
 * canonical column at all.
 *
 * When it is NULL (ambiguous free text, an unmatched onboarding preset, or a row
 * the backfill has not reached), resolution is byte-identical to the pre-AA-115
 * behavior: normalize by keyword, then let persisted provenance decide the chip.
 * That fallback is what keeps this change non-regressive for every row the
 * backfill deliberately refused to touch.
 */
export function resolveGoalWithProvenance(
  raw: string,
  provenance: GoalProvenance | null | undefined,
  storedGoalType?: GoalType | string | null,
): { goal: GoalType; inferred: boolean } {
  if (isGoalType(storedGoalType)) {
    return { goal: storedGoalType, inferred: false };
  }
  const normalized = normalizeGoalValue(raw, { warnOnFallback: provenance !== 'explicit' });
  if (provenance === 'explicit') {
    return { goal: normalized.goal, inferred: false };
  }
  if (provenance === 'inferred') {
    return { goal: normalized.goal, inferred: true };
  }
  return normalized;
}

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

function pctDelta(current: number, prev: number): number {
  if (prev === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - prev) / prev) * 1000) / 10;
}

// ── Per-goal metric queries ────────────────────────────────────────────────────

async function queryLeadGeneration(
  client: PoolClient,
  tenantId: number,
  fromDate: Date,
  prevFrom: Date,
  platformFilter: string | null,
): Promise<{ current: number; prev: number; secondary: null }> {
  // S8-4/AA-127 (gap D7): sequential on the HELD client, deliberately.
  // These ran under Promise.all, which guardrail #1 bans around DB call chains.
  // The violation was benign — pg serialises queries on a single connection, so
  // the parallelism was imaginary — but do NOT "fix" it by reaching for
  // pool.query: that would turn a style problem into real connection fan-out,
  // taking two pooled connections per goal read while this one is still held.
  const curr = await client.query<{ count: string }>(
    `SELECT COUNT(*) AS count
       FROM insights_comment_classifications cc
       JOIN insights_comments c ON c.id = cc.comment_id
       WHERE c.tenant_id = $1
         AND c.received_at >= $2
         AND cc.is_lead = true
         AND ($3::text IS NULL OR c.platform = $3)`,
    [tenantId, fromDate, platformFilter],
  );
  const prev = await client.query<{ count: string }>(
    `SELECT COUNT(*) AS count
       FROM insights_comment_classifications cc
       JOIN insights_comments c ON c.id = cc.comment_id
       WHERE c.tenant_id = $1
         AND c.received_at >= $2
         AND c.received_at < $3
         AND cc.is_lead = true
         AND ($4::text IS NULL OR c.platform = $4)`,
    [tenantId, prevFrom, fromDate, platformFilter],
  );
  return {
    current:   Number(curr.rows[0].count),
    prev:      Number(prev.rows[0].count),
    secondary: null,
  };
}

async function queryContentGrowth(
  client: PoolClient,
  tenantId: number,
  fromKey: string,
  prevKey: string,
  platformFilter: string | null,
): Promise<{ current: number; prev: number; secondary: null }> {
  // S2-3: the bare DATE column is bounded by a tenant-tz calendar date ($n::date),
  // never a timestamptz instant (session-tz-dependent, off-by-one at the boundary).
  // S8-4/AA-127 (gap D7): sequential on the HELD client, deliberately.
  // These ran under Promise.all, which guardrail #1 bans around DB call chains.
  // The violation was benign — pg serialises queries on a single connection, so
  // the parallelism was imaginary — but do NOT "fix" it by reaching for
  // pool.query: that would turn a style problem into real connection fan-out,
  // taking two pooled connections per goal read while this one is still held.
  const curr = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(followers_delta), 0) AS total
       FROM insights_account_metrics_daily
       WHERE tenant_id = $1
         AND date >= $2::date
         AND ($3::text IS NULL OR platform = $3)`,
    [tenantId, fromKey, platformFilter],
  );
  const prev = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(followers_delta), 0) AS total
       FROM insights_account_metrics_daily
       WHERE tenant_id = $1
         AND date >= $2::date
         AND date < $3::date
         AND ($4::text IS NULL OR platform = $4)`,
    [tenantId, prevKey, fromKey, platformFilter],
  );
  return {
    current:   Number(curr.rows[0].total),
    prev:      Number(prev.rows[0].total),
    secondary: null,
  };
}

async function queryProductSales(
  client: PoolClient,
  tenantId: number,
  fromKey: string,
  prevKey: string,
  platformFilter: string | null,
): Promise<{ current: number; prev: number; secondary: number | null }> {
  // S4-2 (gap C3): saves are read from the POST table, not the account table.
  // `insights_account_metrics_daily.saves` has no writer and never will — saves
  // are a per-post metric on Instagram, its account insights do not expose them,
  // and Facebook Pages have no saves concept at all. So this headline read 0 for
  // every tenant forever, while `queryContributors` below already ranked posts
  // by `m.saves` from the post table: the section could name the posts that drove
  // saves underneath a headline that said there were none.
  //
  // S2-1: per-post rows are lifetime-CUMULATIVE snapshots, so metrics are read
  // through LATEST_POST_METRICS_LATERAL (each post's newest row) and summed
  // ACROSS posts. Never SUM a single post's dated rows — that inflates ~Nx.
  // Windowing is by p.published_at, matching every other post-level builder.
  // S8-4/AA-127 (gap D7): sequential on the HELD client, deliberately.
  // These ran under Promise.all, which guardrail #1 bans around DB call chains.
  // The violation was benign — pg serialises queries on a single connection, so
  // the parallelism was imaginary — but do NOT "fix" it by reaching for
  // pool.query: that would turn a style problem into real connection fan-out,
  // taking three pooled connections per goal read while this one is still held.
  const curr = await client.query<{ saves: string }>(
    `SELECT COALESCE(SUM(m.saves), 0) AS saves
       FROM insights_posts p
       ${LATEST_POST_METRICS_LATERAL}
       WHERE p.tenant_id = $1
         AND p.published_at >= $2::date
         AND ($3::text IS NULL OR p.platform = $3)`,
    [tenantId, fromKey, platformFilter],
  );
  const prev = await client.query<{ saves: string }>(
    `SELECT COALESCE(SUM(m.saves), 0) AS saves
       FROM insights_posts p
       ${LATEST_POST_METRICS_LATERAL}
       WHERE p.tenant_id = $1
         AND p.published_at >= $2::date
         AND p.published_at < $3::date
         AND ($4::text IS NULL OR p.platform = $4)`,
    [tenantId, prevKey, fromKey, platformFilter],
  );
    // profile_visits has NO source and is expected to stay NULL indefinitely:
    // Instagram's `profile_views` metric is DEPRECATED by Meta and Facebook's
    // nearest equivalent (page_views_total) counts something else. So this
    // deliberately does NOT COALESCE to 0 — SUM over all-NULL returns NULL, and
    // a null `secondary` makes the UI OMIT the line entirely
    // (GoalSection renders it only when `secondaryValue != null`). Coalescing
    // here is what rendered a confident "0 profile visits" to every operator.
  const visits = await client.query<{ visits: string | null }>(
    `SELECT SUM(profile_visits) AS visits
       FROM insights_account_metrics_daily
       WHERE tenant_id = $1
         AND date >= $2::date
         AND ($3::text IS NULL OR platform = $3)`,
    [tenantId, fromKey, platformFilter],
  );
  const rawVisits = visits.rows[0]?.visits ?? null;
  return {
    current:   Number(curr.rows[0].saves),
    prev:      Number(prev.rows[0].saves),
    secondary: rawVisits === null ? null : Number(rawVisits),
  };
}

async function queryBrandAwareness(
  client: PoolClient,
  tenantId: number,
  fromKey: string,
  prevKey: string,
  platformFilter: string | null,
): Promise<{ current: number; prev: number; secondary: null }> {
  // S2-3: bare DATE column bounded by a tenant-tz calendar date ($n::date).
  // S8-4/AA-127 (gap D7): sequential on the HELD client, deliberately.
  // These ran under Promise.all, which guardrail #1 bans around DB call chains.
  // The violation was benign — pg serialises queries on a single connection, so
  // the parallelism was imaginary — but do NOT "fix" it by reaching for
  // pool.query: that would turn a style problem into real connection fan-out,
  // taking two pooled connections per goal read while this one is still held.
  const curr = await client.query<{ reach: string }>(
    `SELECT COALESCE(SUM(COALESCE(reach, views, 0)), 0) AS reach
       FROM insights_account_metrics_daily
       WHERE tenant_id = $1
         AND date >= $2::date
         AND ($3::text IS NULL OR platform = $3)`,
    [tenantId, fromKey, platformFilter],
  );
  const prev = await client.query<{ reach: string }>(
    `SELECT COALESCE(SUM(COALESCE(reach, views, 0)), 0) AS reach
       FROM insights_account_metrics_daily
       WHERE tenant_id = $1
         AND date >= $2::date
         AND date < $3::date
         AND ($4::text IS NULL OR platform = $4)`,
    [tenantId, prevKey, fromKey, platformFilter],
  );
  return {
    current:   Number(curr.rows[0].reach),
    prev:      Number(prev.rows[0].reach),
    secondary: null,
  };
}

// ── Contributor queries ────────────────────────────────────────────────────────

async function queryContributors(
  client: PoolClient,
  tenantId: number,
  goal: GoalType,
  fromDate: Date,
  platformFilter: string | null,
): Promise<GoalContributor[]> {
  let rows: Array<{ title: string | null; platform: string; content_type: string | null; metric: string }> = [];

  if (goal === 'lead_generation') {
    const res = await client.query<{ title: string | null; platform: string; content_type: string | null; metric: string }>(
      `SELECT p.title, p.platform, p.content_type, COUNT(cc.comment_id) AS metric
       FROM insights_posts p
       JOIN insights_comments c ON c.post_id = p.id AND c.tenant_id = p.tenant_id
       JOIN insights_comment_classifications cc ON cc.comment_id = c.id
       WHERE p.tenant_id = $1
         AND p.published_at >= $2
         AND cc.is_lead = true
         AND ($3::text IS NULL OR p.platform = $3)
       GROUP BY p.id, p.title, p.platform, p.content_type
       ORDER BY metric DESC
       LIMIT 2`,
      [tenantId, fromDate, platformFilter],
    );
    rows = res.rows;
  } else {
    // S2-1: latest lifetime snapshot per post, NOT SUM across dated rows.
    const metricCol = goal === 'product_sales'
      ? 'COALESCE(m.saves, 0)'
      : 'COALESCE(m.reach, m.views, 0)';

    const res = await client.query<{ title: string | null; platform: string; content_type: string | null; metric: string }>(
      `SELECT p.title, p.platform, p.content_type, ${metricCol} AS metric
       FROM insights_posts p
       ${LATEST_POST_METRICS_LATERAL}
       WHERE p.tenant_id = $1
         AND p.published_at >= $2
         AND ($3::text IS NULL OR p.platform = $3)
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
      contentType: r.content_type,
      metricValue: Number(r.metric),
      metricLabel: contributorMetricLabel(goal, r.platform),
    }));
}

// Group the goal metric by content category (for the 30/90-day view).
async function queryCategories(
  client: PoolClient,
  tenantId: number,
  goal: GoalType,
  fromDate: Date,
  platformFilter: string | null,
): Promise<GoalCategory[]> {
  let rows: Array<{ content_type: string | null; post_count: string; metric: string }> = [];

  if (goal === 'lead_generation') {
    const res = await client.query<{ content_type: string | null; post_count: string; metric: string }>(
      `SELECT COALESCE(p.content_type, 'other') AS content_type,
              COUNT(DISTINCT p.id)              AS post_count,
              COUNT(cc.comment_id)              AS metric
       FROM insights_posts p
       JOIN insights_comments c ON c.post_id = p.id AND c.tenant_id = p.tenant_id
       JOIN insights_comment_classifications cc ON cc.comment_id = c.id
       WHERE p.tenant_id = $1
         AND p.published_at >= $2
         AND cc.is_lead = true
         AND ($3::text IS NULL OR p.platform = $3)
       GROUP BY COALESCE(p.content_type, 'other')
       ORDER BY metric DESC`,
      [tenantId, fromDate, platformFilter],
    );
    rows = res.rows;
  } else {
    // S2-1: take each post's LATEST lifetime snapshot, THEN sum across posts
    // within a content category (never SUM a post's dated cumulative rows).
    const metricPerPost = goal === 'product_sales'
      ? 'COALESCE(m.saves, 0)'
      : 'COALESCE(m.reach, m.views, 0)';

    const res = await client.query<{ content_type: string | null; post_count: string; metric: string }>(
      `SELECT content_type,
              COUNT(*)     AS post_count,
              SUM(metric)  AS metric
       FROM (
         SELECT COALESCE(p.content_type, 'other') AS content_type,
                ${metricPerPost}                  AS metric
         FROM insights_posts p
         ${LATEST_POST_METRICS_LATERAL}
         WHERE p.tenant_id = $1
           AND p.published_at >= $2
           AND ($3::text IS NULL OR p.platform = $3)
       ) per_post
       GROUP BY content_type
       ORDER BY metric DESC`,
      [tenantId, fromDate, platformFilter],
    );
    rows = res.rows;
  }

  return rows
    .filter((r) => Number(r.metric) > 0)
    .map((r) => ({
      contentType: r.content_type ?? 'other',
      label:       categoryLabel(r.content_type ?? 'other'),
      postCount:   Number(r.post_count),
      metricValue: Number(r.metric),
      metricLabel: contributorMetricLabel(goal, platformFilter ?? 'all'),
    }));
}

// ── Main builder ──────────────────────────────────────────────────────────────

/** Uses the caller-owned client for every query and never releases it. */
export async function buildGoalSnapshot(
  tenantId: number,
  period: NarrativePeriod,
  platform: string,
  client: PoolClient,
): Promise<GoalSnapshot | null> {
  const days          = periodDays(period);
  const platformFilter = platform === 'all' ? null : platform;

  // S2-3: every window is computed in the tenant's own business timezone.
  // timestamptz columns (received_at / published_at) use the UTC instant of
  // tenant-tz midnight; the bare DATE metric column uses the tenant-tz calendar
  // date ($n::date). The fallback default applies only to a tenant with no zone.
  const tz       = await resolveTenantInsightsTimeZone(client, tenantId);
  const fromDate = tenantZonePeriodStart(days, tz);          // timestamptz windows
  const prevFrom = tenantZonePeriodStart(days * 2, tz);
  const fromKey  = tenantZonePeriodStartDateKey(days, tz);   // DATE-column windows
  const prevKey  = tenantZonePeriodStartDateKey(days * 2, tz);

  // Fetch primary_goal from business profile. goal_type (S6-2 / AA-115) is the
  // canonical key when the free text mapped confidently; NULL means we are still
  // guessing and the provenance fallback below applies.
  const profileRes = await client.query<{
    primary_goal: string | null;
    primary_goal_source: GoalProvenance | null;
    goal_type: string | null;
  }>(
    `SELECT primary_goal, primary_goal_source, goal_type FROM business_profiles WHERE tenant_id = $1 LIMIT 1`,
    [tenantId],
  );
  const rawGoal = profileRes.rows[0]?.primary_goal ?? null;
  if (!rawGoal) return null;

  const { goal, inferred: goalInferred } = resolveGoalWithProvenance(
    rawGoal,
    profileRes.rows[0]?.primary_goal_source,
    profileRes.rows[0]?.goal_type,
  );

  // Fetch metric for current + previous period
  let current: number;
  let prev: number;
  let secondary: number | null;

  if (goal === 'lead_generation') {
    // received_at (timestamptz) → instant window.
    ({ current, prev, secondary } = await queryLeadGeneration(client, tenantId, fromDate, prevFrom, platformFilter));
  } else if (goal === 'content_growth') {
    // account_metrics_daily.date (DATE) → date-key window.
    ({ current, prev, secondary } = await queryContentGrowth(client, tenantId, fromKey, prevKey, platformFilter));
  } else if (goal === 'product_sales') {
    ({ current, prev, secondary } = await queryProductSales(client, tenantId, fromKey, prevKey, platformFilter));
  } else {
    ({ current, prev, secondary } = await queryBrandAwareness(client, tenantId, fromKey, prevKey, platformFilter));
  }

  const contributors = await queryContributors(client, tenantId, goal, fromDate, platformFilter);
  const categories   = await queryCategories(client, tenantId, goal, fromDate, platformFilter);

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
    categories,
    hasData:        current > 0 || prev > 0,
    goalInferred,
  };
}
