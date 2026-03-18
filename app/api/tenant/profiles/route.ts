import pool from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';
import { createTenantUserProfile, listTenantUserProfiles } from '@/backend/tenant/user-profiles';

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
    const profiles = await listTenantUserProfiles(client, tenantContext.tenantId);
    return json({ profiles });
  } finally {
    client.release();
  }
}

export async function POST(req: Request) {
  let tenantContext;
  try {
    tenantContext = await getTenantContext();
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Authentication required.' }, 403);
  }

  if (tenantContext.role !== 'tenant_admin') {
    return json({ error: 'forbidden' }, 403);
  }

  let payload: { email?: string; fullName?: string | null; role?: 'tenant_admin' | 'tenant_analyst' | 'tenant_viewer' } = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  const client = await pool.connect();
  try {
    const profile = await createTenantUserProfile(client, {
      tenantId: tenantContext.tenantId,
      email: payload.email ?? '',
      fullName: payload.fullName,
      role: payload.role,
    });
    return json({ profile }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('missing_required_fields:') || message === 'invalid_role') {
      return json({ error: message }, 400);
    }

    return json({ error: message }, 500);
  } finally {
    client.release();
  }
}
