import { NextResponse } from 'next/server';

import { ensureResearchJobSchema, listQueuedResearchFindingsForTenant } from '@/backend/memory/research-jobs';
import pool from '@/lib/db';
import { getTenantContext } from '@/lib/tenant-context';

export async function GET(req: Request) {
  let tenantContext;
  try {
    tenantContext = await getTenantContext();
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Authentication required.' },
      { status: 403 },
    );
  }

  if (tenantContext.role !== 'tenant_admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const url = new URL(req.url);
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

  const client = await pool.connect();
  try {
    await ensureResearchJobSchema(client);
    const items = await listQueuedResearchFindingsForTenant(tenantContext.tenantId, { limit }, client);
    return NextResponse.json({ items });
  } finally {
    client.release();
  }
}
