import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { pool } from '@/lib/db';
import { tenantOwnsHermesMediaBasename } from '@/backend/marketing/runtime-state';
import { resolveDataRoot } from '@/lib/runtime-paths';
import { loadTenantContextOrResponse } from '@/lib/tenant-context-http';

// Matches a canonical lowercase/uppercase UUID (creative_assets.id). A single
// path segment shaped like this is treated as an id-addressed read; anything
// else falls through to the legacy basename path.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// Root for manually-uploaded creatives (storage_kind='ingested_asset'). These
// live under DATA_ROOT/ingested-assets, written by upload-replace.ts. Kept
// separate from the Hermes mount so the id route only ever resolves bytes
// within the root that matches the row's storage_kind.
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

function isMissingFsError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
        (error as NodeJS.ErrnoException).code === 'ENOTDIR'),
  );
}

function streamFile(buffer: Buffer, resolvedPath: string): Response {
  // new Uint8Array(buffer): TS 6's BodyInit rejects a Node Buffer<ArrayBufferLike>; same bytes.
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'content-type': contentTypeForPath(resolvedPath),
      'content-disposition': 'inline',
      'cache-control': 'private, max-age=300',
    },
  });
}

/**
 * Resolves on-disk bytes for `storage_key` while keeping it inside `root`.
 * Reuses the same isWithinRoot + double-realpath (symlink-safe) guard the
 * basename path uses. Returns the streamed Response, or a 404 Response for a
 * missing / escaping / unreadable path. Throws only on unexpected FS errors.
 */
async function resolveBytesWithinRoot(root: string, storageKey: string): Promise<Response> {
  const normalizedRoot = path.normalize(root);
  const candidate = path.resolve(normalizedRoot, storageKey);
  if (!isWithinRoot(normalizedRoot, candidate)) {
    return notFound();
  }

  let resolvedRoot: string;
  let resolvedCandidate: string;
  try {
    [resolvedRoot, resolvedCandidate] = await Promise.all([
      realpath(normalizedRoot).catch(() => normalizedRoot),
      realpath(candidate),
    ]);
  } catch (error) {
    if (isMissingFsError(error)) {
      return notFound();
    }
    throw error;
  }

  if (!isWithinRoot(resolvedRoot, resolvedCandidate)) {
    return notFound();
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(resolvedCandidate);
  } catch (error) {
    if (isMissingFsError(error)) {
      return notFound();
    }
    throw error;
  }

  return streamFile(buffer, resolvedCandidate);
}

interface CreativeAssetRow {
  storage_kind: string | null;
  storage_key: string | null;
}

/**
 * Id-addressed read. Ownership is enforced authoritatively in SQL
 * (WHERE id=$1 AND tenant_id=$2) — one indexed PK lookup, no fan-out
 * (guardrail #1). 404 (never 403) on missing row / wrong tenant / unresolvable
 * bytes, preserving the no-existence-leak posture of the basename path.
 */
async function serveById(assetId: string, tenantId: string): Promise<Response> {
  const tenantIdInt = Number(tenantId);
  if (!Number.isFinite(tenantIdInt) || tenantIdInt <= 0) {
    return notFound();
  }

  const { rows } = await pool.query<CreativeAssetRow>(
    `SELECT storage_kind, storage_key
       FROM creative_assets
      WHERE id = $1 AND tenant_id = $2
      LIMIT 1`,
    [assetId, tenantIdInt],
  );
  const row = rows[0];
  if (!row || !row.storage_key) {
    return notFound();
  }

  // Choose the allowed root by storage_kind. runtime_asset bytes live under the
  // Hermes mount; ingested_asset (manual uploads) under DATA_ROOT/ingested-assets.
  // external_url / none / anything else is not a local-file read -> 404.
  let root: string | null;
  if (row.storage_kind === 'runtime_asset') {
    root = hermesMediaMountRoot();
  } else if (row.storage_kind === 'ingested_asset') {
    root = ingestedAssetsRoot();
  } else {
    return notFound();
  }
  if (!root) {
    return notFound();
  }

  return resolveBytesWithinRoot(root, row.storage_key);
}

/**
 * Legacy basename-addressed read. Kept as a back-compat fallback for rows whose
 * served_asset_ref predates id-based addressing. Ownership is the collision-prone
 * shared-cache basename match in tenantOwnsHermesMediaBasename; the id path above
 * is the authoritative one for new rows.
 */
async function serveByBasename(basename: string, tenantId: string): Promise<Response> {
  const mountRoot = hermesMediaMountRoot();
  if (!mountRoot) {
    return notFound();
  }

  // Reject any path separators or dotdot sequences embedded in the segment
  // itself (defense-in-depth: Next.js already splits on `/`, but be explicit).
  if (basename.includes('/') || basename.includes('\\') || basename.includes('..')) {
    return notFound();
  }

  // Tenant ownership check: verify that the requesting tenant actually
  // references this basename before streaming bytes. The Hermes image cache is
  // a flat, non-tenant-namespaced directory, so without this check any
  // authenticated operator could request any filename. We return 404 (not 403)
  // to avoid revealing whether a file exists.
  const owned = await tenantOwnsHermesMediaBasename(tenantId, basename);
  if (!owned) {
    return notFound();
  }

  return resolveBytesWithinRoot(mountRoot, basename);
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

  // Accept only a single segment — either a creative_assets UUID (id path) or a
  // flat Hermes basename (legacy path). Anything else (subdirs, empty) -> 404.
  const { path: segments } = await params;
  if (!segments || segments.length !== 1 || !segments[0]) {
    return notFound();
  }

  const { tenantId } = tenantResult.tenantContext;
  const segment = segments[0];

  if (UUID_RE.test(segment)) {
    return serveById(segment, tenantId);
  }
  return serveByBasename(segment, tenantId);
}
