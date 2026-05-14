import { NextResponse } from 'next/server';

import { probeHermesSocialContentRuntime } from '../../../../backend/marketing/hermes-runtime-contract';

export async function GET() {
  const report = await probeHermesSocialContentRuntime(process.env);
  return NextResponse.json(report, { status: report.ok ? 200 : 503 });
}
