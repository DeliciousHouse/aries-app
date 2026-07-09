/**
 * AI-derived per-platform posting times ("posting time advisor").
 *
 * CONTRACT — why this exists:
 * Post publish times were a fixed set of best-practice hours
 * (PLATFORM_POSTING_DEFAULTS in auto-schedule.ts) — the same for every tenant,
 * never re-examined. The product intent is the opposite: posting times should
 * be DERIVED, per platform, every time content generation starts —
 *
 *   1. **Analytics source** — once the tenant's own account has enough posts
 *      with insights metrics on a platform (ARIES_POSTING_TIMES_MIN_ANALYTICS_POSTS,
 *      default 8), the best hour + ranked days come from the tenant's own
 *      engagement, bucketed by tenant-local day-of-week x hour-of-day of each
 *      post's publish time. Engagement per post is the LATEST
 *      insights_post_metrics_daily snapshot (lifetime-cumulative semantics —
 *      never SUM across dates, which over-counts by the number of snapshot
 *      days).
 *   2. **Competitor source (cold start)** — until then, a raw Hermes research
 *      run analyzes the competitor brand from the business profile
 *      (business_profiles.competitor_url) and recommends per-platform
 *      days/hours matching the competitor's observed posting habits. Same
 *      submit-/v1/runs+poll idiom as classify-comments.ts / brand-kit-enrich.ts
 *      (no pre-registered Hermes skill, no Hermes-repo change).
 *
 * Results land in marketing_posting_times (one row per tenant x platform,
 * upserted). The auto-schedule slot computation reads them fail-open via
 * loadPostingTimeOverrides — a missing/invalid row falls back to
 * PLATFORM_POSTING_DEFAULTS, so scheduling NEVER depends on this module
 * succeeding.
 *
 * Trigger: `deriveAndPersistPostingTimes` is fired fire-and-forget from
 * startSocialContentJob (the single convergence point of every generate-content
 * entry point) and from the settings-card "Derive now" route (force=true).
 * A TTL guard (ARIES_POSTING_TIMES_TTL_MINUTES, default 60) plus an in-process
 * in-flight guard collapse rapid repeat clicks and the weekly→reel companion
 * double-fire into one derivation.
 *
 * Everything here is best-effort and fail-open: the entry points never throw,
 * a Hermes outage or DB error degrades to "keep whatever rows exist / use the
 * defaults", and a failure never affects the content-generation request that
 * triggered it. Gated by ARIES_AI_POSTING_TIMES_ENABLED (default OFF — when
 * off, no reads, no writes, byte-identical scheduling).
 */

import pool from '@/lib/db';
import { DEFAULT_TENANT_TIMEZONE } from '@/lib/format-timestamp';
import { sanitizeLegacyCompetitorUrl, competitorDomain } from '@/lib/marketing-competitor';
import { loadTenantTimezoneOrFallback, marketingPayloadDefaultsFromBusinessProfile } from '@/backend/tenant/business-profile';
import { resolveCrosspostPlatforms } from './weekly-crosspost';
import { isAiPostingTimesEnabled } from './posting-times-env';
import type { PostingTimeSlotOverrides } from './auto-schedule';

// The Meta platforms every weekly synthesis targets unconditionally; crosspost
// platforms (x/linkedin/reddit) are added per tenant when their rollout flag is
// ON and the tenant has an active connected account (resolveCrosspostPlatforms).
export const POSTING_TIME_BASE_PLATFORMS = ['instagram', 'facebook'] as const;

export const MIN_ANALYTICS_POSTS_DEFAULT = 8;
export const ANALYTICS_LOOKBACK_DAYS = 90;
export const DERIVE_TTL_MINUTES_DEFAULT = 60;
/** A bucket (or hour/day aggregate) needs at least this many posts to count. */
const MIN_BUCKET_POSTS = 2;
const MAX_RATIONALE_CHARS = 400;

