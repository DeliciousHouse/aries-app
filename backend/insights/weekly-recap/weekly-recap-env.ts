/**
 * Rollout gate for the WEEKLY RECAP report (S5-1 / AA-110, gap F1b; relocated
 * into the insights section family by AA-229/PR2b).
 *
 * Gates the `weekly-recap` insights section: `GET /api/insights/weekly-recap`.
 * OFF ⇒ the route returns `{ enabled: false }` without touching the database,
 * before tenant resolution and before any pooled client.
 *
 * Treat 1/true/yes/on as enabled, matching the ARIES_WEEKLY_REEL_ENABLED /
 * ARIES_IMAGE_EDIT_ENABLED convention. Process-wide; default OFF.
 */
type Env = Partial<Record<string, string | undefined>>;

export function isWeeklyResultsEnabled(env: Env = process.env): boolean {
  const v = env.ARIES_WEEKLY_RESULTS_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
