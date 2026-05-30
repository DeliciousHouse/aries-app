import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { verifyMediaToken } from '@/lib/signed-media-token';

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

  const mountRoot = hermesMediaMountRoot();
  if (!mountRoot) return notFound();

  const candidate = path.resolve(mountRoot, basename);
  if (!isWithinRoot(mountRoot, candidate)) return notFound();

  let resolvedMountRoot: string;
  let resolvedCandidate: string;
  try {
    [resolvedMountRoot, resolvedCandidate] = await Promise.all([
      realpath(mountRoot).catch(() => mountRoot),
      realpath(candidate),
    ]);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
        (error as NodeJS.ErrnoException).code === 'ENOTDIR')
    ) {
      return notFound();
    }
    throw error;
  }

  if (!isWithinRoot(resolvedMountRoot, resolvedCandidate)) return notFound();

  let buffer: Buffer;
  try {
    buffer = await readFile(resolvedCandidate);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
        (error as NodeJS.ErrnoException).code === 'ENOTDIR')
    ) {
      return notFound();
    }
    throw error;
  }

  const secondsUntilExpiry = Math.max(0, Math.floor((payload.expiresAt - Date.now()) / 1000));
  const cacheMaxAge = Math.min(secondsUntilExpiry, 3600);

  // new Uint8Array(buffer): TS 6's BodyInit rejects a Node Buffer<ArrayBufferLike>; same bytes.
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'content-type': contentTypeForPath(resolvedCandidate),
      'cache-control': `public, max-age=${cacheMaxAge}`,
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
    },
  });
}
