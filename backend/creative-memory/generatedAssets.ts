import type { CreativeContextPack } from '@/types/creative-memory';
import { CreativeMemoryServiceError } from './errors';
import type { QueryClient } from './profileContext';
import { requireNumericTenantId, type TenantContext } from './tenant';

export type GeneratedVariantKind = 'baseline' | 'memory_assisted';
export type GeneratedAssetCandidate = { id: string; variantKind: GeneratedVariantKind; learningLifecycle: string; reviewStatus: string; promptText: string; creativeAssetId?: string | null };

type StoredPromptRecipe = {
  compiled_prompt: string;
  context_pack: CreativeContextPack & { promptProvenance?: { baselinePrompt?: string; compiledPrompt?: string; canGenerate?: boolean } };
};

type TxCapableClient = QueryClient & { connect?: () => Promise<QueryClient & { release: () => void }> };

function requireNonEmptyPrompt(value: unknown, label: string): string {
  const prompt = String(value ?? '').trim();
  if (!prompt) throw new CreativeMemoryServiceError('invalid_request', `${label} is missing from the saved prompt recipe. Recompile the recipe before generating candidates.`, 409);
  return prompt;
}

async function loadReadyPromptRecipe(db: QueryClient, tenantId: number, promptRecipeId: string): Promise<{ baselinePrompt: string; memoryPrompt: string }> {
  const recipe = await db.query<StoredPromptRecipe>('SELECT compiled_prompt, context_pack FROM prompt_recipes WHERE tenant_id=$1 AND id=$2', [tenantId, promptRecipeId]);
  const row = recipe.rows[0];
  if (!row) throw new CreativeMemoryServiceError('prompt_recipe_not_found', 'Prompt recipe was not found.', 404);
  if (row.context_pack?.status !== 'ready' || row.context_pack?.promptProvenance?.canGenerate === false) {
    throw new CreativeMemoryServiceError('prompt_recipe_not_ready', 'Prompt recipe is not ready for generation. Add approved owned/generated memory before creating candidates.', 409, { contextStatus: row.context_pack?.status ?? 'unknown' });
  }
  return {
    baselinePrompt: requireNonEmptyPrompt(row.context_pack?.promptProvenance?.baselinePrompt, 'Baseline prompt'),
    memoryPrompt: requireNonEmptyPrompt(row.context_pack?.promptProvenance?.compiledPrompt ?? row.compiled_prompt, 'Memory-assisted prompt'),
  };
}

async function assertGeneratedCreativeAssetLink(db: QueryClient, tenantId: number, creativeAssetId: string): Promise<void> {
  const r = await db.query<{ id: string; source_type: string; permission_scope: string }>(
    `SELECT id, source_type, permission_scope FROM creative_assets WHERE tenant_id=$1 AND id=$2`,
    [tenantId, creativeAssetId]
  );
  const asset = r.rows[0];
  if (!asset) throw new CreativeMemoryServiceError('creative_asset_not_found', 'Linked generated creative asset was not found.', 404);
  if (asset.source_type !== 'generated_by_aries' || asset.permission_scope !== 'generated') {
    throw new CreativeMemoryServiceError('invalid_generated_asset_link', 'Only Aries-generated creative assets can be attached to generated candidates for approval.', 409);
  }
}

