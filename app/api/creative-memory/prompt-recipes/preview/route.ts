import pool from '@/lib/db';
import { compilePromptPreview } from '@/backend/creative-memory/promptCompiler';
import { creativeMemoryErrorResponse, creativeMemoryOk } from '@/backend/creative-memory/errors';
import { parseCreativeMemoryBrief, parseJsonBody } from '@/validators/creative-memory';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
export async function handlePostCreativeMemoryPromptRecipePreview(req: Request, tenantContextLoader?: TenantContextLoader, db = pool) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) return tenantResult.response;
  try { const body = await parseJsonBody(req); const brief = parseCreativeMemoryBrief(body); return creativeMemoryOk({ promptRecipe: await compilePromptPreview(tenantResult.tenantContext, db, brief) }); } catch (error) { return creativeMemoryErrorResponse(error); }
}
export async function POST(req: Request) { return handlePostCreativeMemoryPromptRecipePreview(req); }
