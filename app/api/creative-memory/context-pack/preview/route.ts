import pool from '@/lib/db';
import { retrieveCreativeContextPack } from '@/backend/creative-memory/retrieval';
import { creativeMemoryErrorResponse, creativeMemoryOk } from '@/backend/creative-memory/errors';
import { parseCreativeMemoryBrief, parseJsonBody } from '@/validators/creative-memory';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
export async function handlePostCreativeMemoryContextPackPreview(req: Request, tenantContextLoader?: TenantContextLoader, db = pool) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) return tenantResult.response;
  try { const body = await parseJsonBody(req); const brief = parseCreativeMemoryBrief(body); return creativeMemoryOk({ contextPack: await retrieveCreativeContextPack(tenantResult.tenantContext, db, brief) }); } catch (error) { return creativeMemoryErrorResponse(error); }
}
export async function POST(req: Request) { return handlePostCreativeMemoryContextPackPreview(req); }
