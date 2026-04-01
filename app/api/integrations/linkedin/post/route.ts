import { loadTenantContextOrResponse } from '@/lib/tenant-context-http';
import { getDecryptedAccessTokenForTenantProvider, getLinkedInPersonUrnForTenant } from '@/backend/integrations/oauth-credentials';
import { linkedInPublishTextPost } from '@/backend/integrations/linkedin-api';

export async function POST(req: Request) {
  const tenantResult = await loadTenantContextOrResponse();
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  const tenantId = tenantResult.tenantContext.tenantId;
  let body: { text?: string };
  try {
    body = (await req.json()) as { text?: string };
  } catch {
    body = {};
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text.length === 0) {
    return Response.json({ status: 'error', reason: 'validation_failed', message: 'text is required' }, { status: 400 });
  }
  if (text.length > 3000) {
    return Response.json({ status: 'error', reason: 'validation_failed', message: 'text too long' }, { status: 400 });
  }

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
    const result = await linkedInPublishTextPost({
      accessToken: creds.accessToken,
      personUrn,
      text,
    });
    return Response.json({ status: 'ok', result }, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ status: 'error', reason: 'linkedin_api_error', message }, { status: 502 });
  }
}
