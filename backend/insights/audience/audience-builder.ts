/**
 * backend/insights/audience/audience-builder.ts
 *
 * Fetches data for the Audience section of the Insights dashboard.
 *
 * Returns three components:
 *   - schedule:     upcoming scheduled posts (real data from scheduled_posts + posts)
 *   - demographics: age brackets + locations (hasData: false — needs platform API)
 *   - activeTimes:  7×24 activity heatmap   (hasData: false — needs platform API)
 *
 * Demographics and active-times data come from platform audience analytics
 * (Instagram Insights, YouTube Analytics, etc.) via Composio adapters.
 * Neither is stored in the local DB yet; both return hasData: false stubs
 * until the Phase 3 adapter layer lands.
 *
 * Queries run sequentially (DB_POOL_MAX guardrail — no Promise.all on DB calls).
 */

import pool from '@/lib/db';
import { resolveTenantInsightsTimeZone } from '../tenant-timezone';
import { tenantZonePeriodStart } from '@/lib/format-timestamp';
import type { NarrativePeriod } from '../narrative/snapshot-builder';

// ── Public shapes ─────────────────────────────────────────────────────────────

export interface AudienceScheduleItem {
  id:           number;
  scheduledFor: string;          // ISO timestamp
  platform:     string;          // primary platform (first of target_platforms)
  title:        string;          // truncated caption (first line, max 60 chars)
  surface:      string;          // feed | story | reel
  reason:       string | null;   // Aries timing rationale — not stored yet
  confidence:   string | null;   // high | medium | low  — not stored yet
}

export interface AudienceDemographics {
  hasData:   boolean;
  ages:      [string, number][];   // [label, pct] e.g. ["25–34", 28]
  locations: [string, number][];   // [label, pct] e.g. ["Austin, TX", 38]
}

export interface AudienceActiveTimesGrid {
  hasData:    boolean;
  grid:       number[][] | null;   // 7 (Mon..Sun) × 24 (hours), scores 0–100; null when !hasData
  peakWindow: { day: string; hour: string; score: number } | null;
  timezone:   string | null;       // IANA tz the grid is bucketed/displayed in
}

