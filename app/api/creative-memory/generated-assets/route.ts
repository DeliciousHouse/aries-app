import pool from '@/lib/db';
import { createGeneratedAssetCandidates, updateGeneratedAssetReview } from '@/backend/creative-memory/generatedAssets';
import { CreativeMemoryServiceError, creativeMemoryErrorResponse, creativeMemoryOk } from '@/backend/creative-memory/errors';
import { requireCreativeMemoryWriter } from '@/backend/creative-memory/tenant';
import { parseJsonBody } from '@/validators/creative-memory';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

export async function handlePostCreativeMemoryGeneratedAssets(req: Request, tenantContextLoader?: TenantContextLoader, db = pool) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) return tenantResult.response;
  try {
    requireCreativeMemoryWriter(tenantResult.tenantContext);
    const body = await parseJsonBody(req) as Record<string, unknown>;
    const promptRecipeId = String(body.promptRecipeId ?? '').trim();
    const creativeAssetId = typeof body.creativeAssetId === 'string' && body.creativeAssetId.trim() ? body.creativeAssetId.trim() : null;
    if (!promptRecipeId) throw new CreativeMemoryServiceError('invalid_request', 'promptRecipeId is required.', 400);
    const candidates = await createGeneratedAssetCandidates(tenantResult.tenantContext, db, { promptRecipeId, creativeAssetId });
    return creativeMemoryOk({ generatedAssets: candidates }, { status: 201 });
  } catch (error) { return creativeMemoryErrorResponse(error); }
}

export async function handlePatchCreativeMemoryGeneratedAssetReview(req: Request, tenantContextLoader?: TenantContextLoader, db = pool) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) return tenantResult.response;
  try {
    requireCreativeMemoryWriter(tenantResult.tenantContext);
    const body = await parseJsonBody(req) as Record<string, unknown>;
    const generatedAssetId = String(body.generatedAssetId ?? '').trim();
    const reviewStatus = String(body.reviewStatus ?? '').trim();
    if (!generatedAssetId || !['approved','rejected','changes_requested'].includes(reviewStatus)) throw new CreativeMemoryServiceError('invalid_request', 'generatedAssetId and valid reviewStatus are required.', 400);
    const review = await updateGeneratedAssetReview(tenantResult.tenantContext, db, { generatedAssetId, reviewStatus: reviewStatus as 'approved'|'rejected'|'changes_requested', note: typeof body.note === 'string' ? body.note.slice(0, 1000) : undefined });
    if (!review) throw new CreativeMemoryServiceError('generated_asset_not_found', 'Generated asset candidate was not found.', 404);
    return creativeMemoryOk({ review });
  } catch (error) { return creativeMemoryErrorResponse(error); }
}

export async function POST(req: Request) { return handlePostCreativeMemoryGeneratedAssets(req); }
export async function PATCH(req: Request) { return handlePatchCreativeMemoryGeneratedAssetReview(req); }
