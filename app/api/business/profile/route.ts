import pool from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';
import { getBusinessProfile, updateBusinessProfile } from '@/backend/tenant/business-profile';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function GET() {
  let tenantContext;
  try {
    tenantContext = await getTenantContext();
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Authentication required.' }, 403);
  }

  const client = await pool.connect();
  try {
    const profile = await getBusinessProfile(client, tenantContext.tenantId);
    return json({ profile });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, message === 'tenant_not_found' ? 404 : 500);
  } finally {
    client.release();
  }
}

export async function PATCH(req: Request) {
  let tenantContext;
  try {
    tenantContext = await getTenantContext();
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Authentication required.' }, 403);
  }

  if (tenantContext.role !== 'tenant_admin') {
    return json({ error: 'forbidden' }, 403);
  }

  let payload: {
    businessName?: string | null;
    websiteUrl?: string | null;
    businessType?: string | null;
    primaryGoal?: string | null;
    launchApproverUserId?: string | null;
  } = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  const client = await pool.connect();
  try {
    const profile = await updateBusinessProfile(client, {
      tenantId: tenantContext.tenantId,
      businessName: payload.businessName,
      websiteUrl: payload.websiteUrl,
      businessType: payload.businessType,
      primaryGoal: payload.primaryGoal,
      launchApproverUserId: payload.launchApproverUserId,
    });
    return json({ profile });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, message.startsWith('missing_required_fields:') ? 400 : 500);
  } finally {
    client.release();
  }
}
