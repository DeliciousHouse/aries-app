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
 * AI-derived per-platform posting-time override (ARIES_AI_POSTING_TIMES_ENABLED;
 * rows from marketing_posting_times via posting-time-advisor.ts). `days` are
 * ranked days-of-week (0=Sunday, best first) — consumed only by the
 * default-cadence path, and only when honoring them never drops post volume.
 */
export interface PostingTimeSlotOverride {
  hour: number;
  minute: number;
  days?: number[];
}

/** Keyed by lowercase platform name (e.g. 'instagram'). */
export type PostingTimeSlotOverrides = Partial<Record<string, PostingTimeSlotOverride>>;

/**
 * Resolve the effective slot for a (platform, surface) pair: the AI-derived
 * override when present, else the hardcoded platform default. v1 contract:
 * the override applies to the FEED surface only — story/reel keep their
 * platform-default windows (an ephemeral morning-tray story should not follow
 * the feed's evening peak). The platform's staggerMinutes is preserved so
 * multi-platform posts still never share an exact minute, and the override
 * minute is clamped so minute+stagger stays a valid wall-clock minute.
 * No override map (or no entry for the platform) → byte-identical to
 * pickSlotDefault.
 */
export function resolveSlotDefault(
  platform: AutoSchedulePlatform,
  surface: AutoScheduleSurface,
  overrides?: PostingTimeSlotOverrides,
): SurfaceSlotDefault | null {
  const base = pickSlotDefault(platform, surface);
  if (!base) return null;
  if (surface !== 'feed') return base;
  const override = overrides?.[platform];
  if (!override) return base;
  const hour = Number.isInteger(override.hour) && override.hour >= 0 && override.hour <= 23 ? override.hour : base.hour;
  const rawMinute = Number.isInteger(override.minute) && override.minute >= 0 && override.minute <= 59 ? override.minute : 0;
  const minute = Math.min(rawMinute, 59 - base.staggerMinutes);
  return { hour, minute, staggerMinutes: base.staggerMinutes };
}

/** Ranked override days for a (platform, surface) pair; [] when not applicable. */
function overrideDaysFor(
  platform: AutoSchedulePlatform,
  surface: AutoScheduleSurface,
  overrides?: PostingTimeSlotOverrides,
): number[] {
  if (surface !== 'feed') return [];
  const days = overrides?.[platform]?.days;
  if (!Array.isArray(days)) return [];
  return days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
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
  /**
   * AI-derived posting-time overrides (feed hour/minute per platform). The
   * strategist's recommended DAY still wins on this path — only the
   * time-of-day is overridden. Absent → PLATFORM_POSTING_DEFAULTS.
   */
  slotOverrides?: PostingTimeSlotOverrides;
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
    const defaults = resolveSlotDefault(platformKey, surface, input.slotOverrides);
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
// Layout: baseDate = max(now + 10min, campaignStart). Each (platform, surface)
// pair gets a day shift of 0 or 1 decided ONCE from that pair's own platform
// hour on baseDate's calendar day — 1 when the hour has already passed (utc <
// windowStart), else 0 — and piece k → baseDate + (k-1+shift)d @ the pair's
// hour. Deciding per pair (not globally from the earliest hour) means a run
// whose `now` sits between two platform hours no longer drops the past-hour
// platforms; applying the SAME shift to every ordinal of the pair preserves the
// one-piece-per-day ladder (a per-row roll would land ordinal 1 and ordinal 2 on
// the same instant). IG+FB of the same ordinal land on the same calendar day
// (different hours per PLATFORM_POSTING_DEFAULTS). Pieces beyond campaignEnd
// are skipped + logged.

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
  /**
   * AI-derived posting-time overrides. Hour/minute replace the platform's
   * feed default; ranked `days` additionally re-anchor a pair's pieces onto
   * the preferred days-of-week — but ONLY when every piece of the pair fits
   * on a preferred day inside the window (otherwise honoring the preference
   * would drop posts, so the pair falls back to the consecutive-day ladder
   * with the derived hour).
   */
  slotOverrides?: PostingTimeSlotOverrides;
}

