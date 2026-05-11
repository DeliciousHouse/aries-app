import {
  handleGetCreativeVoicePreference,
  handlePutCreativeVoicePreference,
} from '@/app/api/social-content/jobs/[jobId]/creative-voice-preference/handler';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  return handleGetCreativeVoicePreference(jobId);
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  return handlePutCreativeVoicePreference(jobId, req);
}
