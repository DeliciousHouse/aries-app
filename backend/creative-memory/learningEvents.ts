import type { CreativeLearningLabel } from '@/types/creative-memory';
import { CreativeMemoryServiceError } from './errors';
import type { QueryClient } from './profileContext';
import { requireNumericTenantId, type TenantContext } from './tenant';

export async function saveCampaignLearningLabel(ctx: TenantContext, db: QueryClient, input: { idempotencyKey: string; label: CreativeLearningLabel | string; promptRecipeId?: string; generatedAssetId?: string; note?: string; source?: string }) {
  const tenantId = requireNumericTenantId(ctx);
  if (!input.promptRecipeId && !input.generatedAssetId) throw new CreativeMemoryServiceError('invalid_request', 'Outcome labels must reference a prompt recipe or generated asset.', 400);
  const r = await db.query<{ id: string; label: string; source: string; note: string | null }>(
    `INSERT INTO campaign_learning_labels (tenant_id, idempotency_key, label, prompt_recipe_id, generated_asset_id, note, source, confidence_basis)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING id, label, source, note`,
    [tenantId, input.idempotencyKey, input.label, input.promptRecipeId ?? null, input.generatedAssetId ?? null, input.note ?? null, input.source ?? 'operator', 'manual_label']
  );
  if (r.rows[0]) return { id: String(r.rows[0].id), label: r.rows[0].label, source: r.rows[0].source, note: r.rows[0].note, confidenceBasis: 'manual_label', performanceScored: false, idempotentReplay: false };
  const existing = await db.query<{ id: string; label: string; source: string; note: string | null; prompt_recipe_id: string | null; generated_asset_id: string | null }>('SELECT id, label, source, note, prompt_recipe_id, generated_asset_id FROM campaign_learning_labels WHERE tenant_id=$1 AND idempotency_key=$2', [tenantId, input.idempotencyKey]);
  const row = existing.rows[0];
  if (!row) throw new CreativeMemoryServiceError('db_error', 'Creative Memory label idempotency lookup failed.', 500);
  if (row.label !== input.label || String(row.prompt_recipe_id ?? '') !== String(input.promptRecipeId ?? '') || String(row.generated_asset_id ?? '') !== String(input.generatedAssetId ?? '') || String(row.source ?? '') !== String(input.source ?? 'operator') || String(row.note ?? '') !== String(input.note ?? '')) throw new CreativeMemoryServiceError('invalid_request', 'idempotencyKey already belongs to a different outcome label or target.', 409);
  return { id: String(row.id), label: row.label, source: row.source, note: row.note, confidenceBasis: 'manual_label', performanceScored: false, idempotentReplay: true };
}
