import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { loadTenantContextOrResponse } from '@/lib/tenant-context-http';

// Maps file extension to Content-Type for common image formats Hermes emits.
const CONTENT_TYPE_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

function contentTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPE_MAP[ext] ?? 'application/octet-stream';
}

function hermesMediaMountRoot(): string | null {
  const mount = process.env.HERMES_IMAGE_CACHE_MOUNT;
  if (!mount || !mount.trim()) {
    return null;
  }
  return path.normalize(mount.trim());
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  // Authenticate via session — this route is loaded by <img> tags in the
  // browser and must use operator session auth, not INTERNAL_API_SECRET.
  const tenantResult = await loadTenantContextOrResponse();
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  const mountRoot = hermesMediaMountRoot();
  if (!mountRoot) {
    return new Response(JSON.stringify({ error: 'Hermes media mount not configured.' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Accept only a single filename segment — the schema bridge writes basenames
  // only (no subdirs). Reject anything that isn't a flat filename.
  const { path: segments } = await params;
  if (!segments || segments.length !== 1 || !segments[0]) {
    return new Response(JSON.stringify({ error: 'Not found.' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const basename = segments[0];
  // Reject any path separators or dotdot sequences embedded in the segment
  // itself (defense-in-depth: Next.js already splits on `/`, but be explicit).
  if (basename.includes('/') || basename.includes('\\') || basename.includes('..')) {
    return new Response(JSON.stringify({ error: 'Not found.' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Resolve the candidate and verify it stays within the mount root both
  // before and after realpath (symlink-safe, matches the pattern in
  // readMarketingAssetWithinAllowedRoots).
  const candidate = path.resolve(mountRoot, basename);
  if (!isWithinRoot(mountRoot, candidate)) {
    return new Response(JSON.stringify({ error: 'Not found.' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

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
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return new Response(JSON.stringify({ error: 'Not found.' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw error;
  }

  if (!isWithinRoot(resolvedMountRoot, resolvedCandidate)) {
    return new Response(JSON.stringify({ error: 'Not found.' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  // NOTE: Tenant-scoping gap — the Hermes image cache is not tenant-namespaced
  // on disk, so any authenticated operator can request any basename. The schema
  // bridge records artifact_url values in tenant-owned runtime documents, which
  // means a determined operator would need to guess filenames. A full fix would
  // cross-check the requested basename against artifact_url entries in the
  // requesting tenant's social-content runs before serving. That lookup requires
  // plumbing through runtime-state and is deferred as a follow-up hardening
  // item. Present mitigation: session auth (operator must be logged in) and
  // path-traversal containment (cannot escape the /hermes-media mount).

  let buffer: Buffer;
  try {
    buffer = await readFile(resolvedCandidate);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return new Response(JSON.stringify({ error: 'Not found.' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw error;
  }

  return new Response(buffer, {
    status: 200,
    headers: {
      'content-type': contentTypeForPath(resolvedCandidate),
      'content-disposition': 'inline',
      'cache-control': 'private, max-age=300',
    },
  });
}
