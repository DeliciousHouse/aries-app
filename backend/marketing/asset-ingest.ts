import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const INGEST_CHUNK_BYTES = 64 * 1024;

import { resolveDataRoot } from '@/lib/runtime-paths';

/**
 * Ingest any absolute file paths embedded in a marketing runtime document so
 * every referenced asset ends up inside DATA_ROOT and the document only
 * stores paths the aries-app container can read.
 *
 * Storage layout: `DATA_ROOT/ingested-assets/{tenant_id}/{sha[0:2]}/{sha}.{ext}`.
 * The tenant_id segment is mandatory — two tenants uploading byte-identical
 * files MUST land in distinct paths so a path leak in one tenant cannot be
 * replayed against another. Within a single tenant, content-addressed dedup
 * still holds: re-uploading the same bytes hits the same path. Documents
 * passed through `ingestRuntimeDocAssets` carry `doc.tenant_id`; the explicit
 * `tenantId` argument is the contract for callers without a doc context.
 *
 * Idempotent: content-addressed destination dedupes; subsequent saves of the
 * same doc are cheap (stat-only). Memoized per-call so one save hashes each
 * source at most once.
 */

const DEFAULT_HOST_OUTPUT_MOUNT = '/host-lobster-output';
const INGEST_SUBDIR = 'ingested-assets';
// Sentinel used only when an ingest is invoked without any tenant context —
// keeps existing test fixtures compiling but never collides with a real
// numeric or slug tenant id, so production cross-tenant isolation is intact.
const UNSCOPED_TENANT_SEGMENT = '_unscoped_';

export interface AssetIngestRewrite {
  from: string;
  to: string;
  bytes: number;
}

export interface AssetIngestResult {
  rewrites: AssetIngestRewrite[];
  skipped: Array<{ path: string; reason: 'unreadable' | 'already_in_data_root' }>;
}

interface IngestContext {
  dataRoot: string;
  hostOutputDir: string | null;
  hostOutputMount: string;
  tenantSegment: string;
  cache: Map<string, string>;
  result: AssetIngestResult;
}

function normalizeTenantSegment(raw: unknown): string {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed) return trimmed;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return String(raw);
  }
  return '';
}

function buildContext(tenantId: string): IngestContext {
  const hostOutputDir = process.env.ARIES_HOST_ARTIFACT_OUTPUT_DIR?.trim();
  const hostOutputMount = process.env.ARIES_HOST_ARTIFACT_OUTPUT_MOUNT?.trim() || DEFAULT_HOST_OUTPUT_MOUNT;
  const tenantSegment = tenantId || UNSCOPED_TENANT_SEGMENT;
  return {
    dataRoot: path.normalize(resolveDataRoot()),
    hostOutputDir: hostOutputDir ? path.normalize(hostOutputDir) : null,
    hostOutputMount: path.normalize(hostOutputMount),
    tenantSegment,
    cache: new Map(),
    result: { rewrites: [], skipped: [] },
  };
}

