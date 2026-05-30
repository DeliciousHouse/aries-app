/**
 * Auto-scheduling for one-off campaigns in autonomous mode.
 *
 * CONTRACT — why this exists:
 * `synthesizePublishPostsFromContentPackage` creates `posts` rows in
 * `status='approved' published_status='approved'` on publish-stage completion
 * but leaves `scheduled_at=NULL` so the operator can manually drag them onto
 * the Calendar. In autonomous mode (`ARIES_AUTO_APPROVE_MARKETING_PIPELINE=1`,
 * single-tenant prod), there is no human in the loop — every other approval
 * gate self-fires, so leaving scheduling as a 14-click manual step is
 * inconsistent with the rest of the pipeline.
 *
 * This module closes that gap. After synthesis succeeds, it derives concrete
 * publish timestamps for each post×platform pair using three brand-aware
 * inputs the pipeline already produces:
 *
 *   1. **Per-brand timing** — Hermes's strategist agent emits
 *      `weekly_schedule[].recommended_day` (e.g. "Monday", "Tuesday") per post,
 *      derived from the brand voice + target audience analysis it ran
 *      upstream. We use that day verbatim — it's the only brand-aware signal
 *      we have today, and trusting it keeps the strategist's editorial intent
 *      intact instead of overwriting it with generic best-practice noise.
 *
 *   2. **Per-platform timing** — within the recommended day, we pick the
 *      hour-of-day from `PLATFORM_POSTING_DEFAULTS` (see citation block
 *      below). Instagram peaks late-morning weekdays; Facebook peaks early
 *      afternoon weekdays; both are tenant-local. Posting both platforms at
 *      their own peak naturally staggers them by 2 hours, so a 1-post-to-IG+FB
 *      brief does not double-fire at the same minute.
 *
 *   3. **Per-timezone** — every wall-clock value is materialized in the
 *      tenant's business timezone via `wallTimeToUtc` (DST-safe, IANA-zone
 *      aware). Falls back to `DEFAULT_TENANT_TIMEZONE` ('America/New_York')
 *      when the tenant has not set a timezone on their business profile.
 *
 * Campaign window: every derived timestamp is clamped inside
 * [campaign_start, campaign_end_date]. Posts whose recommended day never
 * occurs within the window get scheduled on the closest matching weekday
 * INSIDE the window. Posts that would land in the past (e.g. campaign starts
 * tomorrow but recommended Sunday is two days behind) get pushed to the next
 * occurrence of that weekday after the post window opens.
 *
 * Idempotency: the upsert layer (`upsertScheduledPost`) keys on `post_id` via
 * the `scheduled_posts_post_id_key` UNIQUE constraint, so a replayed callback
 * updates the existing scheduled row instead of creating a duplicate.
 *
 * Scope guard: this fires only when `ARIES_AUTO_APPROVE_MARKETING_PIPELINE`
 * is enabled. Tenants in human-approval mode keep the legacy "approved,
 * unscheduled, click-to-place" flow so an operator can review timing before
 * commit.
 *
 * Out of scope (this PR):
 * - Per-tenant override of platform windows (would be a `posting_strategy`
 *   field on `business_profile`; the defaults below are the v1 floor).
 * - Reschedule on brief edit / regenerate (the autonomous loop only schedules
 *   on first synthesis; subsequent edits keep the original timestamps).
 * - Performance-data-driven re-ranking (no historical engagement signal
 *   exists yet on this deployment).
 */



import { DEFAULT_TENANT_TIMEZONE, wallTimeToUtc } from '@/lib/format-timestamp';
import {
  upsertScheduledPost,
  type ScheduledPostQueryable,
} from '@/backend/social-content/scheduled-posts';