const DEFAULT_MODEL_HINT = 'gemini/gemini-3-flash-preview';
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MIN_POLL_INTERVAL_MS = 250;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'stopped']);

type Env = Partial<Record<string, string | undefined>>;
type FetchImpl = (input: string | URL, init?: RequestInit) => Promise<Response>;
type SleepFn = (ms: number) => Promise<void>;

/** Minimal query surface — injectable so tests run with no live database. */
export interface PostingTimeQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

/** Frontend-safe projection of one marketing_posting_times row. */
export interface PostingTimeView {
  platform: string;
  hour: number;
  minute: number;
  /** Ranked days-of-week, 0=Sunday (best first). Empty = no day preference. */
  days: number[];
  source: 'analytics' | 'competitor';
  sampleSize: number | null;
  rationale: string | null;
  derivedAt: string | null;
}

export type DerivePostingTimesResult =
  | { status: 'disabled' | 'invalid_tenant' | 'in_flight' | 'skipped_recent' | 'failed' }
  | { status: 'done'; platforms: Record<string, 'analytics' | 'competitor' | 'default'> };

export interface DerivePostingTimesInput {
  tenantId: number;
  /**
   * Competitor URL as resolved on the triggering job (doc.inputs.competitor_url).
   * NOTE the orchestrator defaults this to the tenant's OWN brand URL when no
   * competitor is configured — pass brandUrl too so that case is detected and
   * treated as "no competitor set" instead of analyzing the tenant's own site.
   */
  competitorUrl?: string | null;
  competitorBrand?: string | null;
  brandUrl?: string | null;
  /** Bypass the TTL guard (the settings-card "Derive now" button). */
  force?: boolean;
  env?: Env;
  fetchImpl?: FetchImpl;
  sleep?: SleepFn;
  queryable?: PostingTimeQueryable;
  /** Injectable now() for tests. */
  now?: Date;
}

