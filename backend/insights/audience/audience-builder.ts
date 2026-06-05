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
  grid:       number[][] | null;   // 7 (days) × 24 (hours), scores 0–100; null when !hasData
  peakWindow: { day: string; hour: string; score: number } | null;
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

// ── Main builder ──────────────────────────────────────────────────────────────

export async function buildAudienceSnapshot(
  tenantId: number,
  _period:  NarrativePeriod,   // reserved for future period-scoped schedule filtering
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

    // ── Demographics + active times: not yet in DB ────────────────────────────
    // These require platform audience-analytics APIs (Instagram Insights,
    // YouTube Analytics, etc.) via Composio adapters — Phase 3 work.
    return {
      schedule,
      demographics: {
        hasData:   false,
        ages:      [],
        locations: [],
      },
      activeTimes: {
        hasData:    false,
        grid:       null,
        peakWindow: null,
      },
    };

  } finally {
    client.release();
  }
}
