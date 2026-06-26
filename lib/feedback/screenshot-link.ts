/**
 * App-served durable screenshot link. Shared by every feedback mirror sink
 * (Google Sheet, JIRA) so they all point at the same durable image route
 * (/api/feedback/screenshot/:id) rather than a destination-specific store.
 * Kept in its own module so sinks can import it without importing each other.
 */

import type { FeedbackConfig } from './feedback-config';

/** Build the app-served durable screenshot link (relative if no base URL is set). */
export function appServedScreenshotLink(
  config: Pick<FeedbackConfig, 'appBaseUrl'>,
  submissionId: string,
): string {
  const path = `/api/feedback/screenshot/${encodeURIComponent(submissionId)}`;
  // Prefer an absolute URL so the link is clickable; fall back to a relative
  // path rather than an empty value when no base URL is configured.
  return config.appBaseUrl ? `${config.appBaseUrl.replace(/\/+$/, '')}${path}` : path;
}
