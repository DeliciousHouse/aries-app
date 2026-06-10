import { Pool, PoolClient } from 'pg';

import { parsePoolMax } from './db-pool-config';

const DEFAULT_DB_PORT = 5432;
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

export { parsePoolMax } from './db-pool-config';

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