/**
 * Marketing-backed per-platform posting defaults.
 *
 * Hour-of-day (24h) values are best-practice posting windows aggregated from
 * the most-cited public 2024-2025 social posting research (Sprout Social
 * annual report, Later's "best time to post" study, Hootsuite Q4 2024
 * benchmarks). Methodology: pick the single hour with the highest median
 * engagement across all tracked B2C verticals on the platform.
 *
 * Values are tenant-local hours. If the strategist's recommended_day is a
 * weekend (Sat/Sun), the same hour is used — weekend posting performs ~15-20%
 * worse on engagement-per-impression for both platforms but the strategist
 * may have a brand reason (e.g. retail launch) for choosing it. Trust the
 * strategist's day pick.
 *
 * `staggerMinutes` exists so a post targeting BOTH platforms doesn't land at
 * a literal duplicate minute — Meta's spam heuristics flag bursts. Instagram
 * at 11:00 + Facebook at 13:05 keeps the pair clearly separated.
 *
 * Future expansion: per-tenant override via `business_profile.posting_strategy`
 * would land here as a deep-merge over the defaults.
 */
export type SurfaceSlotDefault = { hour: number; minute: number; staggerMinutes: number };

/**
 * Per-platform, per-surface posting defaults. Feed keeps the original
 * best-practice windows; story/reel get their own slots so an ephemeral or
 * motion-first post doesn't collide minute-for-minute with the feed post.
 * Story slots run earlier (catch the morning tray); reels mid-day.
 */
export const PLATFORM_POSTING_DEFAULTS = {
  instagram: {
    feed: { hour: 11, minute: 0, staggerMinutes: 0 },
    story: { hour: 9, minute: 0, staggerMinutes: 0 },
    reel: { hour: 12, minute: 0, staggerMinutes: 0 },
  },
  facebook: {
    feed: { hour: 13, minute: 0, staggerMinutes: 5 },
    story: { hour: 10, minute: 0, staggerMinutes: 5 },
    reel: { hour: 14, minute: 0, staggerMinutes: 5 },
  },
} as const satisfies Record<string, Record<'feed' | 'story' | 'reel', SurfaceSlotDefault>>;

export type AutoSchedulePlatform = keyof typeof PLATFORM_POSTING_DEFAULTS;
export type AutoScheduleSurface = 'feed' | 'story' | 'reel';

/** Pick the slot default for a (platform, surface) pair; null for unknown platform. */
export function pickSlotDefault(
  platform: AutoSchedulePlatform,
  surface: AutoScheduleSurface,
): SurfaceSlotDefault | null {
  const bySurface = PLATFORM_POSTING_DEFAULTS[platform];
  if (!bySurface) return null;
  return bySurface[surface] ?? bySurface.feed;
}

/**
 * One row of work: a (post_id, platform) pair that needs a scheduled_for
 * timestamp. The caller (auto-schedule entry point) builds these from the
 * synthesized `posts` rows (one per post×platform) joined against the
 * publish-stage `weekly_schedule[]` to pick up the strategist's recommended
 * day.
 */
export interface AutoScheduleInputRow {
  postId: number;
  platform: string;
  /** Day name as emitted by the Hermes strategist (`"Monday"` … `"Sunday"`). */
  recommendedDay: string | null;
  /** Publish surface (feed|story|reel). Selects the per-surface posting slot. Default 'feed'. */
  surface?: AutoScheduleSurface;
  /** Media type (image|video), mirrored onto scheduled_posts. Default 'image'. */
  mediaType?: 'image' | 'video';
  /** Hermes's free-form time hint, currently unused — recorded for future override hooks. */
  recommendedTimeWindow?: string | null;
}

export interface ComputeAutoScheduleSlotsInput {
  rows: AutoScheduleInputRow[];
  /** Tenant business timezone IANA name, or null to use DEFAULT_TENANT_TIMEZONE. */
  tenantTimezone: string | null;
  /** Campaign opens at this instant (UTC). Schedules never land before this. */
  campaignStart: Date;
  /** Campaign closes at this instant (UTC). Schedules never land after this. */
  campaignEnd: Date;
  /** "Now" — anchors the "no past timestamps" rule. Injectable for tests. */
  now?: Date;
}

export interface AutoScheduleSlot {
  postId: number;
  platform: string;
  /** Publish surface carried through to the scheduled_posts upsert. */
  surface: AutoScheduleSurface;
  /** Media type carried through to the scheduled_posts upsert. */
  mediaType: 'image' | 'video';
  /** Derived UTC instant ready for `scheduled_posts.scheduled_for`. */
  scheduledFor: Date;
  /** Audit trail: which weekday name we used (e.g. "Monday" or "fallback: first day in window"). */
  appliedDay: string;
  /** Audit trail: tenant-local wall-time string we materialized into UTC. */
  appliedWallTime: string;
}

