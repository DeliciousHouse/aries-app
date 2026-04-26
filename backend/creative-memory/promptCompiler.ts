import type { CreativeMemoryBrief, CreativeContextPack, PromptRecipePreview } from '@/types/creative-memory';
import { assertExactImageTextRequired, validatePromptContextBudget } from '@/validators/creative-memory';
import { assertFrontendSafeResponse, CreativeMemoryServiceError } from './errors';
import type { QueryClient } from './profileContext';
import { retrieveCreativeContextPack } from './retrieval';
import { requireNumericTenantId, type TenantContext } from './tenant';

function lines(label: string, values: string[]) { return values.length ? `${label}:\n${values.map((v) => `- ${v}`).join('\n')}` : ''; }

type TxClient = QueryClient & { release?: () => void };
type TransactionalDb = QueryClient & { connect?: () => Promise<TxClient> };

function generationBlocker(contextPack: CreativeContextPack): string | undefined {
  if (contextPack.status === 'ready') return undefined;
  if (contextPack.status === 'competitor_only') return 'Creative Memory only has abstract competitor market notes. Add approved owned/generated examples before generating memory-assisted assets.';
  return 'Creative Memory does not have enough approved owned/generated examples yet.';
}

export async function compilePromptPreview(ctx: TenantContext, db: QueryClient, brief: CreativeMemoryBrief): Promise<PromptRecipePreview> {
  assertExactImageTextRequired(brief);
  const contextPack = await retrieveCreativeContextPack(ctx, db, brief);
  validatePromptContextBudget({ tokenEstimate: contextPack.tokenEstimate, maxTokens: contextPack.maxTokens });
  const exactText = brief.imageText.map((t, i) => `Line ${i + 1}: "${t}"`).join('\n');
  const baselinePrompt = [`Generate a ${brief.aspectRatio} ${brief.platform} ${brief.placement} creative.`, `Objective: ${brief.objective}.`, `Offer: ${brief.offer}.`, `Audience: ${brief.audience}.`, contextPack.brandSummary, `The ONLY text on the image should be exactly:\n${exactText}`].join('\n\n');
  const memoryGuidance = contextPack.status === 'ready'
    ? [...contextPack.selectedStyleCards.map((c) => c.promptGuidance), ...contextPack.selectedExamples.map((e) => `${e.selectionReason} (${e.sourceType})`)].filter(Boolean)
    : [];
  const negativePrompt = ['NO competitor logos or names', 'NO direct competitor visual imitation', 'NO extra text', 'NO watermarks', ...(brief.mustAvoidAesthetics ?? []), ...contextPack.selectedStyleCards.map((c) => c.negativeGuidance).filter(Boolean)].join('. ');
  const blocker = generationBlocker(contextPack);
  const compiledPrompt = [baselinePrompt, blocker ? `Memory-assisted generation blocked: ${blocker}` : '', lines('Memory-assisted guidance', memoryGuidance), lines('Selected evidence', contextPack.selectedExamples.map((e) => `${e.selectionReason} (${e.sourceType})`)), `Avoid: ${negativePrompt}`].filter(Boolean).join('\n\n');
  return assertFrontendSafeResponse({ canGenerate: !blocker, blockingReason: blocker, baselinePrompt, compiledPrompt, negativePrompt, contextPack, tokenEstimate: contextPack.tokenEstimate, selectionReasons: [...contextPack.selectedStyleCards.map((s) => s.selectionReason), ...contextPack.selectedExamples.map((e) => e.selectionReason), ...contextPack.marketPatternNotes.map((n) => n.selectionReason ?? '')].filter(Boolean), excludedCandidateCount: contextPack.excludedCandidates.length, provenance: { ...contextPack.provenance, sideEffectFree: true } });
}

async function withTransaction<T>(db: TransactionalDb, fn: (client: QueryClient) => Promise<T>): Promise<T> {
  if (!db.connect) return fn(db);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release?.();
  }
}

export async function savePromptRecipe(ctx: TenantContext, db: TransactionalDb, brief: CreativeMemoryBrief): Promise<{ id: string; preview: PromptRecipePreview }> {
  const tenantId = requireNumericTenantId(ctx);
  const preview = await compilePromptPreview(ctx, db, brief);
  if (!preview.canGenerate || preview.contextPack.status !== 'ready') {
    throw new CreativeMemoryServiceError('prompt_recipe_not_ready', preview.blockingReason ?? 'Creative Memory context pack is not ready for generation.', 409, { contextStatus: preview.contextPack.status });
  }
  return withTransaction(db, async (client) => {
    const persistedContextPack = { ...preview.contextPack, promptProvenance: { baselinePrompt: preview.baselinePrompt, compiledPrompt: preview.compiledPrompt, negativePrompt: preview.negativePrompt, canGenerate: preview.canGenerate, createdBy: 'creative-memory-v1' } };
    const result = await client.query<{ id: string }>('INSERT INTO prompt_recipes (tenant_id, brief, context_pack, compiled_prompt, negative_prompt, model_used) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [tenantId, brief, persistedContextPack, preview.compiledPrompt, preview.negativePrompt, 'creative-memory-v1']);
    const id = String(result.rows[0]?.id ?? '');
    for (const [index, asset] of preview.contextPack.selectedExamples.entries()) {
      if (!asset.id) continue;
      await client.query('INSERT INTO prompt_recipe_assets (tenant_id, prompt_recipe_id, creative_asset_id, selection_role, selection_reason, rank) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, prompt_recipe_id, creative_asset_id) DO UPDATE SET selection_reason = EXCLUDED.selection_reason, rank = EXCLUDED.rank', [tenantId, id, asset.id, 'example', asset.selectionReason, index + 1]);
    }
    for (const [index, styleCard] of preview.contextPack.selectedStyleCards.entries()) {
      await client.query('INSERT INTO prompt_recipe_style_cards (tenant_id, prompt_recipe_id, style_card_id, selection_reason, rank) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, prompt_recipe_id, style_card_id) DO UPDATE SET selection_reason = EXCLUDED.selection_reason, rank = EXCLUDED.rank', [tenantId, id, styleCard.id, styleCard.selectionReason, index + 1]);
    }
    return { id, preview };
  });
}
