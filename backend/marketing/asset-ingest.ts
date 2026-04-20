import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

import { resolveDataRoot } from '@/lib/runtime-paths';

/**
 * Ingest any absolute file paths embedded in a marketing runtime document so
 * that every referenced asset ends up inside DATA_ROOT and the document only
 * stores paths the aries-app container can read.
 *
 * Background: OpenClaw/Lobster runs on the host and writes generated assets
 * under /home/node/openclaw/aries-app/lobster/output/... . Those paths are
 * invisible inside the aries-app container (different filesystem namespace),
 * so `readMarketingAssetWithinAllowedRoots` correctly refuses to serve them
 * and the asset routes 404. We fix this at the ingest boundary — the single
 * `saveMarketingJobRuntime` call that every runtime mutation funnels through —
 * by copying bytes into DATA_ROOT and rewriting the embedded path.
 *
 * Strategy:
 *   1. Walk the doc. For every string that looks like an absolute filesystem
 *      path, attempt ingest.
 *   2. If the path is already inside DATA_ROOT, leave it alone.
 *   3. If the path has a host-output prefix, remap it to the container-side
 *      mount (ARIES_LOBSTER_HOST_OUTPUT_MOUNT, default /host-lobster-output).
 *   4. If the resulting path is readable, copy the bytes to a content-
 *      addressed location under DATA_ROOT/ingested-assets/{sha[0:2]}/{sha}/
 *      and rewrite the string in place.
 *   5. If the source is unreadable, leave the original string unchanged
 *      (same failure mode as before — no new regression).
 *
 * Idempotent: content-addressed destination dedupes; subsequent saves of the
 * same doc are cheap (stat-only). Memoized per-call so one save hashes each
 * source at most once.
 */

const DEFAULT_HOST_OUTPUT_MOUNT = '/host-lobster-output';
const INGEST_SUBDIR = 'ingested-assets';

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
  cache: Map<string, string>;
  result: AssetIngestResult;
}

function buildContext(): IngestContext {
  const hostOutputDir = process.env.ARIES_LOBSTER_HOST_OUTPUT_DIR?.trim();
  const hostOutputMount = process.env.ARIES_LOBSTER_HOST_OUTPUT_MOUNT?.trim() || DEFAULT_HOST_OUTPUT_MOUNT;
  return {
    dataRoot: path.normalize(resolveDataRoot()),
    hostOutputDir: hostOutputDir ? path.normalize(hostOutputDir) : null,
    hostOutputMount: path.normalize(hostOutputMount),
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

function destinationFor(ctx: IngestContext, sha: string, basename: string): string {
  return path.join(ctx.dataRoot, INGEST_SUBDIR, sha.slice(0, 2), sha, basename);
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

  let bytes: Buffer;
  try {
    bytes = readFileSync(readable);
  } catch {
    ctx.result.skipped.push({ path: original, reason: 'unreadable' });
    ctx.cache.set(original, original);
    return original;
  }

  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const basename = path.basename(normalized);
  const dest = destinationFor(ctx, sha, basename);

  if (!existsSync(dest)) {
    mkdirSync(path.dirname(dest), { recursive: true });
    // Write to a temp file and rename to avoid partial-read races if two
    // saves fight over the same sha in parallel.
    const tmp = `${dest}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      writeFileSync(tmp, bytes);
      renameSync(tmp, dest);
    } catch (err) {
      // EEXIST after the existsSync check means a sibling writer won; that's
      // fine. Anything else we log and keep the original path so we don't
      // break the save.
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== 'EEXIST') {
        console.warn('[asset-ingest] copy failed, keeping original path', {
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
      return bytes.length;
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
 * Mutates `doc` in place: rewrites embedded absolute paths to DATA_ROOT
 * locations and copies bytes as needed. Safe to call on any JSON-shaped
 * value. Returns a summary for logging.
 */
export function ingestRuntimeDocAssets<T extends Record<string, unknown>>(doc: T): AssetIngestResult {
  const ctx = buildContext();
  walkAndRewrite(doc, ctx);
  return ctx.result;
}

/**
 * Exposed for tests + backfill script. Does not require a doc — just rewrites
 * a single path string using the same policy.
 */
export function ingestSinglePath(original: string): string {
  const ctx = buildContext();
  return ingestOne(original, ctx);
}