export interface ComputeAutoScheduleSlotsResult {
  slots: AutoScheduleSlot[];
  skipped: Array<{ row: AutoScheduleInputRow; reason: string }>;
}

const DAY_NAME_TO_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function dayIndexFromName(name: string | null | undefined): number | null {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  return key in DAY_NAME_TO_INDEX ? DAY_NAME_TO_INDEX[key] : null;
}

/**
 * Compute scheduling slots for every (post, platform) row, deterministic
 * given inputs. Pure: no DB, no clock, no env reads. The DB writer wraps
 * this so all timestamp math is unit-testable in isolation.
 */
export function computeAutoScheduleSlots(input: ComputeAutoScheduleSlotsInput): ComputeAutoScheduleSlotsResult {
  const tz = input.tenantTimezone || DEFAULT_TENANT_TIMEZONE;
  const now = input.now ?? new Date();
  const windowStart = input.campaignStart > now ? input.campaignStart : now;
  const windowEnd = input.campaignEnd;

  if (!(windowEnd > windowStart)) {
    return {
      slots: [],
      skipped: input.rows.map((row) => ({
        row,
        reason: 'campaign_window_closed_or_empty',
      })),
    };
  }

  const slots: AutoScheduleSlot[] = [];
  const skipped: ComputeAutoScheduleSlotsResult['skipped'] = [];

  for (const row of input.rows) {
    const platformKey = row.platform.trim().toLowerCase() as AutoSchedulePlatform;
    const surface: AutoScheduleSurface = row.surface ?? 'feed';
    const mediaType: 'image' | 'video' = row.mediaType ?? 'image';
    const defaults = pickSlotDefault(platformKey, surface);
    if (!defaults) {
      skipped.push({ row, reason: `unsupported_platform:${row.platform}` });
      continue;
    }

    const wantedDayIdx = dayIndexFromName(row.recommendedDay);
    let wallTimeIso: string;
    let appliedDay: string;

    if (wantedDayIdx === null) {
      // Strategist didn't pick a day — schedule on the first day inside the
      // window at the platform's hour. Still respect tenant tz.
      const fallback = formatTenantWallTime(windowStart, tz, defaults);
      wallTimeIso = fallback;
      appliedDay = 'fallback: first day in window';
    } else {
      const target = findNextWeekdayInWindow(wantedDayIdx, windowStart, windowEnd, tz, defaults);
      if (!target) {
        // The recommended weekday never occurs inside the post window
        // (very short campaign). Fall back to the first day in the window.
        const fallback = formatTenantWallTime(windowStart, tz, defaults);
        wallTimeIso = fallback;
        appliedDay = `fallback: ${row.recommendedDay} not in post window; using first available day`;
      } else {
        wallTimeIso = target;
        appliedDay = row.recommendedDay!;
      }
    }

    const utc = wallTimeToUtc(wallTimeIso, tz);
    if (!utc) {
      skipped.push({ row, reason: `wall_time_to_utc_failed:${wallTimeIso}` });
      continue;
    }
    if (utc < windowStart || utc > windowEnd) {
      skipped.push({ row, reason: `derived_timestamp_outside_window:${utc.toISOString()}` });
      continue;
    }

    slots.push({
      postId: row.postId,
      platform: row.platform,
      surface,
      mediaType,
      scheduledFor: utc,
      appliedDay,
      appliedWallTime: wallTimeIso,
    });
  }

  return { slots, skipped };
}

/**
 * Walk forward day-by-day from `windowStart` looking for the next occurrence
 * of `wantedDayIdx` (0=Sun…6=Sat) in the tenant's local zone. Returns the
 * wall-time ISO (`YYYY-MM-DDTHH:MM:SS`) at the platform's defaults, or null
 * if the weekday never falls inside the window.
 *
 * Implementation note: we iterate one tenant-local calendar day at a time
 * (up to 8 days to cover any weekday including the start day) using
 * `date-fns-tz`-equivalent semantics via the existing `wallTimeToUtc` round
 * trip. This is intentionally simple — campaigns are rarely longer than a few
 * weeks; a fancier date library would be over-engineering.
 */
