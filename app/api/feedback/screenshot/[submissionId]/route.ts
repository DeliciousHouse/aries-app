import { NextResponse } from 'next/server';

import { getScreenshot } from '@/lib/feedback/feedback-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Serve a stored feedback screenshot. Public so the triage Sheet's "Screenshot
 * link" resolves for reviewers, and so Composio can fetch the bytes when mirroring
 * the image to Drive. The submission id is an unguessable token (fb_<random>),
 * which gates access without exposing user identity.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ submissionId: string }> },
): Promise<NextResponse | Response> {
  const { submissionId } = await params;

  let shot: { bytes: Buffer; mime: string } | null = null;
  try {
    shot = await getScreenshot(submissionId);
  } catch (error) {
    console.error('[feedback]', {
      event: 'screenshot-read-failed',
      submissionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'screenshot_unavailable' }, { status: 503 });
  }

  if (!shot) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  return new Response(new Uint8Array(shot.bytes), {
    status: 200,
    headers: {
      'content-type': shot.mime,
      'cache-control': 'private, max-age=86400',
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
    },
  });
}
