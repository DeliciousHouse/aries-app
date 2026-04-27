import type { CreativeContextPack, CreativeMemoryBrief, MarketPatternNote, SelectedCreativeExample, SelectedStyleCard } from '@/types/creative-memory';
import { assertFrontendSafeResponse } from './errors';
import type { QueryClient } from './profileContext';
import { loadProfileContext, summarizeProfileContext } from './profileContext';
import { requireNumericTenantId, type TenantContext } from './tenant';
import { projectSafeCreativeAsset } from './assets';

function approxTokens(text: string): number { return Math.ceil(text.length / 4); }

export async function retrieveCreativeContextPack(ctx: TenantContext, db: QueryClient, brief: CreativeMemoryBrief, maxTokens = 3500): Promise<CreativeContextPack> {
  const tenantId = requireNumericTenantId(ctx);
  const profile = await loadProfileContext(ctx, db);
  // Fetch eligible examples with eligibility filtering in SQL (before LIMIT) to prevent
  // ineligible recent assets from crowding out older approved ones (LIMIT 30 bug).
  // A separate query tracks recent ineligible/competitor assets for excludedCandidates.
  const [styleRows, eligibleAssetRows, excludedAssetRows, marketRows] = await Promise.all([
    db.query<Record<string, unknown>>(`SELECT * FROM style_cards WHERE tenant_id = $1 AND status = 'active' ORDER BY confidence_score DESC NULLS LAST, updated_at DESC LIMIT 8`, [tenantId]),
    db.query<Record<string, unknown>>(
      `SELECT * FROM creative_assets WHERE tenant_id = $1
         AND usable_for_generation = TRUE
         AND source_type NOT IN ('competitor_meta_ad')
         AND permission_scope NOT IN ('public_ad_library')
         AND source_type IN ('owned_instagram','owned_facebook','owned_meta_ad','generated_by_aries')
         AND permission_scope IN ('owned','generated')
         AND learning_lifecycle = 'approved_for_generation'
       ORDER BY created_at DESC LIMIT 10`,
      [tenantId]
    ),
    db.query<Record<string, unknown>>(
      `SELECT id, source_type, permission_scope, learning_lifecycle FROM creative_assets WHERE tenant_id = $1
         AND (source_type IN ('competitor_meta_ad') OR permission_scope IN ('public_ad_library')
              OR learning_lifecycle != 'approved_for_generation' OR usable_for_generation = FALSE)
       ORDER BY created_at DESC LIMIT 20`,
      [tenantId]
    ),
    db.query<Record<string, unknown>>(`SELECT * FROM market_pattern_notes WHERE tenant_id = $1 AND allowed_use = $2 ORDER BY created_at DESC LIMIT 5`, [tenantId, 'abstract_only']),
  ]);
  const excludedCandidates: CreativeContextPack['excludedCandidates'] = [];
  const selectedStyleCards: SelectedStyleCard[] = styleRows.rows.filter((row) => {
    const status = String(row.status ?? 'active');
    if (status !== 'active') { excludedCandidates.push({ id: String(row.id), sourceType: 'style_card', reason: 'style_card_archived' }); return false; }
    return true;
  }).map((row) => ({
    id: String(row.id),
    name: String(row.name ?? 'Recommended pattern'),
    visualDna: String(row.visual_dna ?? ''),
    copyDna: String(row.copy_dna ?? ''),
    promptGuidance: String(row.prompt_guidance ?? ''),
    negativeGuidance: String(row.negative_guidance ?? ''),
    confidenceScore: Number(row.confidence_score ?? 0),
    selectionReason: 'Active approved campaign learning pattern with the strongest available fit for this brief.',
  })).slice(0, 2);

  // Track recent ineligible/competitor assets in excludedCandidates for UI transparency
  excludedAssetRows.rows.forEach((row) => {
    const sourceType = String(row.source_type ?? '');
    const permissionScope = String(row.permission_scope ?? '');
    const lifecycle = String(row.learning_lifecycle ?? 'observed');
    if (sourceType === 'competitor_meta_ad' || permissionScope === 'public_ad_library') {
      excludedCandidates.push({ id: String(row.id), sourceType, reason: 'competitor_direct_example_forbidden' });
    } else {
      excludedCandidates.push({ id: String(row.id), sourceType, reason: `asset_lifecycle_${lifecycle}` });
    }
  });

  const selectedExamples: SelectedCreativeExample[] = [];
  eligibleAssetRows.rows.forEach((row, index) => {
    const asset = projectSafeCreativeAsset(row);
    if (!asset) { excludedCandidates.push({ id: String(row.id), sourceType: String(row.source_type ?? ''), reason: 'asset_not_eligible_for_direct_generation' }); return; }
    selectedExamples.push({ ...asset, selectionReason: 'Approved owned/generated reference matched this run.', rank: index + 1 });
  });
  const limitedExamples = selectedExamples.slice(0, 5);
  const marketPatternNotes: MarketPatternNote[] = marketRows.rows.map((row) => ({
    id: String(row.id),
    sourceLabel: String(row.source_label ?? 'Market pattern'),
    pattern: String(row.pattern ?? row.note ?? ''),
    allowedUse: 'abstract_only' as const,
    selectionReason: 'Competitor-derived abstraction, not a direct visual example.',
  })).slice(0, 3);
  const brandSummary = summarizeProfileContext(profile);
  const tokenEstimate = approxTokens([
    brandSummary,
    brief.objective,
    brief.offer,
    brief.audience,
    ...selectedStyleCards.map((s) => `${s.visualDna} ${s.copyDna} ${s.promptGuidance}`),
    ...limitedExamples.map((e) => e.selectionReason),
    ...marketPatternNotes.map((n) => n.pattern),
  ].join('\n'));
  const status: CreativeContextPack['status'] = limitedExamples.length ? 'ready' : marketPatternNotes.length ? 'competitor_only' : 'insufficient_memory';
  return assertFrontendSafeResponse({
    status,
    brandSummary,
    selectedStyleCards,
    selectedExamples: limitedExamples,
    marketPatternNotes,
    excludedCandidates,
    performanceNotes: selectedStyleCards.length ? ['Manual labels are available before performance scoring.'] : [],
    provenance: { generatedAt: new Date().toISOString(), retrieval: 'structured_v1' },
    tokenEstimate,
    maxTokens,
  });
}
