import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json(
    {
      status: 'error',
      reason: 'deprecated_internal_route',
      message: 'Marketing runtime artifacts are now created directly by the Aries marketing orchestrator.',
    },
    { status: 410 }
  );
}
