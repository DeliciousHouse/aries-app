/**
 * Rollout gate for the WEEKLY RESULTS report (S5-1 / AA-110, gap F1b).
 *
 * Gates the whole surface: the `/dashboard/results` panel and the
 * `GET /api/dashboard/weekly-results` route. OFF ⇒ the results screen renders
 * exactly today's roster and the route returns `{ enabled: false }` without
 * touching the database.
 *
 * Treat 1/true/yes/on as enabled, matching the ARIES_WEEKLY_REEL_ENABLED /
 * ARIES_IMAGE_EDIT_ENABLED convention. Process-wide; default OFF.
 */
type Env = Partial<Record<string, string | undefined>>;

export function isWeeklyResultsEnabled(env: Env = process.env): boolean {
  const v = env.ARIES_WEEKLY_RESULTS_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
