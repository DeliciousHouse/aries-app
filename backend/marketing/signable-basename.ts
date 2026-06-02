/**
 * Phase 3 of id-based Hermes media addressing (Option A).
 *
 * Internal media URLs can now be id-addressed (`/api/internal/hermes/media/<uuid>`).
 * The public proxy (`/api/public/media/<token>/<basename>`) and the signed-media
 * token, however, stay basename-keyed in v1 so the live Meta-fetch contract is
 * unchanged. So before signing a public URL we must resolve an id-addressed
 * internal URL to its on-disk basename; legacy basename URLs pass through
 * untouched.
 *
 * One indexed PK lookup per URL, no fan-out (guardrail #1). Callers must map
 * sequentially, never Promise.all the lookups across media_urls.
 */
import path from 'node:path';

import { pool } from '@/lib/db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SignableDb {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<{ storage_key?: string | null }> }>;
}

/**
 * Returns the on-disk basename to sign for `internalUrl`.
 *
 * - Legacy basename URL -> `path.basename(url)` (today's behavior, no DB hit).
 * - Id-addressed URL (`.../media/<uuid>`) -> look up the row's storage_key for
 *   the owning tenant and return its basename. Returns null when the row is
 *   missing / not owned / has no storage_key, so the caller can skip signing a
 *   URL that the public proxy could not resolve anyway.
 */
export async function resolveSignableBasename(
  internalUrl: string,
  tenantId: string,
  db: SignableDb = pool,
): Promise<string | null> {
  const lastSegment = path.basename(internalUrl);
  if (!lastSegment || lastSegment.includes('..')) {
    return null;
  }

  if (!UUID_RE.test(lastSegment)) {
    // Legacy basename URL — unchanged.
    return lastSegment;
  }

  const tenantIdInt = Number(tenantId);
  if (!Number.isFinite(tenantIdInt) || tenantIdInt <= 0) {
    return null;
  }

  const { rows } = await db.query(
    `SELECT storage_key
       FROM creative_assets
      WHERE id = $1 AND tenant_id = $2
      LIMIT 1`,
    [lastSegment, tenantIdInt],
  );
  const storageKey = rows[0]?.storage_key;
  if (!storageKey) {
    return null;
  }
  const basename = path.basename(storageKey);
  if (!basename || basename.includes('..')) {
    return null;
  }
  return basename;
}
