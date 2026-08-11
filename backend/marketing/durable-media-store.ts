/**
 * Durable backing store for published media (Google Cloud Storage).
 *
 * WHY THIS EXISTS
 *
 * On 2026-08-11 posts 163 and 166 dead-lettered with "The media could not be
 * fetched from this URI". The cause was not the URL, the token, or Meta: the
 * PNG had been deleted from the Hermes image cache. Every asset generated on
 * 08-10 was gone while the posts referencing them were still queued. Nine
 * pending posts pointed at files that no longer existed.
 *
 * The Hermes cache is a working cache, not storage. It is owned by another
 * process, it is not backed up, and nothing in this repo guarantees a file
 * survives from generation to publish. That gap is now up to twelve days wide
 * because the growth pipeline schedules a fortnight ahead.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does NOT hand Meta a GCS URL. The public proxy contract
 * (`/api/public/media/<hmac-token>/<basename>`) was deliberately kept
 * basename-keyed so the live Meta-fetch contract would not change (see
 * backend/marketing/signable-basename.ts). A GCS signed URL carries a query
 * string, a separate TTL and its own failure modes, and swapping it in would
 * re-open exactly the contract this system took care to freeze.
 *
 * Instead GCS sits BEHIND the existing proxy as a third read root, after the
 * Hermes mount and the ingested-assets root. Meta still fetches the same URL
 * shape from the same origin with the same content-type logic. Only the bytes'
 * provenance changes, and only when the local copy has gone missing.
 *
 * DESIGN NOTES
 *
 * - No @google-cloud/storage dependency. The deploy image is already 4.33GB and
 *   each deploy adds another copy; this needs two REST calls, so it uses the
 *   JSON API directly with a GCE metadata token.
 * - Every entry point fails OPEN. A dead bucket, a missing IAM grant or an
 *   expired token must never break asset ingestion or the publish path. The
 *   worst outcome of this module misbehaving is the behaviour we already have.
 * - Objects are tenant-scoped (`<prefix>/<tenantId>/<basename>`) so the read
 *   path cannot be coaxed across tenants; the caller's tenant comes from the
 *   verified HMAC token, never from user input.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Injectable so tests never touch the network or the metadata server. */
export interface DurableMediaTransport {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

const defaultTransport: DurableMediaTransport = {
  fetch: (url, init) => fetch(url, init),
};

type Env = Partial<Record<string, string | undefined>>;

/**
 * Off by default. Turning it on without ARIES_DURABLE_MEDIA_BUCKET is treated
 * as off rather than as an error, so a half-finished rollout cannot wedge the
 * publish path.
 */
export function isDurableMediaEnabled(env: Env = process.env): boolean {
  const flag = env.ARIES_DURABLE_MEDIA_ENABLED?.trim().toLowerCase();
  if (!flag || !TRUTHY.has(flag)) return false;
  return Boolean(env.ARIES_DURABLE_MEDIA_BUCKET?.trim());
}

export function durableMediaBucket(env: Env = process.env): string | null {
  const bucket = env.ARIES_DURABLE_MEDIA_BUCKET?.trim();
  return bucket ? bucket : null;
}

/** Object prefix inside the bucket. Keeps room for other media classes later. */
function objectPrefix(env: Env = process.env): string {
  const raw = env.ARIES_DURABLE_MEDIA_PREFIX?.trim();
  const prefix = raw && raw.length > 0 ? raw : 'creative';
  return prefix.replace(/^\/+|\/+$/g, '');
}

/**
 * Tenant-scoped object name. Returns null for anything that could escape the
 * prefix — the basename is echoed into a URL path, so this is a containment
 * check, not a formatting nicety.
 */
export function durableObjectName(
  tenantId: number | string,
  basename: string,
  env: Env = process.env,
): string | null {
  const tenant = String(tenantId).trim();
  if (!/^[0-9]+$/.test(tenant) || tenant === '0') return null;
  const name = basename.trim();
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  return `${objectPrefix(env)}/${tenant}/${name}`;
}

/**
 * OAuth token for the VM's attached service account.
 *
 * On GCE this needs no credential file: the metadata server mints a token for
 * whatever service account the instance runs as. Returns null off-GCE or when
 * the metadata server is unreachable, which the callers treat as "durable store
 * unavailable" rather than as a failure.
 */
async function accessToken(
  transport: DurableMediaTransport,
  timeoutMs: number,
): Promise<string | null> {
  const url =
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
  try {
    const res = await withTimeout(
      transport.fetch(url, { headers: { 'Metadata-Flavor': 'Google' } }),
      timeoutMs,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { access_token?: unknown };
    return typeof body.access_token === 'string' && body.access_token ? body.access_token : null;
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('durable_media_timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function timeoutMsFor(env: Env): number {
  const raw = Number(env.ARIES_DURABLE_MEDIA_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
}

export interface DurableMediaOptions {
  env?: Env;
  transport?: DurableMediaTransport;
}

/**
 * Best-effort upload of a durable copy. Returns true only on a confirmed write.
 *
 * Callers MUST NOT let a false here fail their own work: ingestion succeeded
 * locally whether or not the durable copy landed, and a publish weeks later is
 * no worse off than it is today.
 */
export async function putDurableMedia(
  tenantId: number | string,
  basename: string,
  bytes: Buffer | Uint8Array,
  contentType: string,
  options: DurableMediaOptions = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  if (!isDurableMediaEnabled(env)) return false;

  const bucket = durableMediaBucket(env);
  const objectName = durableObjectName(tenantId, basename, env);
  if (!bucket || !objectName) return false;

  const transport = options.transport ?? defaultTransport;
  const timeout = timeoutMsFor(env);

  try {
    const token = await accessToken(transport, timeout);
    if (!token) return false;

    const url =
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o` +
      `?uploadType=media&name=${encodeURIComponent(objectName)}`;

    const res = await withTimeout(
      transport.fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': contentType || 'application/octet-stream',
        },
        body: bytes as unknown as BodyInit,
      }),
      timeout,
    );
    if (!res.ok) {
      console.warn('[durable-media] upload rejected', {
        bucket,
        objectName,
        status: res.status,
      });
      return false;
    }
    return true;
  } catch (error) {
    console.warn('[durable-media] upload failed', {
      bucket,
      objectName,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Best-effort read of the durable copy. Returns null when the store is off, the
 * object is absent, or anything at all goes wrong — the caller then 404s
 * exactly as it does today.
 */
export async function getDurableMedia(
  tenantId: number | string,
  basename: string,
  options: DurableMediaOptions = {},
): Promise<Buffer | null> {
  const env = options.env ?? process.env;
  if (!isDurableMediaEnabled(env)) return null;

  const bucket = durableMediaBucket(env);
  const objectName = durableObjectName(tenantId, basename, env);
  if (!bucket || !objectName) return null;

  const transport = options.transport ?? defaultTransport;
  const timeout = timeoutMsFor(env);

  try {
    const token = await accessToken(transport, timeout);
    if (!token) return null;

    const url =
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/` +
      `${encodeURIComponent(objectName)}?alt=media`;

    const res = await withTimeout(
      transport.fetch(url, { headers: { authorization: `Bearer ${token}` } }),
      timeout,
    );
    if (!res.ok) {
      // 404 is the ordinary "no durable copy" case and is not worth a log line.
      if (res.status !== 404) {
        console.warn('[durable-media] read rejected', {
          bucket,
          objectName,
          status: res.status,
        });
      }
      return null;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.length > 0 ? buffer : null;
  } catch (error) {
    console.warn('[durable-media] read failed', {
      bucket,
      objectName,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
