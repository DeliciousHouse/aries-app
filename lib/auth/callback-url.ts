/**
 * Builds the login redirect URL for an unauthenticated user, preserving the
 * originally requested path as a `callbackUrl` query parameter so the login
 * flow can return the user to where they were trying to go.
 *
 * Rules:
 *   - If pathname is null, empty, or resolves to `/login`, return plain `/login`.
 *   - Otherwise, return `/login?callbackUrl=<encoded>` where the encoded value
 *     is pathname + optional search string.
 *   - `search` may include or omit a leading '?'; both are accepted.
 *   - Only same-origin relative paths (starting with '/') are honored. Any
 *     value that is not a relative path falls back to plain `/login` to avoid
 *     open-redirect vectors.
 */
export function buildLoginRedirect(
  pathname: string | null | undefined,
  search?: string | null | undefined,
): string {
  if (!pathname) {
    return '/login';
  }

  // Must be a same-origin relative path, and not a protocol-relative URL.
  if (!pathname.startsWith('/') || pathname.startsWith('//')) {
    return '/login';
  }

  // Already on login — no callback needed.
  if (pathname === '/login' || pathname.startsWith('/login?') || pathname.startsWith('/login/')) {
    return '/login';
  }

  let normalizedSearch = '';
  if (search) {
    normalizedSearch = search.startsWith('?') ? search : `?${search}`;
    // A bare '?' carries no information; drop it.
    if (normalizedSearch === '?') {
      normalizedSearch = '';
    }
  }

  const target = `${pathname}${normalizedSearch}`;
  return `/login?callbackUrl=${encodeURIComponent(target)}`;
}