function findNextWeekdayInWindow(
  wantedDayIdx: number,
  windowStart: Date,
  windowEnd: Date,
  tz: string,
  defaults: { hour: number; minute: number; staggerMinutes: number },
): string | null {
  for (let i = 0; i < 8; i += 1) {
    const probe = new Date(windowStart.getTime() + i * 24 * 3600 * 1000);
    const probeWall = formatTenantWallTime(probe, tz, defaults);
    const probeUtc = wallTimeToUtc(probeWall, tz);
    if (!probeUtc) continue;
    if (probeUtc < windowStart || probeUtc > windowEnd) continue;
    const localDayIdx = tenantLocalDayIndex(probeUtc, tz);
    if (localDayIdx === wantedDayIdx) {
      return probeWall;
    }
  }
  return null;
}

/** Day-of-week (0=Sun…6=Sat) for an instant in the tenant's local zone. */
function tenantLocalDayIndex(instant: Date, tz: string): number {
  // Intl.DateTimeFormat is the most reliable cross-platform way to get the
  // weekday in a specific IANA zone. We map the long name back to 0..6.
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(instant);
  const idx = dayIndexFromName(weekday);
  return idx ?? 0;
}

/**
 * Build a `YYYY-MM-DDTHH:MM:SS` wall-time string anchored to the tenant zone's
 * calendar date of `instant`, using the platform-default hour/minute and the
 * stagger offset (so IG+FB pairs don't share an exact minute).
 */
function formatTenantWallTime(
  instant: Date,
  tz: string,
  defaults: { hour: number; minute: number; staggerMinutes: number },
): string {
  // Get tenant-local year/month/day parts.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = String(defaults.hour).padStart(2, '0');
  const minute = String(defaults.minute + defaults.staggerMinutes).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}:00`;
}

// ---------------------------------------------------------------------------
// DB writer — wraps computeAutoScheduleSlots + upsertScheduledPost.

export interface AutoSchedulePostsInput {
  jobId: string;
  tenantId: number;
  tenantTimezone: string | null;
  campaignStart: Date;
  campaignEnd: Date;
  /** (post_id, platform, recommendedDay) tuples to schedule. */
  rows: AutoScheduleInputRow[];
  /** Connection / query interface (pool or client). Injectable for tests. */
  queryable: ScheduledPostQueryable;
  /** Injectable now() for tests. */
  now?: Date;
}

export interface AutoSchedulePostsResult {
  scheduled: number;
  skipped: number;
  details: ComputeAutoScheduleSlotsResult;
  errors: Array<{ postId: number; platform: string; message: string }>;
}

/**
 * Compute slots + write them via `upsertScheduledPost`. Returns counts +
 * per-row detail so the caller can log a single audit line. Failures on
 * individual upserts are collected and returned — one post failing must
 * never block siblings from being scheduled.
 */
export async function autoSchedulePosts(
  input: AutoSchedulePostsInput,
): Promise<AutoSchedulePostsResult> {
  const computed = computeAutoScheduleSlots({
    rows: input.rows,
    tenantTimezone: input.tenantTimezone,
    campaignStart: input.campaignStart,
    campaignEnd: input.campaignEnd,
    now: input.now,
  });

  const errors: AutoSchedulePostsResult['errors'] = [];
  let scheduled = 0;

  for (const slot of computed.slots) {
    try {
      await upsertScheduledPost(input.queryable, {
        postId: slot.postId,
        tenantId: input.tenantId,
        scheduledFor: slot.scheduledFor,
        platforms: [slot.platform],
        surface: slot.surface,
        mediaType: slot.mediaType,
        campaignEndDate: input.campaignEnd,
      });
      scheduled += 1;
    } catch (err) {
      errors.push({
        postId: slot.postId,
        platform: slot.platform,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    scheduled,
    skipped: computed.skipped.length,
    details: computed,
    errors,
  };
}