export interface AudienceSnapshot {
  schedule:     AudienceScheduleItem[];
  demographics: AudienceDemographics;
  activeTimes:  AudienceActiveTimesGrid;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Derives a short display title from a raw post caption.
 * Takes the first non-empty line, trimmed to 60 characters.
 */
function captionToTitle(caption: string | null): string {
  if (!caption) return 'Scheduled post';
  const firstLine = caption.split('\n')[0].trim();
  if (!firstLine) return 'Scheduled post';
  return firstLine.length > 60
    ? `${firstLine.slice(0, 57).trimEnd()}…`
    : firstLine;
}

// Grid rows are Mon..Sun (matches the frontend day-axis order).
// Exported (with dowToRow/fmtHour) for the S2-4 day-boundary tz-agreement test.
export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function periodDays(period: NarrativePeriod): number {
  if (period === 'week')  return 7;
  if (period === '30day') return 30;
  return 90;
}

// Minimum engagement events before the heatmap is meaningful enough to show.
const MIN_HEATMAP_EVENTS = 8;

// Postgres DOW: 0=Sun..6=Sat → grid row index where 0=Mon..6=Sun.
export function dowToRow(dow: number): number {
  return (dow + 6) % 7;
}

export function fmtHour(hour: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12} ${hour < 12 ? 'AM' : 'PM'}`;
}

// ── Main builder ──────────────────────────────────────────────────────────────

export async function buildAudienceSnapshot(
  tenantId: number,
  period:   NarrativePeriod,
  platform: string,
): Promise<AudienceSnapshot> {
  const platformFilter = platform === 'all' ? null : platform;

  const client = await pool.connect();
  try {

    // ── Upcoming scheduled posts (next 5, pending only) ───────────────────────
    const schedRes = await client.query<{
      id:               number;
      scheduled_for:    Date;
      target_platforms: string[];
      caption:          string | null;
      surface:          string;
    }>(
      `SELECT
         sp.id,
         sp.scheduled_for,
         sp.target_platforms,
         p.caption,
         sp.surface
       FROM scheduled_posts sp
       LEFT JOIN posts p ON p.id = sp.post_id AND p.tenant_id = sp.tenant_id
       WHERE sp.tenant_id = $1
         AND sp.scheduled_for >= NOW()
         AND sp.dispatch_status = 'pending'
         AND ($2::text IS NULL OR $2 = ANY(sp.target_platforms))
       ORDER BY sp.scheduled_for ASC
       LIMIT 5`,
      [tenantId, platformFilter],
    );

    const schedule: AudienceScheduleItem[] = schedRes.rows.map((row) => {
      // Use the filtered platform if set, otherwise the first in the array.
      const primaryPlatform = platformFilter
        ? (row.target_platforms.find((p) => p === platformFilter) ?? row.target_platforms[0] ?? 'instagram')
        : (row.target_platforms[0] ?? 'instagram');

      return {
        id:           Number(row.id),
        scheduledFor: row.scheduled_for.toISOString(),
        platform:     primaryPlatform,
        title:        captionToTitle(row.caption),
        surface:      row.surface ?? 'feed',
        reason:       null,
        confidence:   null,
      };
    });

    // ── Active times: real engagement-timing heatmap ──────────────────────────
    // Built from when the audience actually engages (comment timestamps),
    // bucketed by day-of-week × hour in the tenant's local timezone. This is
    // engagement timing, NOT the platform "followers online" metric — that
    // still needs the Phase 3 audience-analytics adapters (see demographics).
    // S2-3: the tenant's own business timezone (single source of truth; the
    // America/New_York default applies only to a tenant with no zone set). This
    // heatmap already bucketed comments in tenant-tz — now the period window is
    // tenant-tz too (received_at is timestamptz → tenant-tz-midnight instant), so
    // window and buckets no longer disagree.
    const timezone = await resolveTenantInsightsTimeZone(client, tenantId);
    const days     = periodDays(period);
    const fromDate = tenantZonePeriodStart(days, timezone);

    const heatRes = await client.query<{ dow: number; hour: number; n: string }>(
      `SELECT
         EXTRACT(DOW  FROM (received_at AT TIME ZONE $4))::int AS dow,
         EXTRACT(HOUR FROM (received_at AT TIME ZONE $4))::int AS hour,
         COUNT(*) AS n
       FROM insights_comments
       WHERE tenant_id    = $1
         AND received_at >= $2
         AND ($3::text IS NULL OR platform = $3)
       GROUP BY 1, 2`,
      [tenantId, fromDate, platformFilter, timezone],
    );

    // Assemble the 7×24 counts grid; track the peak cell + total volume.
    const counts: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
    let total = 0;
    let peak = { row: 0, hour: 0, count: 0 };
    for (const r of heatRes.rows) {
      const row  = dowToRow(Number(r.dow));
      const hour = Number(r.hour);
      const n    = Number(r.n);
      if (row < 0 || row > 6 || hour < 0 || hour > 23) continue;
      counts[row][hour] = n;
      total += n;
      if (n > peak.count) peak = { row, hour, count: n };
    }

    const activeTimes: AudienceActiveTimesGrid =
      total < MIN_HEATMAP_EVENTS
        ? { hasData: false, grid: null, peakWindow: null, timezone }
        : {
            hasData: true,
            // Normalize counts → 0–100 relative to the busiest cell.
            grid: counts.map((row) =>
              row.map((c) => (peak.count > 0 ? Math.round((c / peak.count) * 100) : 0)),
            ),
            peakWindow: {
              day:   DAY_LABELS[peak.row],
              hour:  fmtHour(peak.hour),
              score: 100,
            },
            timezone,
          };

    // ── Demographics: not yet in DB ───────────────────────────────────────────
    // Follower age/location come only from the platform audience-analytics APIs
    // (Instagram/Facebook Insights) via Composio adapters — Phase 3 work.
    return {
      schedule,
      demographics: {
        hasData:   false,
        ages:      [],
        locations: [],
      },
      activeTimes,
    };

  } finally {
    client.release();
  }
}
