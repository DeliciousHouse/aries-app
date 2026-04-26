import pool from '@/lib/db';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import { creativeMemoryErrorResponse, creativeMemoryOk } from '@/backend/creative-memory/errors';
import { loadProfileContext } from '@/backend/creative-memory/profileContext';

export async function handleGetCreativeMemoryHome(tenantContextLoader?: TenantContextLoader, db = pool) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) return tenantResult.response;
  try {
    const profile = await loadProfileContext(tenantResult.tenantContext, db);
    return creativeMemoryOk({ product: 'Campaign Learning', namespace: 'creative-memory', profile, routes: ['/api/creative-memory/assets','/api/creative-memory/style-cards','/api/creative-memory/context-pack/preview','/api/creative-memory/prompt-recipes/preview','/api/creative-memory/generated-assets','/api/creative-memory/outcome-labels'] });
  } catch (error) { return creativeMemoryErrorResponse(error); }
}
export async function GET() { return handleGetCreativeMemoryHome(); }
