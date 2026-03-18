import pool from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';
import { deleteTenantUserProfile, getTenantUserProfileById, updateTenantUserProfile } from '@/backend/tenant/user-profiles';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function parseUserId(raw: string): string | null {
  return /^[1-9]\d*$/.test(raw) ? raw : null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ userId: string }> }) {
  const { userId: rawUserId } = await params;
  const userId = parseUserId(rawUserId);
  if (!userId) {
    return json({ error: 'invalid_user_id' }, 400);
  }

  let tenantContext;
  try {
    tenantContext = await getTenantContext();
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Authentication required.' }, 403);
  }

  const client = await pool.connect();
  try {
    const result = await getTenantUserProfileById(client, { tenantId: tenantContext.tenantId, userId });
    if (result.status === 'ok') {
      return json({ profile: result.profile });
    }

    return json({ error: result.status }, result.status === 'tenant_mismatch' ? 403 : 404);
  } finally {
    client.release();
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ userId: string }> }) {
  const { userId: rawUserId } = await params;
  const userId = parseUserId(rawUserId);
  if (!userId) {
    return json({ error: 'invalid_user_id' }, 400);
  }

  let tenantContext;
  try {
    tenantContext = await getTenantContext();
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Authentication required.' }, 403);
  }

  if (tenantContext.role !== 'tenant_admin') {
    return json({ error: 'forbidden' }, 403);
  }

  let payload: { fullName?: string | null; role?: 'tenant_admin' | 'tenant_analyst' | 'tenant_viewer' } = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  const client = await pool.connect();
  try {
    const result = await updateTenantUserProfile(client, {
      tenantId: tenantContext.tenantId,
      userId,
      fullName: payload.fullName,
      role: payload.role,
    });

    if (result.status === 'ok') {
      return json({ profile: result.profile });
    }

    return json({ error: result.status }, result.status === 'tenant_mismatch' ? 403 : 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'invalid_role') {
      return json({ error: message }, 400);
    }

    return json({ error: message }, 500);
  } finally {
    client.release();
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ userId: string }> }) {
  const { userId: rawUserId } = await params;
  const userId = parseUserId(rawUserId);
  if (!userId) {
    return json({ error: 'invalid_user_id' }, 400);
  }

  let tenantContext;
  try {
    tenantContext = await getTenantContext();
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Authentication required.' }, 403);
  }

  if (tenantContext.role !== 'tenant_admin') {
    return json({ error: 'forbidden' }, 403);
  }

  const client = await pool.connect();
  try {
    const result = await deleteTenantUserProfile(client, { tenantId: tenantContext.tenantId, userId });
    if (result.status === 'deleted') {
      return json({ status: 'deleted' });
    }

    return json({ error: result.status }, result.status === 'tenant_mismatch' ? 403 : 404);
  } finally {
    client.release();
  }
}
