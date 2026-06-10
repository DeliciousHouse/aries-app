import { Pool, PoolClient } from 'pg';

const DEFAULT_DB_PORT = 5432;
const DEFAULT_POOL_MAX = 20;
// Explicit DB_POOL_MAX values are honored as written down to 1 — sidecar
// workers run single-tick loops and genuinely need tiny pools (compose sets 3).
// A floor above 1 silently inflates every sidecar's pool and breaks the
// connection-budget math in DOCKER.md (guardrail #1).
const MIN_POOL_MAX = 1;
const MAX_POOL_MAX = 200;
const IDLE_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 5_000;

type PoolStats = {
  total: number;
  idle: number;
  waiting: number;
};

type GlobalWithPgPool = typeof globalThis & {
  __ariesPgPool?: Pool;
};

function parseDbPort(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_DB_PORT;
}

export function parsePoolMax(raw: string | undefined): number {
  if (!raw) {
    return DEFAULT_POOL_MAX;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_POOL_MAX) {
    console.warn(
      `[db-pool] invalid DB_POOL_MAX ${JSON.stringify(raw)}; using default ${DEFAULT_POOL_MAX}`
    );
    return DEFAULT_POOL_MAX;
  }

  return Math.min(MAX_POOL_MAX, parsed);
}

function createPool(): Pool {
  const instance = new Pool({
    host: process.env.DB_HOST,
    port: parseDbPort(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    max: parsePoolMax(process.env.DB_POOL_MAX),
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    application_name: `aries-app:${process.env.APP_INSTANCE_ID ?? 'default'}`,
  });

  instance.on('error', (error) => {
    console.error('[db-pool] idle client error', error);
  });

  return instance;
}

const globalWithPgPool = globalThis as GlobalWithPgPool;

export const pool: Pool = globalWithPgPool.__ariesPgPool ?? createPool();

if (!globalWithPgPool.__ariesPgPool) {
  globalWithPgPool.__ariesPgPool = pool;
}

export type { PoolClient };

export function getPoolStats(): PoolStats {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}

export default pool;
