const DEFAULT_INSIGHTS_STALE_MINUTES = 60;

/**
 * Shared stale window for insights surfaces. The worker runs every 30 minutes,
 * so the default warning threshold is two missed ticks.
 */
export function resolveInsightsStaleMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env.ARIES_INSIGHTS_STALE_MINUTES);
  const minutes = Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_INSIGHTS_STALE_MINUTES;
  return minutes * 60_000;
}