export async function createGeneratedAssetCandidates(ctx: TenantContext, db: QueryClient, input: { promptRecipeId: string; baselinePrompt?: string; memoryPrompt?: string; creativeAssetId?: string | null; variants?: GeneratedVariantKind[] }): Promise<GeneratedAssetCandidate[]> {
  const tenantId = requireNumericTenantId(ctx);
  const stored = await loadReadyPromptRecipe(db, tenantId, input.promptRecipeId);
  if (input.creativeAssetId) await assertGeneratedCreativeAssetLink(db, tenantId, input.creativeAssetId);
  const allVariants: Array<{ variantKind: GeneratedVariantKind; promptText: string }> = [
    { variantKind: 'baseline', promptText: stored.baselinePrompt },
    { variantKind: 'memory_assisted', promptText: stored.memoryPrompt },
  ];
  const variants = input.variants ? allVariants.filter((variant) => input.variants?.includes(variant.variantKind)) : allVariants;
  const created: GeneratedAssetCandidate[] = [];
  for (const variant of variants) {
    const r = await db.query<{ id: string; review_status: string; learning_lifecycle: string; prompt_text: string; variant_kind: GeneratedVariantKind; creative_asset_id?: string | null }>(
      `INSERT INTO generated_assets (tenant_id, prompt_recipe_id, creative_asset_id, variant_kind, prompt_text, learning_lifecycle, review_status, review_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, variant_kind, creative_asset_id, prompt_text, learning_lifecycle, review_status`,
      [tenantId, input.promptRecipeId, input.creativeAssetId ?? null, variant.variantKind, variant.promptText, 'suggested', 'pending', { source: 'creative_memory_operator_ui', note: 'Prompt candidate queued for image generation handoff.' }]
    );
    const row = r.rows[0];
    created.push({ id: String(row.id), variantKind: row.variant_kind ?? variant.variantKind, creativeAssetId: row.creative_asset_id ? String(row.creative_asset_id) : null, promptText: String(row.prompt_text ?? variant.promptText), learningLifecycle: String(row.learning_lifecycle ?? 'suggested'), reviewStatus: String(row.review_status ?? 'pending') });
  }
  return created;
}

async function updateGeneratedAssetReviewWithClient(tenantId: number, db: QueryClient, input: { generatedAssetId: string; reviewStatus: 'approved'|'rejected'|'changes_requested'; note?: string }) {
  const existing = await db.query<{ id: string; creative_asset_id: string | null }>('SELECT id, creative_asset_id FROM generated_assets WHERE tenant_id=$1 AND id=$2', [tenantId, input.generatedAssetId]);
  const current = existing.rows[0];
  if (!current) return null;
  if (input.reviewStatus === 'approved') {
    if (!current.creative_asset_id) throw new CreativeMemoryServiceError('generated_asset_not_materialized', 'Approve requires a generated creative asset link. Keep this candidate pending until image generation handoff returns a creativeAssetId.', 409);
    await assertGeneratedCreativeAssetLink(db, tenantId, current.creative_asset_id);
  }
  const lifecycle = input.reviewStatus === 'approved' ? 'approved_for_generation' : input.reviewStatus === 'rejected' ? 'archived' : 'suggested';
  const r = await db.query<{ id: string; review_status: string; learning_lifecycle: string; creative_asset_id: string | null }>(
    `UPDATE generated_assets
       SET review_status=$3, learning_lifecycle=$4, review_notes = jsonb_build_object('note', $5::text, 'reviewedAt', now())
     WHERE tenant_id=$1 AND id=$2
     RETURNING id, review_status, learning_lifecycle, creative_asset_id`,
    [tenantId, input.generatedAssetId, input.reviewStatus, lifecycle, input.note ?? '']
  );
  const row = r.rows[0];
  if (row?.creative_asset_id && input.reviewStatus === 'approved') {
    await db.query(`UPDATE creative_assets SET usable_for_generation=TRUE, learning_lifecycle='approved_for_generation', updated_at=now() WHERE tenant_id=$1 AND id=$2 AND source_type='generated_by_aries' AND permission_scope='generated'`, [tenantId, row.creative_asset_id]);
  }
  return row ? { id: String(row.id), reviewStatus: String(row.review_status), learningLifecycle: String(row.learning_lifecycle), creativeAssetId: row.creative_asset_id ? String(row.creative_asset_id) : null } : null;
}

export async function updateGeneratedAssetReview(ctx: TenantContext, db: TxCapableClient, input: { generatedAssetId: string; reviewStatus: 'approved'|'rejected'|'changes_requested'; note?: string }) {
  const tenantId = requireNumericTenantId(ctx);
  if (input.reviewStatus !== 'approved' || typeof db.connect !== 'function') return updateGeneratedAssetReviewWithClient(tenantId, db, input);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await updateGeneratedAssetReviewWithClient(tenantId, client, input);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createGeneratedAssetCandidate(ctx: TenantContext, db: QueryClient, input: { promptRecipeId: string; creativeAssetId?: string | null; promptText?: string; variantKind?: GeneratedVariantKind }) {
  const candidates = await createGeneratedAssetCandidates(ctx, db, { promptRecipeId: input.promptRecipeId, creativeAssetId: input.creativeAssetId ?? null, variants: [input.variantKind ?? 'memory_assisted'] });
  return candidates[0];
}
