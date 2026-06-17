/**
 * Rollout gate for NATIVE comment reply (qa-defect #598).
 *
 * When ON, `POST /api/insights/comments/[commentId]/reply` posts an operator
 * reply to Meta (IG /replies, FB /comments) and marks the insights_comments row.
 * When OFF (default) the route is invisible — it returns a real 404, touches no
 * DB and no Graph API.
 *
 * Treat 1/true/yes/on as enabled, matching the ARIES_SLACK_NOTIFICATIONS_ENABLED
 * / ARIES_FEED_LOGO_COMPOSITE_ENABLED convention. Process-wide; default OFF.
 */
type Env = Partial<Record<string, string | undefined>>;

export function isNativeReplyEnabled(env: Env = process.env): boolean {
  const v = env.ARIES_NATIVE_REPLY_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
