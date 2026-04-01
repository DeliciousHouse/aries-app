import { loadTenantContextOrResponse } from '@/lib/tenant-context-http';
import { getDecryptedAccessTokenForTenantProvider, getLinkedInPersonUrnForTenant } from '@/backend/integrations/oauth-credentials';
import { linkedInListRecentShares } from '@/backend/integrations/linkedin-api';

export async function GET(req: Request) {
  const tenantResult = await loadTenantContextOrResponse();
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  const tenantId = tenantResult.tenantContext.tenantId;
  const url = new URL(req.url);
  const count = Math.min(Math.max(Number.parseInt(url.searchParams.get('count') || '10', 10) || 10, 1), 50);

  const creds = await getDecryptedAccessTokenForTenantProvider(tenantId, 'linkedin');
  if (!creds) {
    return Response.json(
      { status: 'error', reason: 'linkedin_not_connected', message: 'Connect LinkedIn in Settings (OAuth) first.' },
      { status: 400 }
    );
  }

  const personUrn = await getLinkedInPersonUrnForTenant(tenantId);
  if (!personUrn) {
    return Response.json({ status: 'error', reason: 'linkedin_profile_missing' }, { status: 400 });
  }

  try {
    const shares = await linkedInListRecentShares({
      accessToken: creds.accessToken,
      personUrn,
      count,
    });
    return Response.json({ status: 'ok', shares }, { status: 200 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ status: 'error', reason: 'linkedin_api_error', message }, { status: 502 });
  }
}
