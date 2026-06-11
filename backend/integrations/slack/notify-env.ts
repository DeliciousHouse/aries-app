/**
 * Rollout gate for OUTBOUND Slack notifications (Phase 4 PR 2).
 *
 * When ON, the marketing callback path posts a Slack message to a configured
 * channel when a job reaches an approval gate that a human still needs to act
 * on (and, in later increments, on completion/failure). The inbound webhook
 * (PR1, `events/`) is unaffected by this flag — it only gates the new outbound
 * direction.
 *
 * Treat 1/true/yes/on as enabled, matching the ARIES_FEED_LOGO_COMPOSITE_ENABLED
 * / ARIES_DRAFT_EXPIRY_ENABLED convention. Process-wide; default OFF so the
 * callback path is byte-identical to today until a Slack app + bot token are
 * configured and the flag is flipped.
 */
type Env = Partial<Record<string, string | undefined>>;

export function isSlackNotificationsEnabled(env: Env = process.env): boolean {
  const v = env.ARIES_SLACK_NOTIFICATIONS_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