/**
 * Compute scheduling slots for a campaign whose publish stage emitted no
 * `weekly_schedule[]`. Distributes posts one content-piece per day by ABSOLUTE
 * day offset — ordinal 1 always lands first regardless of the start weekday.
 *
 *   baseDate = max(now + 10min, campaignStart)
 *   shift    = per (platform, surface): 1 when that pair's platform hour on
 *              baseDate's calendar day has already passed (utc < windowStart),
 *              else 0 — earlier-hour platforms that can still post today stay
 *              today; only the past-hour pairs advance, and every ordinal of a
 *              pair shifts together so the one-piece-per-day ladder holds.
 *   piece k  → baseDate + (k - 1 + shift) calendar days @ the pair's hour.
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
  // in a few minutes" case doesn't strand piece 1. Each (platform, surface) pair
  // then decides its day shift ONCE (below) from ITS OWN platform hour on
  // baseDate's calendar day — not from a single global-min pre-scan. The old
  // global pre-scan advanced the shared baseDate only when the EARLIEST platform
  // hour was past — so when `windowStart` fell between two platform hours, the
  // later-hour platforms whose hour had already passed on baseDate's day were
  // left before `windowStart` and silently dropped as
  // `derived_timestamp_outside_window` (live: a ~19:55Z run scheduled only
  // facebook(13:00)/reddit(14:30) and dropped linkedin(9:30)/instagram(11:00)/
  // x(12:30)). The shift is per PAIR, not per row: a per-row roll would land a
  // rolled ordinal 1 and an unrolled ordinal 2 on the SAME instant (double-
  // booking the platform); shifting every ordinal of the pair together keeps
  // the one-piece-per-day ladder intact.
  const windowStart = input.campaignStart > now ? input.campaignStart : now;

  const tenMinutes = 10 * 60 * 1000;
  const baseDate = new Date(Math.max(now.getTime() + tenMinutes, input.campaignStart.getTime()));

  if (!(windowEnd > windowStart)) {
    return {
      slots: [],
      skipped: input.rows.map((row) => ({
        row: { ...row, recommendedDay: null },
        reason: 'campaign_window_closed_or_empty',
      })),
    };
  }

  // Per-(platform, surface) day shift: 1 when the pair's slot at baseDate's
  // calendar day has already passed (utc < windowStart), else 0. One day always
  // suffices — tomorrow's fixed platform hour is guaranteed to be ahead of
  // windowStart. Pairs whose wall-time conversion fails here fall back to shift
  // 0; the per-row conversion below hits the same failure and skips the row
  // with a `wall_time_to_utc_failed` reason.
  const pairShiftMs = new Map<string, number>();
  const oneDayMs = 24 * 60 * 60 * 1000;
  for (const row of input.rows) {
    const platformKey = row.platform.trim().toLowerCase() as AutoSchedulePlatform;
    const surface: AutoScheduleSurface = row.surface ?? 'feed';
    const pairKey = `${platformKey}:${surface}`;
    if (pairShiftMs.has(pairKey)) continue;
    const defaults = resolveSlotDefault(platformKey, surface, input.slotOverrides);
    if (!defaults) continue;
    const wallIso = formatTenantWallTime(baseDate, tz, defaults);
    const utc = wallTimeToUtc(wallIso, tz);
    if (!utc) continue;
    pairShiftMs.set(pairKey, utc < windowStart ? oneDayMs : 0);
  }

  // AI-derived preferred-days re-anchoring (per pair). For a pair whose
  // override carries ranked days, scan tenant-local calendar days forward from
  // baseDate and collect the instants landing on a preferred day inside the
  // window. Only when EVERY piece of the pair fits (candidates >= pieces) does
  // the pair adopt them — a partial fit would silently drop posts, so it falls
  // back to the consecutive-day ladder (derived hour still applies). Piece
  // order follows ordinal order onto chronological candidates, preserving the
  // ordinal-order == calendar-order invariant.
  const pairPreferredWall = new Map<string, Map<number, string>>();
  {
    const pairOrdinals = new Map<string, Set<number>>();
    for (const row of input.rows) {
      const platformKey = row.platform.trim().toLowerCase() as AutoSchedulePlatform;
      const surface: AutoScheduleSurface = row.surface ?? 'feed';
      const pairKey = `${platformKey}:${surface}`;
      const set = pairOrdinals.get(pairKey) ?? new Set<number>();
      set.add(row.ordinal);
      pairOrdinals.set(pairKey, set);
    }
    for (const [pairKey, ordinalSet] of pairOrdinals) {
      const [platformKey, surface] = pairKey.split(':') as [AutoSchedulePlatform, AutoScheduleSurface];
      const preferredDays = overrideDaysFor(platformKey, surface, input.slotOverrides);
      if (preferredDays.length === 0) continue;
      const defaults = resolveSlotDefault(platformKey, surface, input.slotOverrides);
      if (!defaults) continue;
      const daySet = new Set(preferredDays);
      const ordinals = [...ordinalSet].sort((a, b) => a - b);
      const candidates: string[] = [];
      // Bounded scan: window is at most weeks long; 31 days covers it.
      for (let i = 0; i < 31 && candidates.length < ordinals.length; i += 1) {
        const probe = new Date(baseDate.getTime() + i * oneDayMs);
        const wallIso = formatTenantWallTime(probe, tz, defaults);
        const utc = wallTimeToUtc(wallIso, tz);
        if (!utc) continue;
        if (utc > windowEnd) break;
        if (utc < windowStart) continue;
        // DST fall-back guard: across the autumn transition two consecutive
        // 24h-UTC probes can land on the SAME tenant-local calendar date, which
        // would double-book two ordinals at the identical instant. Duplicates
        // are always adjacent (probes are chronological), so comparing against
        // the last collected candidate is sufficient.
        if (daySet.has(tenantLocalDayIndex(utc, tz)) && candidates[candidates.length - 1] !== wallIso) {
          candidates.push(wallIso);
        }
      }
      if (candidates.length < ordinals.length) continue; // ladder fallback — never drop volume
      const byOrdinal = new Map<number, string>();
      ordinals.forEach((ordinal, index) => byOrdinal.set(ordinal, candidates[index]));
      pairPreferredWall.set(pairKey, byOrdinal);
    }
  }

  const slots: AutoScheduleSlot[] = [];
  const skipped: ComputeAutoScheduleSlotsResult['skipped'] = [];

  for (const row of input.rows) {
    const platformKey = row.platform.trim().toLowerCase() as AutoSchedulePlatform;
    const surface: AutoScheduleSurface = row.surface ?? 'feed';
    const mediaType: 'image' | 'video' = row.mediaType ?? 'image';
    const defaults = resolveSlotDefault(platformKey, surface, input.slotOverrides);
    if (!defaults) {
      skipped.push({ row: { ...row, recommendedDay: null }, reason: `unsupported_platform:${row.platform}` });
      continue;
    }

    const pairKey = `${platformKey}:${surface}`;
    const preferredWall = pairPreferredWall.get(pairKey)?.get(row.ordinal) ?? null;

    // Piece k → baseDate + (k-1) calendar days + the pair's shift. baseDate is
    // already in UTC; formatTenantWallTime converts the UTC instant to the
    // correct tenant-local calendar date so DST boundaries are handled correctly.
    const dayOffset = (row.ordinal - 1) * oneDayMs + (pairShiftMs.get(pairKey) ?? 0);
    const dayInstant = new Date(baseDate.getTime() + dayOffset);

    const wallTimeIso = preferredWall ?? formatTenantWallTime(dayInstant, tz, defaults);
    const utc = wallTimeToUtc(wallTimeIso, tz);
    if (!utc) {
      skipped.push({ row: { ...row, recommendedDay: null }, reason: `wall_time_to_utc_failed:${wallTimeIso}` });
      continue;
    }

    // Overflow guard runs against the FINAL (shift-applied) instant. A
    // preferred-day row is exempt — its candidates were collected strictly
    // inside the window; the ladder's dayInstant is meaningless for it.
    if (!preferredWall && dayInstant > windowEnd) {
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

    // A row still before windowStart after the pair shift (or past windowEnd)
    // is a genuine dead window — skip it (never emit a past-or-out-of-window
    // slot).
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
      appliedDay: preferredWall
        ? `preferred-day:ordinal-${row.ordinal}`
        : `default-cadence:ordinal-${row.ordinal}`,
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
  /** AI-derived posting-time overrides; absent → platform defaults. */
  slotOverrides?: PostingTimeSlotOverrides;
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
    slotOverrides: input.slotOverrides,
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
  /** AI-derived posting-time overrides; absent → platform defaults. */
  slotOverrides?: PostingTimeSlotOverrides;
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
    slotOverrides: input.slotOverrides,
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
