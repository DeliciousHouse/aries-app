import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { verifyMediaToken } from '@/lib/signed-media-token';
import { resolveDataRoot } from '@/lib/runtime-paths';

// This route is intentionally public — no session auth, no loadTenantContextOrResponse.
// Access is gate-kept by the HMAC-signed, short-lived token embedded in the URL.
// Signed URLs are only generated after validateAndConsumeApproval succeeds in the
// publish-dispatch handler (see app/api/publish/dispatch/handler.ts).

// SVG is intentionally excluded: serving SVG inline from a public same-origin
// endpoint enables script execution/XSS. Meta Graph API does not accept SVG for
// image_url anyway — only PNG/JPEG/WebP are valid Instagram creative formats.
const CONTENT_TYPE_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function contentTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPE_MAP[ext] ?? 'application/octet-stream';
}

function hermesMediaMountRoot(): string | null {
  const mount = process.env.HERMES_IMAGE_CACHE_MOUNT;
  if (!mount || !mount.trim()) return null;
  return path.normalize(mount.trim());
}

// Root for ingested_asset bytes (operator uploads via upload-replace.ts AND
// Aries-composed story images via story-composer.ts). These live under
// DATA_ROOT/ingested-assets/<tenant>/<sha[:2]>/<sha><ext> — NOT the Hermes mount
// — so the proxy must look here too, or any ingested asset (composed story,
// manual upload) 404s and Meta rejects the publish with "Only photo or video
// can be accepted as media type".
function ingestedAssetsRoot(): string {
  return path.normalize(path.join(resolveDataRoot(), 'ingested-assets'));
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: 'Not found.' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Read `candidate` only if it resolves inside `root` (symlink-safe). Returns the
 * bytes + the resolved path, or null on missing file / outside-root. Throws only
 * on unexpected (non-ENOENT/ENOTDIR) errors, preserving the prior behavior.
 */
async function readWithinRoot(
  root: string,
  candidate: string,
): Promise<{ buffer: Buffer; resolved: string } | null> {
  if (!isWithinRoot(root, candidate)) return null;
  let resolvedRoot: string;
  let resolvedCandidate: string;
  try {
    [resolvedRoot, resolvedCandidate] = await Promise.all([
      realpath(root).catch(() => root),
      realpath(candidate),
    ]);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
  if (!isWithinRoot(resolvedRoot, resolvedCandidate)) return null;
  try {
    const buffer = await readFile(resolvedCandidate);
    return { buffer, resolved: resolvedCandidate };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string; basename: string }> },
) {
  const { token, basename } = await params;

  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) return notFound();

  const payload = verifyMediaToken(token, secret);
  if (!payload) return notFound();

  // URL segment must match the claim embedded in the token
  if (payload.basename !== basename) return notFound();

  // Defense-in-depth: reject any path separators or dotdot in the basename
  if (basename.includes('/') || basename.includes('\\') || basename.includes('..')) {
    return notFound();
  }

  // Resolve bytes from the first root that has the basename. runtime_asset bytes
  // live in the Hermes mount; ingested_asset bytes (operator uploads + composed
  // story images) under DATA_ROOT/ingested-assets/<tenant>/<sha[:2]>/<basename>,
  // a path deterministic from the token's tenantId (so a tenant can only fetch
  // their own ingested bytes) plus the basename's own sha prefix.
  let found: { buffer: Buffer; resolved: string } | null = null;

  const mountRoot = hermesMediaMountRoot();
  if (mountRoot) {
    found = await readWithinRoot(mountRoot, path.resolve(mountRoot, basename));
  }

  if (!found) {
    const ingestedRoot = ingestedAssetsRoot();
    const tenantSegment = String(payload.tenantId);
    // tenantId is a numeric string; reject anything that could escape the root.
    if (/^[0-9]+$/.test(tenantSegment)) {
      const candidate = path.resolve(ingestedRoot, tenantSegment, basename.slice(0, 2), basename);
      found = await readWithinRoot(ingestedRoot, candidate);
    }
  }

  if (!found) return notFound();

  const secondsUntilExpiry = Math.max(0, Math.floor((payload.expiresAt - Date.now()) / 1000));
  const cacheMaxAge = Math.min(secondsUntilExpiry, 3600);

  // new Uint8Array(buffer): TS 6's BodyInit rejects a Node Buffer<ArrayBufferLike>; same bytes.
  return new Response(new Uint8Array(found.buffer), {
    status: 200,
    headers: {
      'content-type': contentTypeForPath(found.resolved),
      'cache-control': `public, max-age=${cacheMaxAge}`,
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
    },
  });
}
