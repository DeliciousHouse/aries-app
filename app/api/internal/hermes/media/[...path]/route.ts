import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { tenantOwnsHermesMediaBasename } from '@/backend/marketing/runtime-state';
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

  // Tenant ownership check: verify that the requesting tenant's social-content
  // runtime documents actually reference this basename in an artifact_url before
  // streaming bytes.  The Hermes image cache is a flat, non-tenant-namespaced
  // directory, so without this check any authenticated operator could request
  // any filename.  We return 404 (not 403) to avoid revealing whether a file
  // exists.
  //
  // Implementation: sequential scan of the tenant's marketing job JSON files —
  // no database, no Promise.all fan-out, safe under guardrail #1.
  const { tenantId } = tenantResult.tenantContext;
  const owned = await tenantOwnsHermesMediaBasename(tenantId, basename);
  if (!owned) {
    return new Response(JSON.stringify({ error: 'Not found.' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

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
