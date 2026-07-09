/**
 * backend/insights/escape-html.ts
 *
 * Escape a string for safe interpolation into an HTML string that is later
 * rendered via `dangerouslySetInnerHTML` in the insights UI. The insights cards
 * legitimately inject app-controlled markup (e.g. <em>, <strong>, <span
 * class>), so those strings can't be plain-text-rendered — but any UNTRUSTED
 * value interpolated into them (notably insights_posts.title, which can be an
 * attacker-controlled platform post/video title) must be escaped first, or it
 * becomes stored XSS (S1-2 / AA-81).
 *
 * Coerces null/undefined to '' so callers don't render the literal "null".
 */
export function escapeHtml(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
