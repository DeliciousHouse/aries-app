import pool from '@/lib/db';
import { listStyleCards } from '@/backend/creative-memory/styleCards';
import { creativeMemoryErrorResponse, creativeMemoryOk } from '@/backend/creative-memory/errors';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
export async function handleGetCreativeMemoryStyleCards(tenantContextLoader?: TenantContextLoader, db = pool) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) return tenantResult.response;
  try { return creativeMemoryOk({ styleCards: await listStyleCards(tenantResult.tenantContext, db) }); } catch (error) { return creativeMemoryErrorResponse(error); }
}
export async function GET() { return handleGetCreativeMemoryStyleCards(); }
