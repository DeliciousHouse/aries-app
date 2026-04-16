/**
 * Validate an href before rendering it as an anchor target.
 *
 * Accepts:
 *   - Absolute http(s) URLs (`https://example.com/foo`)
 *   - Same-origin relative paths (`/foo`, `./foo`, `../foo`)
 *   - Query- or fragment-only refs (`?x=1`, `#section`)
 *
 * Rejects:
 *   - `javascript:`, `data:`, `file:`, `vbscript:`, or any non-http(s) scheme
 *   - Scheme-relative URLs (`//example.com/...`) because their effective
 *     scheme depends on the current page protocol and it makes phishing-style
 *     host swaps easy to hide
 *   - Empty / whitespace-only strings and non-string input
 *
 * Use this on any href that originates outside our own codebase
 * (tenant-provided URLs, pipeline-generated URLs, runtime state, etc.)
 * before passing it to `<a href=...>` or `<Link href=...>`. See
 * `backend/marketing/brand-kit.ts#isLikelyFirstPartyLogo` for the equivalent
 * server-side guard on logo URLs.
 */
export function safeHref(href: string | null | undefined): string | null {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (!trimmed) return null;

  // Scheme-relative URLs (//example.com/...) — reject; their scheme depends
  // on the current page, and this makes phishing-style host swaps easy to hide.
  if (trimmed.startsWith('//')) return null;

  // Same-origin relative paths and fragment/query-only refs are safe.
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('?') ||
    trimmed.startsWith('#')
  ) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return trimmed;
    }
  } catch {
    return null;
  }
  return null;
}
