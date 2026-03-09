import { NextResponse } from 'next/server';
import { startMarketingJob } from '../../../../backend/marketing/jobs-start';

export async function POST(req: Request) {
  let payload: any = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  try {
    const result = await startMarketingJob(payload);
    return NextResponse.json(
      {
        marketing_job_status: result.status,
        jobId: result.jobId,
        tenantId: result.tenantId,
        jobType: result.jobType,
        wiring: result.wiring,
        runtimePath: result.runtimePath
      },
      { status: 202 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
