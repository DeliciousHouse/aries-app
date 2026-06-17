import { readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Read-time availability check for browser-facing Hermes media preview URLs.
 *
 * The marketing pipeline bakes an absolute `artifact_url`
 * (`${APP_BASE_URL}/api/internal/hermes/media/<basename>`) into the runtime job
 * docs when a creative is generated. The dashboard projection surfaces that URL
 * as an `<img src>` preview. The Hermes image cache (the read-only mount this
 * route serves from) evicts old files, so a ~weeks-old `artifact_url` can point
 * at a basename that is no longer on disk — the browser then 404s and the
 * operator sees a broken thumbnail instead of the graceful placeholder
 * (qa-defect #599: "ready-to-publish inventory references missing Hermes media").
 *
 * The gc-missing-hermes-assets worker only marks `creative_assets` rows
 * (`storage_kind='runtime_asset'`); it never touches the runtime job docs, which
 * is where these preview URLs actually come from — so it cannot clear #599.
 * Re-materialising is impossible (the source bytes are gone). The correct,
 * lowest-risk fix is to treat an evicted-media preview URL as absent at read
 * time so the existing placeholder fallback fires.
 *
 * This check is deliberately FAIL-OPEN: if the mount is unconfigured or
 * unreadable (tests, misconfigured env), every URL passes through unchanged so
 * behaviour is byte-identical to today. It only ever nulls a basename-addressed
 * hermes-media URL whose file is *confirmed missing* from a *readable* mount.
 */

// Matches a canonical creative_assets UUID (the id-addressed media form). Those
// resolve through the DB (and are tracked by `orphaned_at`), not by a flat
// basename on the mount, so we never null them here — only the legacy
// basename-addressed form, which is the actual #599 culprit.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HERMES_MEDIA_PATH_PREFIX = '/api/internal/hermes/media/';

// One readdir of the (small, ~hundreds of files) mount is amortised across all
// previews in a dashboard render via this short-lived listing cache. Membership
// is then O(1) per URL — no per-URL stat fan-out on the customer-facing list
// endpoint (CLAUDE.md guardrail #1). The window is short so a freshly-generated
// image is hidden for at most this long before the cache refreshes.
const LISTING_TTL_MS = 15_000;

let cachedListing: { root: string; names: Set<string>; expiresAt: number } | null = null;

function mountRoot(): string | null {
  const mount = process.env.HERMES_IMAGE_CACHE_MOUNT;
  if (!mount || !mount.trim()) {
    return null;
  }
  return path.normalize(mount.trim());
}

/**
 * The set of basenames currently on the Hermes mount, or `null` when the mount
 * is unconfigured/unreadable (caller then fails open). Cached for LISTING_TTL_MS
 * and keyed by mount root so an env change (e.g. between tests) invalidates it.
 */
function mountListing(now: number): Set<string> | null {
  const root = mountRoot();
  if (!root) {
    return null;
  }
  if (cachedListing && cachedListing.root === root && cachedListing.expiresAt > now) {
    return cachedListing.names;
  }
  try {
    // NOTE: a readable-but-WRONG mount (e.g. an existing empty dir from a
    // misconfigured HERMES_IMAGE_CACHE_MOUNT — the same failure CLAUDE.md flags
    // for ingestion) yields an empty Set, so every live preview reads as missing
    // and falls back to the placeholder for up to the TTL. That is strictly nicer
    // than today's behaviour: the media route reads the same mount, so the same
    // misconfig already 404s those `<img>` requests in the browser.
    const names = new Set(readdirSync(root));
    cachedListing = { root, names, expiresAt: now + LISTING_TTL_MS };
    return names;
  } catch {
    // Unreadable mount — fail open (do not hide media we cannot verify).
    cachedListing = null;
    return null;
  }
}

/**
 * Extracts the flat Hermes-cache basename a URL addresses, or `null` if the URL
 * is not a basename-addressed `/api/internal/hermes/media/<basename>` reference
 * (non-hermes URLs, id/UUID-addressed media, nested paths all return null).
 * Accepts absolute or relative URLs.
 */
export function hermesMediaBasenameFromUrl(url: string): string | null {
  let pathname: string;
  try {
    // Base only used to parse relative URLs; absolute URLs ignore it.
    pathname = new URL(url, 'http://internal.invalid').pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith(HERMES_MEDIA_PATH_PREFIX)) {
    return null;
  }
  const rest = pathname.slice(HERMES_MEDIA_PATH_PREFIX.length);
  if (!rest || rest.includes('/')) {
    return null;
  }
  let basename: string;
  try {
    basename = decodeURIComponent(rest);
  } catch {
    basename = rest;
  }
  if (!basename || UUID_RE.test(basename)) {
    return null;
  }
  return basename;
}

/**
 * True only when `url` is a basename-addressed hermes-media URL whose file is
 * confirmed missing from a readable mount. Fails open (false) for every other
 * case: empty/non-hermes/id-addressed URLs, and any URL when the mount is
 * unconfigured or unreadable.
 */
export function isMissingHermesMedia(url: string | null | undefined, now: number = Date.now()): boolean {
  if (!url) {
    return false;
  }
  const basename = hermesMediaBasenameFromUrl(url);
  if (!basename) {
    return false;
  }
  const listing = mountListing(now);
  if (!listing) {
    return false;
  }
  return !listing.has(basename);
}

/**
 * Returns `url` unchanged unless it is a basename-addressed hermes-media URL
 * whose file is confirmed missing from the mount, in which case it returns
 * `null` so the caller's placeholder fallback can fire. Pure pass-through for
 * `null`/non-hermes/unverifiable URLs.
 */
export function availableHermesMediaUrl(
  url: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!url) {
    return null;
  }
  return isMissingHermesMedia(url, now) ? null : url;
}

/**
 * READ-TIME sanitizer for dashboard asset previews (qa-defect #599 re-fix).
 *
 * The build-time `availableHermesMediaUrl` wrap in `createAssets` only fires
 * when the social-content dashboard projection is (re)built. But the Posts page
 * (`/api/marketing/posts` → `getWorkflowAwareDashboardContentForTenant`) serves
 * the *persisted* `dashboard_list_projection.listRow.dashboard.assets` O(1)
 * whenever its baked `sourceUpdatedAt` still matches the runtime doc — which is
 * the steady state for old jobs whose runtime docs never change again. Those
 * blobs were baked weeks ago, when the Hermes-cache files still existed, so the
 * basename-addressed `artifact_url` previews they carry now 404 in the browser
 * after the cache evicted the files. The build-time wrap can never reach them.
 *
 * This nulls `previewUrl`/`thumbnailUrl` on each asset whose basename is
 * confirmed missing from the readable mount, at the moment the assets are
 * served — so the UI placeholder fallback fires instead of a dead `<img>`.
 * Fail-open and pure pass-through for live media (one cached `readdir` amortised
 * across the whole render, O(1) per URL — CLAUDE.md guardrail #1): an asset
 * whose preview is present, non-hermes, id/UUID-addressed, or unverifiable is
 * returned byte-identical.
 */
export function sanitizeAssetPreviewsForMissingMedia<
  T extends { previewUrl?: string | null; thumbnailUrl?: string | null },
>(assets: readonly T[], now: number = Date.now()): T[] {
  return assets.map((asset) => {
    const previewMissing = isMissingHermesMedia(asset.previewUrl, now);
    const thumbnailMissing = isMissingHermesMedia(asset.thumbnailUrl, now);
    if (!previewMissing && !thumbnailMissing) {
      return asset;
    }
    return {
      ...asset,
      previewUrl: previewMissing ? null : asset.previewUrl,
      thumbnailUrl: thumbnailMissing ? null : asset.thumbnailUrl,
    };
  });
}

/** Test-only: clear the mount listing cache so a test can swap the mount dir. */
export function __resetHermesMediaPresenceCacheForTests(): void {
  cachedListing = null;
}
