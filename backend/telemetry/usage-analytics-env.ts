/**
 * AA-166 — rollout gate for the customer-facing usage analytics surface.
 *
 * When ON, `GET /api/telemetry/usage-analytics` serves a workspace's own
 * consumption breakdown (series over time, top users, slowest tasks, engine
 * split) and `/dashboard/usage` renders it.
 *
 * When OFF (default) the route is invisible — it returns a real 404, touches no
 * DB — and the page 404s, byte-identical to neither existing. This mirrors the
 * `isImageEditEnabled` / `isNativeReplyEnabled` invisible-endpoint convention.
 *
 * Treat 1/true/yes/on as enabled, matching the ARIES_TASK_TELEMETRY_ENABLED /
 * ARIES_USAGE_ROLLUP_ENABLED convention. Process-wide; default OFF.
 *
 * Note this surface reads the AA-161/162 rollups, so it shows nothing until
 * ARIES_USAGE_ROLLUP_ENABLED has been on long enough for a pass to land — which
 * the payload reports honestly as `metered: false` rather than as zeros.
 */
type Env = Partial<Record<string, string | undefined>>;

export function isUsageAnalyticsEnabled(env: Env = process.env): boolean {
  const v = env.ARIES_USAGE_ANALYTICS_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
