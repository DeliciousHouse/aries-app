// Pool-size parsing shared by lib/db.ts (the app/shared pool, default 20) and
// the sidecar workers' dedicated pools (default 3). Deliberately free of any
// `pg` import: lib/db.ts instantiates the shared app pool at module load, so
// workers that must keep a dedicated small pool import THIS module, not lib/db.
//
// Explicit values are honored as written from 1 up to the cap of 200 — sidecar
// workers run single-tick loops and genuinely need tiny pools (docker-compose
// sets 3), and a floor above 1 silently inflates any shared-pool consumer
// configured below it (the insights-sync worker's 3 became 5 under the old
// MIN_POOL_MAX=5 floor, breaking the connection-budget math in DOCKER.md).
//
// Parsing is strict (integers only): Number.parseInt would silently turn
// '1e2' into 1 and '3garbage' into 3, under-provisioning a production pool
// from a malformed env var. Anything that is not a plain positive integer
// falls back to the caller's default with a warning. Note this means an
// explicit DB_POOL_MAX=1 on the web app IS honored — one slow query can then
// monopolize a worker's only connection, so keep the app value at 10+.

export const DEFAULT_POOL_MAX = 20;
export const WORKER_POOL_MAX = 3;
export const MIN_POOL_MAX = 1;
export const MAX_POOL_MAX = 200;

export function parsePoolMax(
  raw: string | undefined,
  fallback: number = DEFAULT_POOL_MAX
): number {
  if (!raw) {
    return fallback;
  }

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || Number.parseInt(trimmed, 10) < MIN_POOL_MAX) {
    console.warn(
      `[db-pool] invalid DB_POOL_MAX ${JSON.stringify(raw)}; using default ${fallback}`
    );
    return fallback;
  }

  return Math.min(MAX_POOL_MAX, Number.parseInt(trimmed, 10));
}