function isAbsoluteFileLike(value: string): boolean {
  if (!value || !path.isAbsolute(value)) return false;
  // Reject strings that don't plausibly point at a file. Keeps us from trying
  // to copy anything that happens to start with "/" (e.g., URL paths, some
  // route identifiers).
  const base = path.basename(value);
  if (!base || base === '.' || base === '..') return false;
  // Require a dotted extension. Every path we care about (markdown, JSON,
  // HTML, PNG, MP4, …) has one; bare directory paths and identifiers don't.
  const dotIdx = base.lastIndexOf('.');
  return dotIdx > 0 && dotIdx < base.length - 1;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function remapHostPath(absPath: string, ctx: IngestContext): string {
  if (!ctx.hostOutputDir) return absPath;
  if (absPath === ctx.hostOutputDir) return ctx.hostOutputMount;
  const prefix = `${ctx.hostOutputDir}${path.sep}`;
  if (absPath.startsWith(prefix)) {
    const suffix = absPath.slice(prefix.length);
    return path.join(ctx.hostOutputMount, suffix);
  }
  return absPath;
}

function destinationFor(ctx: IngestContext, sha: string, ext: string): string {
  // Tenant-prefixed, then content-addressed: identical bytes from different
  // tenants land in distinct files (no cross-tenant leak); identical bytes
  // from the same tenant land in the same file (within-tenant dedup).
  // Extension is preserved so readers that dispatch on `.ext` still work.
  return path.join(
    ctx.dataRoot,
    INGEST_SUBDIR,
    ctx.tenantSegment,
    sha.slice(0, 2),
    `${sha}${ext}`,
  );
}

function ingestOne(original: string, ctx: IngestContext): string {
  const cached = ctx.cache.get(original);
  if (cached !== undefined) return cached;

  if (!isAbsoluteFileLike(original)) {
    ctx.cache.set(original, original);
    return original;
  }

  const normalized = path.normalize(original);

  if (isWithinRoot(ctx.dataRoot, normalized)) {
    ctx.result.skipped.push({ path: original, reason: 'already_in_data_root' });
    ctx.cache.set(original, original);
    return original;
  }

  const readable = remapHostPath(normalized, ctx);
  if (!existsSync(readable)) {
    ctx.result.skipped.push({ path: original, reason: 'unreadable' });
    ctx.cache.set(original, original);
    return original;
  }

  // Stream the bytes through a single pass so peak memory stays at the chunk
  // size (64 KB) regardless of asset size — a 200 MB video should not spike
  // container RSS by 200 MB just because someone saved the runtime doc.
  const stagingDir = path.join(ctx.dataRoot, INGEST_SUBDIR);
  let srcFd = -1;
  let tmpFd = -1;
  let tmp = '';
  const hash = crypto.createHash('sha256');
  let totalBytes = 0;
  try {
    srcFd = openSync(readable, 'r');
  } catch {
    ctx.result.skipped.push({ path: original, reason: 'unreadable' });
    ctx.cache.set(original, original);
    return original;
  }

  try {
    mkdirSync(stagingDir, { recursive: true });
    tmp = path.join(
      stagingDir,
      `.ingest-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
    );
    tmpFd = openSync(tmp, 'wx');

    const buf = Buffer.allocUnsafe(INGEST_CHUNK_BYTES);
    for (;;) {
      const n = readSync(srcFd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      writeSync(tmpFd, buf, 0, n);
      totalBytes += n;
    }
  } catch (err) {
    try { if (tmpFd >= 0) closeSync(tmpFd); } catch {}
    try { if (srcFd >= 0) closeSync(srcFd); } catch {}
    if (tmp) { try { unlinkSync(tmp); } catch {} }
    console.warn('[asset-ingest] stream copy failed, keeping original path', {
      source: readable,
      code: (err as NodeJS.ErrnoException | null)?.code,
    });
    ctx.result.skipped.push({ path: original, reason: 'unreadable' });
    ctx.cache.set(original, original);
    return original;
  }

  closeSync(tmpFd);
  closeSync(srcFd);

  const sha = hash.digest('hex');
  const ext = path.extname(normalized);
  const dest = destinationFor(ctx, sha, ext);

  if (existsSync(dest)) {
    // Content-addressed dedupe: another save already landed these exact
    // bytes. Drop our tmp and point at the canonical copy.
    try { unlinkSync(tmp); } catch {}
  } else {
    mkdirSync(path.dirname(dest), { recursive: true });
    try {
      renameSync(tmp, dest);
    } catch (err) {
      // Lost the race with a sibling writer (EEXIST) — identical bytes under
      // the same sha, so the end state is still correct. Anything else we
      // log and fall back to the original path.
      try { unlinkSync(tmp); } catch {}
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== 'EEXIST') {
        console.warn('[asset-ingest] rename failed, keeping original path', {
          source: readable,
          dest,
          code,
        });
        ctx.cache.set(original, original);
        ctx.result.skipped.push({ path: original, reason: 'unreadable' });
        return original;
      }
    }
  }

  const size = (() => {
    try {
      return statSync(dest).size;
    } catch {
      return totalBytes;
    }
  })();

  ctx.result.rewrites.push({ from: original, to: dest, bytes: size });
  ctx.cache.set(original, dest);
  return dest;
}

function walkAndRewrite(node: unknown, ctx: IngestContext): unknown {
  if (typeof node === 'string') {
    const next = ingestOne(node, ctx);
    return next;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const next = walkAndRewrite(node[i], ctx);
      if (next !== node[i]) {
        node[i] = next;
      }
    }
    return node;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const next = walkAndRewrite(obj[key], ctx);
      if (next !== obj[key]) {
        obj[key] = next;
      }
    }
    return obj;
  }
  return node;
}

/**
 * Mutates `doc` in place: rewrites embedded absolute paths into DATA_ROOT
 * tenant-prefixed locations and copies bytes as needed. Tenant id is taken
 * from the explicit `tenantId` argument when supplied, else from
 * `doc.tenant_id`; both absent triggers an unscoped fallback that is safe
 * but never used in production (saveMarketingJobRuntime always passes a
 * tenant-bearing doc).
 */
export function ingestRuntimeDocAssets<T extends Record<string, unknown>>(
  doc: T,
  tenantId?: string,
): AssetIngestResult {
  const tenantSegment = normalizeTenantSegment(tenantId) || normalizeTenantSegment(doc.tenant_id);
  const ctx = buildContext(tenantSegment);
  walkAndRewrite(doc, ctx);
  return ctx.result;
}

/**
 * Single-path ingest variant for tests and the backfill script. Tenant id
 * is required for production callers; the optional signature exists only to
 * preserve backward compatibility with pre-tenant-prefix call sites that
 * still get the unscoped fallback path.
 */
export function ingestSinglePath(original: string, tenantId?: string): string {
  const ctx = buildContext(normalizeTenantSegment(tenantId));
  return ingestOne(original, ctx);
}
