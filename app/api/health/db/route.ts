import { NextResponse } from 'next/server';

import pool, { getPoolStats } from '@/lib/db';

export async function GET() {
  const startedAt = Date.now();

  try {
    await pool.query('SELECT 1');

    return NextResponse.json({
      status: 'ok',
      poolStats: getPoolStats(),
      roundTripMs: Date.now() - startedAt,
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