function readEnv(env: Env, key: string): string {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readEnvInt(env: Env, key: string, fallback: number): number {
  const raw = readEnv(env, key);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function tryParseJson(text: string): unknown {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function asIntInRange(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

/** Filter/dedupe a days payload to ranked ints 0-6; anything else → []. */
function normalizeDays(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const entry of value) {
    const day = asIntInRange(entry, 0, 6);
    if (day === null || out.includes(day)) continue;
    out.push(day);
    if (out.length >= 7) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Analytics source — the tenant's own engagement, bucketed by tenant-local
// day-of-week x hour-of-day of publish time.

/**
 * Per-post engagement = latest lifetime snapshot (likes+comments+shares+saves;
 * reach/saves are not populated by the sync today — kept for future-proofing).
 * INNER JOIN LATERAL so only posts that actually HAVE a metrics snapshot count
 * toward the sample — "enough data" means measured posts, not just posts.
 * Index support: idx_insights_posts_tenant_platform_published serves the outer
 * scan; the (tenant_id, post_id, date) PK serves the LATERAL.
 */
const ANALYTICS_BUCKETS_SQL = `
  WITH per_post AS (
    SELECT
      p.id,
      p.published_at,
      COALESCE(m.likes, 0)
        + COALESCE(m.comments_count, 0)
        + COALESCE(m.shares, 0)
        + COALESCE(m.saves, 0) AS engagement
    FROM insights_posts p
    JOIN LATERAL (
      SELECT likes, comments_count, shares, saves
      FROM insights_post_metrics_daily d
      WHERE d.tenant_id = p.tenant_id
        AND d.post_id   = p.id
      ORDER BY d.date DESC
      LIMIT 1
    ) m ON true
    WHERE p.tenant_id    = $1
      AND p.platform     = $2
      AND p.published_at >= now() - ($4 || ' days')::interval
  )
  SELECT
    EXTRACT(DOW  FROM (published_at AT TIME ZONE $3))::int AS day_of_week,
    EXTRACT(HOUR FROM (published_at AT TIME ZONE $3))::int AS hour_of_day,
    COUNT(DISTINCT id)::int  AS post_count,
    AVG(engagement)::float8  AS avg_engagement
  FROM per_post
  GROUP BY 1, 2
`;

export interface AnalyticsBucket {
  day_of_week: number;
  hour_of_day: number;
  post_count: number;
  avg_engagement: number;
}

export interface AnalyticsRecommendation {
  hour: number;
  days: number[];
  sampleSize: number;
}

/**
 * Pure bucket aggregation, exported for direct unit testing. Picks the hour
 * with the highest engagement-weighted average across buckets (needs >= 2
 * posts at that hour), and the top-3 days the same way. Returns null when the
 * total measured-post sample is below `minPosts` or no hour clears the
 * per-hour minimum — the caller then falls through to the competitor source.
 */
export function analyticsRecommendationFromBuckets(
  buckets: ReadonlyArray<AnalyticsBucket>,
  minPosts: number,
): AnalyticsRecommendation | null {
  let sampleSize = 0;
  const byHour = new Map<number, { posts: number; engagementSum: number }>();
  const byDay = new Map<number, { posts: number; engagementSum: number }>();

  for (const bucket of buckets) {
    const hour = asIntInRange(bucket.hour_of_day, 0, 23);
    const day = asIntInRange(bucket.day_of_week, 0, 6);
    const posts = asIntInRange(bucket.post_count, 0, Number.MAX_SAFE_INTEGER) ?? 0;
    const avg = Number.isFinite(bucket.avg_engagement) ? bucket.avg_engagement : 0;
    if (hour === null || day === null || posts <= 0) continue;
    sampleSize += posts;
    const hourStat = byHour.get(hour) ?? { posts: 0, engagementSum: 0 };
    hourStat.posts += posts;
    hourStat.engagementSum += avg * posts;
    byHour.set(hour, hourStat);
    const dayStat = byDay.get(day) ?? { posts: 0, engagementSum: 0 };
    dayStat.posts += posts;
    dayStat.engagementSum += avg * posts;
    byDay.set(day, dayStat);
  }

  if (sampleSize < Math.max(1, minPosts)) return null;

  let bestHour: number | null = null;
  let bestHourAvg = -1;
  let bestHourPosts = 0;
  for (const [hour, stat] of byHour) {
    if (stat.posts < MIN_BUCKET_POSTS) continue;
    const avg = stat.engagementSum / stat.posts;
    if (
      avg > bestHourAvg ||
      (avg === bestHourAvg && stat.posts > bestHourPosts) ||
      (avg === bestHourAvg && stat.posts === bestHourPosts && (bestHour === null || hour < bestHour))
    ) {
      bestHour = hour;
      bestHourAvg = avg;
      bestHourPosts = stat.posts;
    }
  }
  if (bestHour === null) return null;

  const days = [...byDay.entries()]
    .filter(([, stat]) => stat.posts >= MIN_BUCKET_POSTS)
    .map(([day, stat]) => ({ day, avg: stat.engagementSum / stat.posts, posts: stat.posts }))
    .sort((a, b) => b.avg - a.avg || b.posts - a.posts || a.day - b.day)
    .slice(0, 3)
    .map((entry) => entry.day);

  return { hour: bestHour, days, sampleSize };
}

async function deriveAnalyticsRecommendation(
  queryable: PostingTimeQueryable,
  tenantId: number,
  platform: string,
  timezone: string,
  minPosts: number,
): Promise<AnalyticsRecommendation | null> {
  const result = await queryable.query(ANALYTICS_BUCKETS_SQL, [
    tenantId,
    platform,
    timezone,
    String(ANALYTICS_LOOKBACK_DAYS),
  ]);
  return analyticsRecommendationFromBuckets((result.rows ?? []) as AnalyticsBucket[], minPosts);
}

// ---------------------------------------------------------------------------
// Competitor source — one raw Hermes research run covering every platform that
// lacked analytics coverage. Same fail-open submit+poll idiom as
// classify-comments.ts; the function never throws.

export type CompetitorDeriveFailureReason =
  | 'not_configured'
  | 'unreachable'
  | 'submit_rejected'
  | 'submit_invalid'
  | 'poll_rejected'
  | 'poll_invalid'
  | 'timeout'
  | 'run_failed'
  | 'output_invalid';

export interface CompetitorRecommendation {
  hour: number;
  minute: number;
  days: number[];
  rationale: string | null;
}

export type CompetitorDeriveResult =
  | { ok: true; recommendations: Map<string, CompetitorRecommendation> }
  | { ok: false; reason: CompetitorDeriveFailureReason; detail?: string };

function competitorInstructionsBlock(): string {
  return [
    'You are a social-media scheduling analyst. Given a competitor brand, estimate that competitor\'s public posting schedule per platform (which days of the week and what local hour they typically post) and recommend when the client brand should post to compete for the same audience.',
    'Days are integers 0-6 where 0=Sunday. Hours are integers 0-23 in the brand\'s local timezone. Minutes are integers 0-59 (use 0 or 30).',
    'If you cannot determine the competitor\'s real schedule for a platform, recommend the strongest general engagement window for that platform instead — never omit a requested platform.',
    'Keep each rationale to one short sentence naming what the recommendation is based on.',
    'Return ONE strict JSON object. No prose, no markdown fences. JSON only.',
    'Schema: {"status":"ok","output":[{"platform":string,"hour":number,"minute":number,"days":[number],"rationale":string}]}',
    'Return exactly one output entry per requested platform, echoing the platform name.',
  ].join('\n');
}

function competitorPromptBlock(args: {
  competitorUrl: string;
  competitorBrand: string | null;
  timezone: string;
  platforms: string[];
  modelHint: string;
}): string {
  const domain = competitorDomain(args.competitorUrl) || args.competitorUrl;
  return [
    `Model hint: ${args.modelHint}`,
    `Competitor website: ${args.competitorUrl}`,
    `Competitor brand name: ${args.competitorBrand || `(unknown — infer from the domain ${domain})`}`,
    `Client brand local timezone: ${args.timezone}`,
    `Requested platforms: ${JSON.stringify(args.platforms)}`,
    'Analyze the competitor\'s posting habits and return the JSON envelope now:',
  ].join('\n');
}

function competitorRecommendationsFromOutput(
  value: unknown,
  requestedPlatforms: ReadonlyArray<string>,
): Map<string, CompetitorRecommendation> | null {
  const envelope = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
  if (!envelope) return null;
  if (typeof envelope.status === 'string' && envelope.status !== 'ok') return null;
  const output = envelope.output;
  if (!Array.isArray(output)) return null;

  const requested = new Set(requestedPlatforms);
  const recommendations = new Map<string, CompetitorRecommendation>();
  for (const entry of output) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const platform = typeof row.platform === 'string' ? row.platform.trim().toLowerCase() : '';
    if (!requested.has(platform) || recommendations.has(platform)) continue;
    // A wrong hour is worse than no row (no row falls back to the platform
    // default) — drop the platform instead of clamping a garbage value.
    const hour = asIntInRange(row.hour, 0, 23);
    if (hour === null) continue;
    const minute = asIntInRange(row.minute, 0, 59) ?? 0;
    const days = normalizeDays(row.days);
    const rationale = typeof row.rationale === 'string' && row.rationale.trim()
      ? row.rationale.trim().slice(0, MAX_RATIONALE_CHARS)
      : null;
    recommendations.set(platform, { hour, minute, days, rationale });
  }
  return recommendations.size > 0 ? recommendations : null;
}

export async function deriveCompetitorPostingTimes(input: {
  competitorUrl: string;
  competitorBrand?: string | null;
  timezone: string;
  platforms: string[];
  env?: Env;
  fetchImpl?: FetchImpl;
  sleep?: SleepFn;
}): Promise<CompetitorDeriveResult> {
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const gatewayUrl = readEnv(env, 'HERMES_GATEWAY_URL').replace(/\/+$/, '');
  const apiKey = readEnv(env, 'HERMES_API_SERVER_KEY');
  if (!gatewayUrl || !apiKey) return { ok: false, reason: 'not_configured' };

  const sessionKey = readEnv(env, 'HERMES_POSTING_TIMES_SESSION_KEY') || readEnv(env, 'HERMES_SESSION_KEY') || 'aries-main';
  const modelHint = readEnv(env, 'HERMES_POSTING_TIMES_MODEL') || DEFAULT_MODEL_HINT;
  const timeoutMs = readEnvInt(env, 'HERMES_POSTING_TIMES_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const intervalMs = Math.max(MIN_POLL_INTERVAL_MS, readEnvInt(env, 'HERMES_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS));
  const auth = `Bearer ${apiKey}`;

  const body = {
    input: competitorPromptBlock({
      competitorUrl: input.competitorUrl,
      competitorBrand: input.competitorBrand ?? null,
      timezone: input.timezone,
      platforms: input.platforms,
      modelHint,
    }),
    instructions: competitorInstructionsBlock(),
    session_id: sessionKey,
  };

  let runId: string;
  try {
    const submitController = new AbortController();
    const submitTimer = setTimeout(() => submitController.abort(), timeoutMs);
    let submit: Response;
    try {
      submit = await fetchImpl(`${gatewayUrl}/v1/runs`, {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: submitController.signal,
      });
    } finally {
      clearTimeout(submitTimer);
    }
    if (!submit.ok) return { ok: false, reason: 'submit_rejected', detail: `HTTP ${submit.status}` };
    const submitJson = (await submit.json().catch(() => null)) as Record<string, unknown> | null;
    const candidate = submitJson && typeof submitJson.run_id === 'string' ? submitJson.run_id.trim() : '';
    if (!candidate) return { ok: false, reason: 'submit_invalid' };
    runId = candidate;
  } catch (error) {
    return { ok: false, reason: 'unreachable', detail: error instanceof Error ? error.message : String(error) };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    let pollJson: Record<string, unknown> | null;
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const pollController = new AbortController();
      const pollTimer = setTimeout(() => pollController.abort(), remaining);
      let poll: Response;
      try {
        poll = await fetchImpl(`${gatewayUrl}/v1/runs/${encodeURIComponent(runId)}`, {
          method: 'GET',
          headers: { authorization: auth },
          signal: pollController.signal,
        });
      } finally {
        clearTimeout(pollTimer);
      }
      if (!poll.ok) return { ok: false, reason: 'poll_rejected', detail: `HTTP ${poll.status}` };
      pollJson = (await poll.json().catch(() => null)) as Record<string, unknown> | null;
    } catch (error) {
      return { ok: false, reason: 'unreachable', detail: error instanceof Error ? error.message : String(error) };
    }
    const status = pollJson && typeof pollJson.status === 'string' ? pollJson.status : '';
    if (!status) return { ok: false, reason: 'poll_invalid' };
    if (TERMINAL_STATUSES.has(status)) {
      if (status !== 'completed') return { ok: false, reason: 'run_failed', detail: status };
      const outputText = typeof pollJson?.output === 'string' ? pollJson.output : '';
      const recommendations = competitorRecommendationsFromOutput(tryParseJson(outputText), input.platforms);
      if (!recommendations) return { ok: false, reason: 'output_invalid' };
      return { ok: true, recommendations };
    }
    await sleep(intervalMs);
  }
  return { ok: false, reason: 'timeout' };
}

// ---------------------------------------------------------------------------
// Persistence + read paths.

const UPSERT_POSTING_TIME_SQL = `
  INSERT INTO marketing_posting_times
    (tenant_id, platform, hour, minute, days, source, sample_size, rationale, derived_at, updated_at)
  VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, now(), now())
  ON CONFLICT (tenant_id, platform) DO UPDATE SET
    hour = EXCLUDED.hour,
    minute = EXCLUDED.minute,
    days = EXCLUDED.days,
    source = EXCLUDED.source,
    sample_size = EXCLUDED.sample_size,
    rationale = EXCLUDED.rationale,
    derived_at = now(),
    updated_at = now()
`;

async function upsertPostingTime(
  queryable: PostingTimeQueryable,
  args: {
    tenantId: number;
    platform: string;
    hour: number;
    minute: number;
    days: number[];
    source: 'analytics' | 'competitor';
    sampleSize: number | null;
    rationale: string | null;
  },
): Promise<void> {
  await queryable.query(UPSERT_POSTING_TIME_SQL, [
    args.tenantId,
    args.platform,
    args.hour,
    args.minute,
    JSON.stringify(args.days),
    args.source,
    args.sampleSize,
    args.rationale,
  ]);
}

/**
 * The consumption read: derived slot overrides for the auto-schedule paths.
 * Flag-gated + fail-open — returns null (→ PLATFORM_POSTING_DEFAULTS) when the
 * flag is off, the tenant id is invalid, no rows exist, or the read fails.
 * Never throws.
 */
export async function loadPostingTimeOverrides(
  tenantId: number,
  queryable: PostingTimeQueryable = pool,
  env: Env = process.env,
): Promise<PostingTimeSlotOverrides | null> {
  if (!isAiPostingTimesEnabled(env)) return null;
  if (!Number.isFinite(tenantId) || tenantId <= 0) return null;
  try {
    const result = await queryable.query(
      'SELECT platform, hour, minute, days FROM marketing_posting_times WHERE tenant_id = $1',
      [tenantId],
    );
    const overrides: PostingTimeSlotOverrides = {};
    let count = 0;
    for (const raw of (result.rows ?? []) as Array<Record<string, unknown>>) {
      const platform = typeof raw.platform === 'string' ? raw.platform.trim().toLowerCase() : '';
      const hour = asIntInRange(raw.hour, 0, 23);
      if (!platform || hour === null) continue;
      overrides[platform] = {
        hour,
        minute: asIntInRange(raw.minute, 0, 59) ?? 0,
        days: normalizeDays(raw.days),
      };
      count += 1;
    }
    return count > 0 ? overrides : null;
  } catch (err) {
    console.warn('[posting-time-advisor] override read failed — using platform defaults', {
      tenantId,
      error: (err as Error)?.message ?? String(err),
    });
    return null;
  }
}

/** Full rows for the settings card. Frontend-safe projection only. */
export async function listPostingTimesForTenant(
  tenantId: number,
  queryable: PostingTimeQueryable = pool,
): Promise<PostingTimeView[]> {
  const result = await queryable.query(
    `SELECT platform, hour, minute, days, source, sample_size, rationale, derived_at
       FROM marketing_posting_times
      WHERE tenant_id = $1
      ORDER BY platform`,
    [tenantId],
  );
  const views: PostingTimeView[] = [];
  for (const raw of (result.rows ?? []) as Array<Record<string, unknown>>) {
    const platform = typeof raw.platform === 'string' ? raw.platform.trim().toLowerCase() : '';
    const hour = asIntInRange(raw.hour, 0, 23);
    if (!platform || hour === null) continue;
    const source = raw.source === 'analytics' ? 'analytics' : 'competitor';
    const derivedAtRaw = raw.derived_at;
    const derivedAt = derivedAtRaw instanceof Date
      ? derivedAtRaw.toISOString()
      : typeof derivedAtRaw === 'string'
        ? derivedAtRaw
        : null;
    views.push({
      platform,
      hour,
      minute: asIntInRange(raw.minute, 0, 59) ?? 0,
      days: normalizeDays(raw.days),
      source,
      sampleSize: asIntInRange(raw.sample_size, 0, Number.MAX_SAFE_INTEGER),
      rationale: typeof raw.rationale === 'string' && raw.rationale.trim() ? raw.rationale.trim() : null,
      derivedAt,
    });
  }
  return views;
}

// ---------------------------------------------------------------------------
// The derivation orchestration — the fire-and-forget entry point.

const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function analyticsRationale(platform: string, rec: AnalyticsRecommendation): string {
  const dayText = rec.days.length > 0 ? ` — engagement peaks ${rec.days.map((d) => DAY_LABELS[d]).join(', ')}` : '';
  return `Derived from your last ${rec.sampleSize} measured ${platform} posts${dayText} around ${String(rec.hour).padStart(2, '0')}:00.`;
}

// In-process in-flight guard: one derivation per tenant at a time. Fire-and-
// forget callers (every generate click, plus the weekly→reel companion's
// second startSocialContentJob) collapse onto the running derivation.
const inFlightTenants = new Set<number>();

/**
 * Derive + persist posting times for every platform this tenant publishes to.
 * Analytics source per platform when the sample clears the threshold; ONE
 * competitor Hermes run covers all remaining platforms; platforms with neither
 * keep their existing row (or fall back to defaults at consumption). Never
 * throws.
 */
export async function deriveAndPersistPostingTimes(
  input: DerivePostingTimesInput,
): Promise<DerivePostingTimesResult> {
  const env = input.env ?? process.env;
  if (!isAiPostingTimesEnabled(env)) return { status: 'disabled' };

  const tenantId = input.tenantId;
  if (!Number.isFinite(tenantId) || !Number.isInteger(tenantId) || tenantId <= 0) {
    return { status: 'invalid_tenant' };
  }
  if (inFlightTenants.has(tenantId)) return { status: 'in_flight' };
  inFlightTenants.add(tenantId);
  try {
    const queryable = input.queryable ?? pool;
    const now = input.now ?? new Date();

    // TTL guard: a fresh-enough derivation short-circuits (force bypasses —
    // the settings "Derive now" button always re-derives).
    const ttlMinutes = readEnvInt(env, 'ARIES_POSTING_TIMES_TTL_MINUTES', DERIVE_TTL_MINUTES_DEFAULT);
    if (!input.force && ttlMinutes > 0) {
      const freshness = await queryable.query(
        'SELECT MAX(derived_at) AS derived_at FROM marketing_posting_times WHERE tenant_id = $1',
        [tenantId],
      );
      const raw = (freshness.rows?.[0] as Record<string, unknown> | undefined)?.derived_at;
      const latest = raw instanceof Date ? raw : typeof raw === 'string' ? new Date(raw) : null;
      if (latest && Number.isFinite(latest.getTime()) && now.getTime() - latest.getTime() < ttlMinutes * 60_000) {
        return { status: 'skipped_recent' };
      }
    }

    // Platforms: FB+IG always (every weekly synthesis targets them), plus the
    // crosspost platforms whose rollout flag is ON and the tenant has an
    // active connected account. Fail-open [] mirrors the synthesis side.
    const crosspost = await resolveCrosspostPlatforms(tenantId, queryable, env);
    const platforms: string[] = [...POSTING_TIME_BASE_PLATFORMS, ...crosspost];

    let timezone = DEFAULT_TENANT_TIMEZONE;
    try {
      timezone = loadTenantTimezoneOrFallback(String(tenantId));
    } catch {
      // keep the default
    }

    const minPosts = Math.max(1, readEnvInt(env, 'ARIES_POSTING_TIMES_MIN_ANALYTICS_POSTS', MIN_ANALYTICS_POSTS_DEFAULT));
    const sources: Record<string, 'analytics' | 'competitor' | 'default'> = {};
    const pendingCompetitor: string[] = [];

    // Strictly sequential — no Promise.all around the pg pool (guardrail #1).
    for (const platform of platforms) {
      try {
        const rec = await deriveAnalyticsRecommendation(queryable, tenantId, platform, timezone, minPosts);
        if (rec) {
          await upsertPostingTime(queryable, {
            tenantId,
            platform,
            hour: rec.hour,
            minute: 0,
            days: rec.days,
            source: 'analytics',
            sampleSize: rec.sampleSize,
            rationale: analyticsRationale(platform, rec),
          });
          sources[platform] = 'analytics';
          continue;
        }
      } catch (err) {
        console.warn('[posting-time-advisor] analytics derivation failed — trying competitor source', {
          tenantId,
          platform,
          error: (err as Error)?.message ?? String(err),
        });
      }
      pendingCompetitor.push(platform);
    }

    if (pendingCompetitor.length > 0) {
      const competitorUrl = await resolveCompetitorUrl(input, tenantId);
      if (!competitorUrl) {
        for (const platform of pendingCompetitor) sources[platform] = 'default';
        console.info('[posting-time-advisor] no competitor configured — platforms keep defaults', {
          tenantId,
          platforms: pendingCompetitor,
        });
      } else {
        const result = await deriveCompetitorPostingTimes({
          competitorUrl,
          competitorBrand: input.competitorBrand ?? null,
          timezone,
          platforms: pendingCompetitor,
          env,
          fetchImpl: input.fetchImpl,
          sleep: input.sleep,
        });
        if (!result.ok) {
          for (const platform of pendingCompetitor) sources[platform] = 'default';
          console.warn('[posting-time-advisor] competitor derivation failed — platforms keep defaults', {
            tenantId,
            reason: result.reason,
            detail: result.detail,
          });
        } else {
          for (const platform of pendingCompetitor) {
            const rec = result.recommendations.get(platform);
            if (!rec) {
              sources[platform] = 'default';
              continue;
            }
            await upsertPostingTime(queryable, {
              tenantId,
              platform,
              hour: rec.hour,
              minute: rec.minute,
              days: rec.days,
              source: 'competitor',
              sampleSize: null,
              rationale: rec.rationale ?? `Modeled on ${competitorDomain(competitorUrl) || 'competitor'} posting habits.`,
            });
            sources[platform] = 'competitor';
          }
        }
      }
    }

    console.info('[posting-time-advisor] derivation completed', { tenantId, sources });
    return { status: 'done', platforms: sources };
  } catch (err) {
    console.warn('[posting-time-advisor] derivation failed', {
      tenantId,
      error: (err as Error)?.message ?? String(err),
    });
    return { status: 'failed' };
  } finally {
    inFlightTenants.delete(tenantId);
  }
}

/**
 * Resolve the competitor URL for the cold-start source. The job-resolved value
 * wins, EXCEPT when it just defaulted to the tenant's own brand URL (the
 * orchestrator's fallback when no competitor was supplied) — that is treated
 * as "no competitor set". Falls back to the stored business profile. Any
 * resolution error → null (platforms keep defaults).
 */
async function resolveCompetitorUrl(
  input: Pick<DerivePostingTimesInput, 'competitorUrl' | 'brandUrl'>,
  tenantId: number,
): Promise<string | null> {
  const fromJob = sanitizeLegacyCompetitorUrl(input.competitorUrl ?? null);
  const brand = sanitizeLegacyCompetitorUrl(input.brandUrl ?? null);
  if (fromJob && (!brand || competitorDomain(fromJob) !== competitorDomain(brand))) {
    return fromJob;
  }
  try {
    const defaults = await marketingPayloadDefaultsFromBusinessProfile(String(tenantId));
    const stored = sanitizeLegacyCompetitorUrl(defaults.competitorUrl ?? null);
    if (stored && (!brand || competitorDomain(stored) !== competitorDomain(brand))) {
      return stored;
    }
  } catch (err) {
    console.warn('[posting-time-advisor] business-profile competitor lookup failed', {
      tenantId,
      error: (err as Error)?.message ?? String(err),
    });
  }
  return null;
}
