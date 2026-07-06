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
  // Weekly cross-post targets (ARIES_WEEKLY_CROSSPOST_ENABLED). Without posting
  // defaults here, computeAutoScheduleSlots skips these platforms as
  // `unsupported_platform`, so synthesized x/linkedin/reddit rows are never
  // scheduled and never publish. They fan out the FEED image only; the
  // story/reel slots exist to satisfy the surface map (never hit for
  // crossposts). Distinct hours so a post crossposted to every platform does
  // not land minute-for-minute across all of them. Actual publishing stays
  // gated by ARIES_<PLATFORM>_ENABLED at the scheduled-dispatch admission gate.
  linkedin: {
    feed: { hour: 9, minute: 30, staggerMinutes: 10 },
    story: { hour: 8, minute: 30, staggerMinutes: 10 },
    reel: { hour: 10, minute: 30, staggerMinutes: 10 },
  },
  x: {
    feed: { hour: 12, minute: 30, staggerMinutes: 15 },
    story: { hour: 9, minute: 30, staggerMinutes: 15 },
    reel: { hour: 13, minute: 30, staggerMinutes: 15 },
  },
  reddit: {
    feed: { hour: 14, minute: 30, staggerMinutes: 20 },
    story: { hour: 11, minute: 30, staggerMinutes: 20 },
    reel: { hour: 15, minute: 30, staggerMinutes: 20 },
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
  /** Per-media video dims mirrored onto scheduled_posts. NULL today. */
  widthPx?: number | null;
  heightPx?: number | null;
  durationSeconds?: number | null;
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
  /** Per-media video dims carried through to the scheduled_posts upsert. NULL today. */
  widthPx: number | null;
  heightPx: number | null;
  durationSeconds: number | null;
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
      widthPx: row.widthPx ?? null,
      heightPx: row.heightPx ?? null,
      durationSeconds: row.durationSeconds ?? null,
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
// Default-cadence path — used when the publish stage emits no weekly_schedule.
//
// Absolute day-offset layout (avoids two traps the weekday-name path has):
//   (a) ordinal→weekday-name mapping is start-weekday-dependent — ordinal 1
//       could land after ordinal 3 if the start weekday is mid-week. Day offsets
//       guarantee ordinal order == calendar order unconditionally.
//   (b) computeAutoScheduleSlots rejects a slot whose platform hour already
//       passed today and jumps to the next week. The +10min buffer on baseDate
//       ensures piece 1 always lands "today at the platform hour" even if now is
//       a few minutes before that hour — never silently pushed ~7 days out.
//
// Layout: baseDate = max(now + 10min, campaignStart), then advanced by 1 day
// if the earliest platform default hour on baseDate's calendar day is already
// past (utc < now). piece k → baseDate + (k-1)d.
// IG+FB of the same ordinal land on the same calendar day (different hours per
// PLATFORM_POSTING_DEFAULTS). Pieces beyond campaignEnd are skipped + logged.

/**
 * One row for the default-cadence scheduler. Same shape as AutoScheduleInputRow
 * but `ordinal` (1-based piece number) replaces `recommendedDay`.
 */
export interface DefaultCadenceInputRow {
  postId: number;
  platform: string;
  /** 1-based piece number; IG+FB of the same ordinal share a calendar day. */
  ordinal: number;
  surface?: AutoScheduleSurface;
  mediaType?: 'image' | 'video';
  widthPx?: number | null;
  heightPx?: number | null;
  durationSeconds?: number | null;
}

export interface ComputeDefaultCadenceSlotsInput {
  rows: DefaultCadenceInputRow[];
  tenantTimezone: string | null;
  campaignStart: Date;
  campaignEnd: Date;
  /** Injectable now() for tests. */
  now?: Date;
}

/**
 * Compute scheduling slots for a campaign whose publish stage emitted no
 * `weekly_schedule[]`. Distributes posts one content-piece per day by ABSOLUTE
 * day offset — ordinal 1 always lands first regardless of the start weekday.
 *
 *   baseDate = max(now + 10min, campaignStart), advanced +1 day when the
 *             earliest platform default hour on that calendar day is already past
 *   piece k  → baseDate + (k - 1) calendar days @ platform default hour
 *
 * Slots outside [campaignStart, campaignEnd] are collected into `skipped` with
 * `reason: overflow_beyond_window:<ordinal>`. Pure: no DB, no clock-as-side-
 * effect (inject `now`). Mirrors computeAutoScheduleSlots.
 */
export function computeDefaultCadenceSlots(
  input: ComputeDefaultCadenceSlotsInput,
): ComputeAutoScheduleSlotsResult {
  const tz = input.tenantTimezone || DEFAULT_TENANT_TIMEZONE;
  const now = input.now ?? new Date();
  const windowEnd = input.campaignEnd;

  // baseDate: at least 10 minutes from now so the near-miss "platform hour is
  // in a few minutes" case doesn't strand piece 1. Then check whether the
  // earliest platform default hour across ALL input rows — at baseDate's
  // calendar day — is already past (utc < windowStart). If so, advance
  // baseDate by exactly 1 full day so piece 1 lands tomorrow instead of being
  // silently dropped. One advance always suffices: tomorrow's platform hour is
  // guaranteed to be in the future since platform hours are fixed within [0,24h)
  // and tomorrow is always more than 24h from now-by-definition impossible to
  // have already passed.
  const windowStart = input.campaignStart > now ? input.campaignStart : now;

  const tenMinutes = 10 * 60 * 1000;
  let baseDate = new Date(Math.max(now.getTime() + tenMinutes, input.campaignStart.getTime()));

  // Determine the minimum UTC slot time for ordinal-1 across all unique
  // (platform, surface) combinations. If the earliest slot is before
  // windowStart, advance baseDate by 1 day so piece 1 lands tomorrow.
  {
    const seenPairs = new Set<string>();
    let minOrdinal1Utc: Date | null = null;
    for (const row of input.rows) {
      const pairKey = `${row.platform}:${row.surface ?? 'feed'}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const platformKey = row.platform.trim().toLowerCase() as AutoSchedulePlatform;
      const surface: AutoScheduleSurface = row.surface ?? 'feed';
      const defaults = pickSlotDefault(platformKey, surface);
      if (!defaults) continue;
      const wallIso = formatTenantWallTime(baseDate, tz, defaults);
      const utc = wallTimeToUtc(wallIso, tz);
      if (!utc) continue;
      if (minOrdinal1Utc === null || utc < minOrdinal1Utc) {
        minOrdinal1Utc = utc;
      }
    }
    if (minOrdinal1Utc !== null && minOrdinal1Utc < windowStart) {
      baseDate = new Date(baseDate.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  if (!(windowEnd > windowStart)) {
    return {
      slots: [],
      skipped: input.rows.map((row) => ({
        row: { ...row, recommendedDay: null },
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
      skipped.push({ row: { ...row, recommendedDay: null }, reason: `unsupported_platform:${row.platform}` });
      continue;
    }

    // Piece k → baseDate + (k-1) calendar days. baseDate is already in UTC;
    // formatTenantWallTime converts the UTC instant to the correct tenant-local
    // calendar date so DST boundaries are handled correctly.
    const dayOffset = (row.ordinal - 1) * 24 * 60 * 60 * 1000;
    const dayInstant = new Date(baseDate.getTime() + dayOffset);

    if (dayInstant > windowEnd) {
      skipped.push({
        row: { ...row, recommendedDay: null },
        reason: `overflow_beyond_window:${row.ordinal}`,
      });
      console.info('[auto-schedule] default-cadence slot overflow — skipping', {
        ordinal: row.ordinal,
        platform: row.platform,
        dayInstant: dayInstant.toISOString(),
        windowEnd: windowEnd.toISOString(),
      });
      continue;
    }

    const wallTimeIso = formatTenantWallTime(dayInstant, tz, defaults);
    const utc = wallTimeToUtc(wallTimeIso, tz);
    if (!utc) {
      skipped.push({ row: { ...row, recommendedDay: null }, reason: `wall_time_to_utc_failed:${wallTimeIso}` });
      continue;
    }
    if (utc < windowStart || utc > windowEnd) {
      skipped.push({ row: { ...row, recommendedDay: null }, reason: `derived_timestamp_outside_window:${utc.toISOString()}` });
      continue;
    }

    slots.push({
      postId: row.postId,
      platform: row.platform,
      surface,
      mediaType,
      widthPx: row.widthPx ?? null,
      heightPx: row.heightPx ?? null,
      durationSeconds: row.durationSeconds ?? null,
      scheduledFor: utc,
      appliedDay: `default-cadence:ordinal-${row.ordinal}`,
      appliedWallTime: wallTimeIso,
    });
  }

  return { slots, skipped };
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
        widthPx: slot.widthPx,
        heightPx: slot.heightPx,
        durationSeconds: slot.durationSeconds,
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

// ---------------------------------------------------------------------------
// DB writer for the default-cadence path.

export interface AutoDefaultCadenceSchedulePostsInput {
  jobId: string;
  tenantId: number;
  tenantTimezone: string | null;
  campaignStart: Date;
  campaignEnd: Date;
  rows: DefaultCadenceInputRow[];
  queryable: ScheduledPostQueryable;
  /** Injectable now() for tests. */
  now?: Date;
}

/**
 * Compute default-cadence slots + write them via `upsertScheduledPost`.
 * Mirrors `autoSchedulePosts` but calls `computeDefaultCadenceSlots` instead
 * of `computeAutoScheduleSlots`. Individual upsert failures are collected
 * and returned so one post never blocks siblings.
 */
export async function autoDefaultCadenceSchedulePosts(
  input: AutoDefaultCadenceSchedulePostsInput,
): Promise<AutoSchedulePostsResult> {
  const computed = computeDefaultCadenceSlots({
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
        widthPx: slot.widthPx,
        heightPx: slot.heightPx,
        durationSeconds: slot.durationSeconds,
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
