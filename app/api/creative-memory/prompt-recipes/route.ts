import pool from '@/lib/db';
import { savePromptRecipe } from '@/backend/creative-memory/promptCompiler';
import { creativeMemoryErrorResponse, creativeMemoryOk } from '@/backend/creative-memory/errors';
import { parseCreativeMemoryBrief, parseJsonBody } from '@/validators/creative-memory';
import { requireCreativeMemoryWriter } from '@/backend/creative-memory/tenant';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
export async function handlePostCreativeMemoryPromptRecipe(req: Request, tenantContextLoader?: TenantContextLoader, db = pool) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) return tenantResult.response;
  try { requireCreativeMemoryWriter(tenantResult.tenantContext); const body = await parseJsonBody(req); const brief = parseCreativeMemoryBrief(body); return creativeMemoryOk({ promptRecipe: await savePromptRecipe(tenantResult.tenantContext, db, brief) }, { status: 201 }); } catch (error) { return creativeMemoryErrorResponse(error); }
}
export async function POST(req: Request) { return handlePostCreativeMemoryPromptRecipe(req); }
