import pool from '@/lib/db';
import { listCreativeAssets } from '@/backend/creative-memory/assets';
import { creativeMemoryErrorResponse, creativeMemoryOk } from '@/backend/creative-memory/errors';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
export async function handleGetCreativeMemoryAssets(tenantContextLoader?: TenantContextLoader, db = pool) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) return tenantResult.response;
  try { return creativeMemoryOk({ assets: await listCreativeAssets(tenantResult.tenantContext, db) }); } catch (error) { return creativeMemoryErrorResponse(error); }
}
export async function GET() { return handleGetCreativeMemoryAssets(); }
