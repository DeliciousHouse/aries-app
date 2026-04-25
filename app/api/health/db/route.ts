import { NextResponse } from 'next/server';

import pool, { getPoolStats } from '@/lib/db';

const HEALTH_CACHE_TTL_MS = 1_000;

type DbHealthProbe = {
  status: 'ok';
  poolStats: ReturnType<typeof getPoolStats>;
  roundTripMs: number;
  checkedAt: number;
};

let cachedProbe: DbHealthProbe | null = null;
let inFlightProbe: Promise<DbHealthProbe> | null = null;

async function probeDatabaseHealth(): Promise<DbHealthProbe> {
  const startedAt = Date.now();
  await pool.query('SELECT 1');
  return {
    status: 'ok',
    poolStats: getPoolStats(),
    roundTripMs: Date.now() - startedAt,
    checkedAt: Date.now(),
  };
}

async function loadDatabaseHealth(): Promise<{ probe: DbHealthProbe; cached: boolean }> {
  const now = Date.now();
  if (cachedProbe && now - cachedProbe.checkedAt < HEALTH_CACHE_TTL_MS) {
    return { probe: cachedProbe, cached: true };
  }

  if (!inFlightProbe) {
    inFlightProbe = probeDatabaseHealth()
      .then((probe) => {
        cachedProbe = probe;
        return probe;
      })
      .finally(() => {
        inFlightProbe = null;
      });
  }

  return { probe: await inFlightProbe, cached: false };
}

export async function GET() {
  try {
    const { probe, cached } = await loadDatabaseHealth();
    return NextResponse.json({
      status: probe.status,
      poolStats: probe.poolStats,
      roundTripMs: probe.roundTripMs,
      cacheAgeMs: Date.now() - probe.checkedAt,
      cached,
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        poolStats: getPoolStats(),
      },
      { status: 503 },
    );
  }
}
