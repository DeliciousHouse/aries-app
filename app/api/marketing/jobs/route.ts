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
        runtimeArtifactPath: result.runtimeArtifactPath,
        runtimePath: result.runtimeArtifactPath,
        runtimePathDeprecated: true
      },
      { status: 202 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('missing_required_fields:')) {
      return NextResponse.json({ error: message }, { status: 400 });
    }

    return NextResponse.json(
      {
        error: message
      },
      { status: 500 }
    );
  }
}
