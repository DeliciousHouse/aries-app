import { resolvePublicMarketingArtifact } from '@/backend/marketing/public-pages';

export const dynamic = 'force-dynamic';

function responseForPath(pathname: string, headOnly = false): Response {
  const artifact = resolvePublicMarketingArtifact(pathname);
  if (!artifact) {
    return new Response(null, {
      status: 302,
      headers: {
        location: '/_not-found',
        'cache-control': 'no-store',
      },
    });
  }

  return new Response(headOnly ? null : artifact.body, {
    status: 200,
    headers: {
      'content-type': artifact.contentType,
      'cache-control': artifact.cacheControl,
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  return responseForPath(new URL(request.url).pathname);
}

export async function HEAD(request: Request): Promise<Response> {
  return responseForPath(new URL(request.url).pathname, true);
}
