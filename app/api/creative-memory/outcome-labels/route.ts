import pool from '@/lib/db';
import { saveCampaignLearningLabel } from '@/backend/creative-memory/learningEvents';
import { CreativeMemoryServiceError, creativeMemoryErrorResponse, creativeMemoryOk } from '@/backend/creative-memory/errors';
import { requireCreativeMemoryWriter } from '@/backend/creative-memory/tenant';
import { creativeLearningLabels } from '@/types/creative-memory';
import { parseJsonBody } from '@/validators/creative-memory';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
export async function handlePostCreativeMemoryOutcomeLabel(req: Request, tenantContextLoader?: TenantContextLoader, db = pool) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) return tenantResult.response;
  try {
    requireCreativeMemoryWriter(tenantResult.tenantContext);
    const body = await parseJsonBody(req) as Record<string, unknown>;
    const label = String(body.label ?? '');
    if (!(creativeLearningLabels as readonly string[]).includes(label)) return creativeMemoryErrorResponse(new CreativeMemoryServiceError('invalid_request', `Unsupported Creative Memory outcome label: ${label}`, 400));
    const idempotencyKey = String(body.idempotencyKey ?? '').trim();
    if (!idempotencyKey) return creativeMemoryErrorResponse(new CreativeMemoryServiceError('invalid_request', 'idempotencyKey is required', 400));
    const promptRecipeId = typeof body.promptRecipeId === 'string' && body.promptRecipeId.trim() ? body.promptRecipeId : undefined;
    const generatedAssetId = typeof body.generatedAssetId === 'string' && body.generatedAssetId.trim() ? body.generatedAssetId : undefined;
    const result = await saveCampaignLearningLabel(tenantResult.tenantContext, db, { idempotencyKey, label, promptRecipeId, generatedAssetId, note: typeof body.note === 'string' ? body.note.slice(0, 1000) : undefined, source: typeof body.source === 'string' ? body.source.slice(0, 120) : 'operator' });
    return creativeMemoryOk({ label: result }, { status: result.idempotentReplay ? 200 : 201 });
  } catch (error) { return creativeMemoryErrorResponse(error); }
}
export async function POST(req: Request) { return handlePostCreativeMemoryOutcomeLabel(req); }
