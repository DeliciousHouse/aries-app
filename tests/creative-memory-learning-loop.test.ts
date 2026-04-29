/**
 * Creative Memory Learning Loop Evals
 * Deterministic, model-free tests proving Aries learns creative preferences over time.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { compilePromptPreview } from '../backend/creative-memory/promptCompiler';
import { retrieveCreativeContextPack } from '../backend/creative-memory/retrieval';
import { createGeneratedAssetCandidate, updateGeneratedAssetReview } from '../backend/creative-memory/generatedAssets';
import { saveCampaignLearningLabel } from '../backend/creative-memory/learningEvents';
import type { QueryClient, QueryResult } from '../backend/creative-memory/profileContext';
import type { CreativeMemoryBrief } from '../types/creative-memory';

// ---------------------------------------------------------------------------
// Fake DB helpers
// ---------------------------------------------------------------------------

interface FakeDbTables {
  businessProfiles?: Record<string, unknown>[];
  styleCards?: Record<string, unknown>[];
  creativeAssets?: Record<string, unknown>[];
  marketPatternNotes?: Record<string, unknown>[];
  promptRecipes?: Record<string, unknown>[];
  generatedAssets?: Record<string, unknown>[];
  campaignLearningLabels?: Record<string, unknown>[];
}

function makeDb(tables: FakeDbTables): QueryClient & { connect?: () => Promise<QueryClient & { release: () => void; query: QueryClient['query'] }> } {
  const rows = {
    businessProfiles: tables.businessProfiles ?? [],
    styleCards: tables.styleCards ?? [],
    creativeAssets: tables.creativeAssets ?? [],
    marketPatternNotes: tables.marketPatternNotes ?? [],
    promptRecipes: tables.promptRecipes ?? [],
    generatedAssets: tables.generatedAssets ?? [],
    campaignLearningLabels: tables.campaignLearningLabels ?? [],
  };

  async function query<Row = Record<string, unknown>>(sql: string, _values?: unknown[]): Promise<QueryResult<Row>> {
    const s = sql.replace(/\s+/g, ' ').trim();
    const values = _values ?? [];
    const tenantId = values[0];
    const forTenant = (r: Record<string, unknown>) => tenantId === undefined || String(r.tenant_id ?? tenantId) === String(tenantId);
    const createdDesc = (a: Record<string, unknown>, b: Record<string, unknown>) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
    const limited = <T,>(items: T[]) => {
      const match = s.match(/LIMIT (\d+)/i);
      return match ? items.slice(0, Number(match[1])) : items;
    };
    // Transaction control
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] as Row[] };
    if (s.includes('FROM business_profiles')) return { rows: rows.businessProfiles.filter(forTenant) as Row[] };
    if (s.includes('FROM style_cards')) return { rows: limited(rows.styleCards.filter(forTenant).sort((a, b) => Number(b.confidence_score ?? 0) - Number(a.confidence_score ?? 0))) as Row[] };
    if (s.includes('FROM creative_assets') && s.startsWith('SELECT *')) {
      // Eligible asset query (filters lifecycle/source in SQL, then production code applies stricter projection safety)
      if (s.includes('usable_for_generation')) {
        return {
          rows: limited(rows.creativeAssets.filter(forTenant).filter((r) => {
            const st = String(r.source_type ?? '');
            const ps = String(r.permission_scope ?? '');
            const lc = String(r.learning_lifecycle ?? '');
            return r.usable_for_generation === true
              && st !== 'competitor_meta_ad'
              && ps !== 'public_ad_library'
              && ['owned_instagram','owned_facebook','owned_meta_ad','generated_by_aries'].includes(st)
              && ['owned','generated'].includes(ps)
              && lc === 'approved_for_generation';
          }).sort(createdDesc)) as Row[],
        };
      }
      return { rows: limited(rows.creativeAssets.filter(forTenant).sort(createdDesc)) as Row[] };
    }
    // Excluded asset query (ineligible/competitor for excludedCandidates)
    if (s.includes('FROM creative_assets') && s.startsWith('SELECT id,')) {
      return {
        rows: limited(rows.creativeAssets.filter(forTenant).filter((r) => {
          const st = String(r.source_type ?? '');
          const ps = String(r.permission_scope ?? '');
          const lc = String(r.learning_lifecycle ?? '');
          return st === 'competitor_meta_ad' || ps === 'public_ad_library'
            || lc !== 'approved_for_generation' || r.usable_for_generation === false;
        }).sort(createdDesc)) as Row[],
      };
    }
    if (s.includes('FROM market_pattern_notes')) return { rows: limited(rows.marketPatternNotes.filter(forTenant).sort(createdDesc)) as Row[] };
    if (s.includes('FROM prompt_recipes') || (s.startsWith('SELECT') && s.includes('prompt_recipes'))) return { rows: rows.promptRecipes as Row[] };
    // generated_assets INSERT
    if (s.startsWith('INSERT') && s.includes('generated_assets')) {
      const values = _values as unknown[];
      const variantKind = values[3] as string;
      const promptText = values[4] as string;
      const creativeAssetId = (values[2] as string | null) ?? null;
      const newRow = { id: `gen-${Date.now()}-${Math.random().toString(36).slice(2)}`, variant_kind: variantKind, creative_asset_id: creativeAssetId, prompt_text: promptText, learning_lifecycle: 'suggested', review_status: 'pending' };
      rows.generatedAssets.push(newRow);
      return { rows: [newRow] as Row[] };
    }
    // generated_assets SELECT
    if (s.startsWith('SELECT') && s.includes('generated_assets')) return { rows: rows.generatedAssets as Row[] };
    // generated_assets UPDATE
    if (s.startsWith('UPDATE generated_assets') || (s.startsWith('UPDATE') && s.includes('generated_assets'))) {
      const values = _values as unknown[];
      const id = values[1];
      const reviewStatus = values[2] as string;
      const lifecycle = values[3] as string;
      const ga = rows.generatedAssets.find((r) => r.id === id);
      if (!ga) return { rows: [] };
      ga.review_status = reviewStatus;
      ga.learning_lifecycle = lifecycle;
      return { rows: [ga] as Row[] };
    }
    // creative_assets SELECT by id (assertGeneratedCreativeAssetLink: SELECT id, source_type, permission_scope FROM ...)
    if (s.includes('FROM creative_assets') && s.includes('WHERE')) {
      const values = _values as unknown[];
      const tid = values[0];
      const aid = values[1];
      const found = rows.creativeAssets.filter((r) => String(r.tenant_id) === String(tid) && String(r.id) === String(aid));
      return { rows: found as Row[] };
    }
    // UPDATE creative_assets
    if (s.startsWith('UPDATE creative_assets') || (s.startsWith('UPDATE') && s.includes('creative_assets'))) {
      const values = _values as unknown[];
      const tid = values[0];
      const aid = values[1];
      rows.creativeAssets.forEach((r) => {
        if (String(r.tenant_id) === String(tid) && String(r.id) === String(aid)) {
          r.usable_for_generation = true;
          r.learning_lifecycle = 'approved_for_generation';
        }
      });
      return { rows: [] };
    }
    // campaign_learning_labels INSERT
    if (s.startsWith('INSERT') && s.includes('campaign_learning_labels')) {
      const values = _values as unknown[];
      const [tid, ikey, label, prId, gaId, note, source] = values as string[];
      const existing = rows.campaignLearningLabels.find((r) => String(r.tenant_id) === String(tid) && r.idempotency_key === ikey);
      if (existing) return { rows: [] as Row[] };
      const newRow = { id: `lbl-${Date.now()}`, tenant_id: tid, idempotency_key: ikey, label, prompt_recipe_id: prId ?? null, generated_asset_id: gaId ?? null, note: note ?? null, source: source ?? 'operator' };
      rows.campaignLearningLabels.push(newRow);
      return { rows: [newRow] as Row[] };
    }
    // campaign_learning_labels SELECT
    if (s.startsWith('SELECT') && s.includes('campaign_learning_labels')) {
      const values = _values as unknown[];
      const tid = values[0];
      const ikey = values[1];
      const found = rows.campaignLearningLabels.filter((r) => String(r.tenant_id) === String(tid) && r.idempotency_key === ikey);
      return { rows: found as Row[] };
    }
    throw new Error(`Unexpected SQL: ${s.slice(0, 120)}`);
  }

  const db = { query } as QueryClient;
  // Tx support (for updateGeneratedAssetReview on approval path)
  const withConnect = db as typeof db & { connect: () => Promise<QueryClient & { release: () => void }> };
  withConnect.connect = async () => ({ ...db, release: () => undefined });
  return withConnect;
}

function makeTenant(id: string) {
  return { tenantId: id, tenantSlug: `tenant-${id}`, userId: `user-${id}`, role: 'tenant_admin' } as const;
}

const BASE_BRIEF: CreativeMemoryBrief = {
  objective: 'Increase trial sign-ups',
  platform: 'meta',
  placement: 'feed',
  aspectRatio: '1:1',
  funnelStage: 'awareness',
  offer: '14-day free trial',
  audience: 'SaaS founders 25-45',
  creativeType: 'static_image',
  cta: 'Start Free Trial',
  imageText: ['Start Free Trial'],
  mustAvoidAesthetics: ['stock photography', 'corporate headshots'],
};

function makeProfile(name: string) {
  return {
    business_name: name,
    brand_voice: 'Direct and confident',
    style_vibe: 'Professional',
    offer: '14-day free trial',
    notes: null,
  };
}

function makeStyleCard(id: string, tenantId: string, confidenceScore: number, opts: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    tenant_id: tenantId,
    name: opts.name ?? `Style Card ${id}`,
    status: 'active',
    confidence_score: confidenceScore,
    visual_dna: opts.visual_dna ?? `Visual DNA for ${id}`,
    copy_dna: opts.copy_dna ?? `Copy DNA for ${id}`,
    prompt_guidance: opts.prompt_guidance ?? `Prompt guidance for ${id}`,
    negative_guidance: opts.negative_guidance ?? `Negative guidance for ${id}`,
    updated_at: new Date().toISOString(),
  };
}

function makeApprovedAsset(id: string, tenantId: string, createdAtOffset = 0) {
  const created = new Date(Date.now() - createdAtOffset);
  return {
    id,
    tenant_id: tenantId,
    source_type: 'owned_instagram',
    permission_scope: 'owned',
    learning_lifecycle: 'approved_for_generation',
    usable_for_generation: true,
    served_asset_ref: '/materials/assets/img.jpg',
    media_type: 'image',
    exact_image_text: ['Free Trial'],
    created_at: created.toISOString(),
  };
}

function makeCompetitorAsset(id: string, tenantId: string) {
  return {
    id,
    tenant_id: tenantId,
    source_type: 'competitor_meta_ad',
    permission_scope: 'public_ad_library',
    learning_lifecycle: 'observed',
    usable_for_generation: false,
    served_asset_ref: null,
    media_type: 'image',
    created_at: new Date().toISOString(),
  };
}

function makeIneligibleAsset(id: string, tenantId: string, lifecycle = 'observed') {
  return {
    id,
    tenant_id: tenantId,
    source_type: 'owned_instagram',
    permission_scope: 'owned',
    learning_lifecycle: lifecycle,
    usable_for_generation: false,
    served_asset_ref: '/materials/assets/img.jpg',
    media_type: 'image',
    exact_image_text: [],
    created_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Task 1: No approved memory => insufficient_memory
// ---------------------------------------------------------------------------
test('no approved memory => insufficient_memory, canGenerate false', async () => {
  const db = makeDb({ businessProfiles: [makeProfile('TestBrand')], styleCards: [], creativeAssets: [], marketPatternNotes: [] });
  const ctx = makeTenant('9200');
  const preview = await compilePromptPreview(ctx, db, BASE_BRIEF);

  assert.equal(preview.contextPack.status, 'insufficient_memory');
  assert.equal(preview.canGenerate, false);
  assert.ok(preview.blockingReason, 'should have a blockingReason');
  assert.ok(preview.blockingReason!.toLowerCase().includes('approved') || preview.blockingReason!.toLowerCase().includes('enough'), `blockingReason should mention approved/enough, got: ${preview.blockingReason}`);
  assert.equal(preview.contextPack.selectedStyleCards.length, 0);
  assert.equal(preview.contextPack.selectedExamples.length, 0);
  assert.ok(!preview.compiledPrompt.includes('Memory-assisted guidance:'), 'compiledPrompt should not have Memory-assisted guidance when blocked');
  assert.ok(!preview.baselinePrompt.includes('Memory-assisted'), 'baselinePrompt must be memory-free');
  assert.ok(preview.negativePrompt.includes('NO competitor logos'), 'negativePrompt must include global guardrails');
  assert.ok(preview.negativePrompt.includes('stock photography'), 'negativePrompt must include brief.mustAvoidAesthetics');
});

// ---------------------------------------------------------------------------
// Task 2: Before/after approved memory prompt-delta
// ---------------------------------------------------------------------------
test('before memory: blocked; after approved assets+cards: ready with Memory-assisted guidance', async () => {
  const tenantId = '9201';
  const ctx = makeTenant(tenantId);

  // BEFORE
  const dbBefore = makeDb({ businessProfiles: [makeProfile('AfterBrand')], styleCards: [], creativeAssets: [], marketPatternNotes: [] });
  const previewBefore = await compilePromptPreview(ctx, dbBefore, BASE_BRIEF);
  assert.equal(previewBefore.contextPack.status, 'insufficient_memory');
  assert.equal(previewBefore.canGenerate, false);

  // AFTER: two high-confidence style cards, one lower-confidence decoy, one approved asset
  const card1 = makeStyleCard('sc-1', tenantId, 0.95, { prompt_guidance: 'dark premium hero layout', negative_guidance: 'no bright pastels' });
  const card2 = makeStyleCard('sc-2', tenantId, 0.88, { prompt_guidance: 'champagne gold accent', negative_guidance: 'no neon colors' });
  const cardDecoy = makeStyleCard('sc-low', tenantId, 0.40, { prompt_guidance: 'should NOT appear in output' });
  const approvedAsset = makeApprovedAsset('asset-1', tenantId);
  const competitorDecoy = makeCompetitorAsset('asset-comp', tenantId);
  const draftDecoy = makeIneligibleAsset('asset-draft', tenantId, 'suggested');
  const rejectedDecoy = makeIneligibleAsset('asset-rej', tenantId, 'archived');

  const dbAfter = makeDb({
    businessProfiles: [makeProfile('AfterBrand')],
    styleCards: [card1, card2, cardDecoy],
    creativeAssets: [approvedAsset, competitorDecoy, draftDecoy, rejectedDecoy],
    marketPatternNotes: [],
  });

  const previewAfter = await compilePromptPreview(ctx, dbAfter, BASE_BRIEF);
  assert.equal(previewAfter.contextPack.status, 'ready');
  assert.equal(previewAfter.canGenerate, true);
  assert.ok(previewAfter.compiledPrompt.includes('Memory-assisted guidance:'), 'compiledPrompt must have Memory-assisted guidance when ready');
  assert.ok(previewAfter.compiledPrompt.includes('dark premium hero layout'), 'compiledPrompt must include card1 guidance');
  assert.ok(previewAfter.compiledPrompt.includes('champagne gold accent'), 'compiledPrompt must include card2 guidance');
  assert.ok(!previewAfter.compiledPrompt.includes('should NOT appear in output'), 'low-confidence card must not appear');
  assert.ok(!previewAfter.baselinePrompt.includes('Memory-assisted'), 'baselinePrompt stays memory-free');
  assert.ok(previewAfter.negativePrompt.includes('NO competitor logos'), 'negativePrompt has global guardrails');
  assert.ok(previewAfter.negativePrompt.includes('no bright pastels'), 'negativePrompt includes style card negative guidance');
  assert.ok(previewAfter.negativePrompt.includes('no neon colors'), 'negativePrompt includes card2 negative guidance');
  assert.ok(previewAfter.negativePrompt.includes('stock photography'), 'negativePrompt includes brief.mustAvoidAesthetics');

  // Only top 2 style cards selected
  assert.equal(previewAfter.contextPack.selectedStyleCards.length, 2);
  const selectedIds = previewAfter.contextPack.selectedStyleCards.map((c) => c.id);
  assert.ok(selectedIds.includes('sc-1'));
  assert.ok(selectedIds.includes('sc-2'));
  assert.ok(!selectedIds.includes('sc-low'));

  // Competitor decoy excluded
  const compExcluded = previewAfter.contextPack.excludedCandidates.find((e) => e.id === 'asset-comp');
  assert.ok(compExcluded, 'competitor asset must be in excludedCandidates');
  assert.equal(compExcluded!.reason, 'competitor_direct_example_forbidden');

  // Draft/rejected lifecycle decoys excluded
  const draftExcluded = previewAfter.contextPack.excludedCandidates.find((e) => e.id === 'asset-draft');
  assert.ok(draftExcluded, 'draft asset must be excluded');
  assert.ok(draftExcluded!.reason.startsWith('asset_lifecycle_'), `draft reason should be asset_lifecycle_*, got: ${draftExcluded!.reason}`);

  const rejExcluded = previewAfter.contextPack.excludedCandidates.find((e) => e.id === 'asset-rej');
  assert.ok(rejExcluded, 'rejected asset must be excluded');
});

// ---------------------------------------------------------------------------
// Task 3: Competitor-only state
// ---------------------------------------------------------------------------
test('competitor-only notes => competitor_only status, canGenerate false, no direct examples', async () => {
  const tenantId = '9202';
  const ctx = makeTenant(tenantId);
  const competitorAsset = makeCompetitorAsset('comp-1', tenantId);
  const marketNote = {
    id: 'note-1',
    tenant_id: tenantId,
    source_label: 'Competitor brand analysis',
    pattern: 'Bold oversized headline pattern dominates competitor ads',
    note: 'Bold oversized headline pattern dominates competitor ads',
    allowed_use: 'abstract_only',
    created_at: new Date().toISOString(),
  };

  const db = makeDb({
    businessProfiles: [makeProfile('CompetitorBrand')],
    styleCards: [],
    creativeAssets: [competitorAsset],
    marketPatternNotes: [marketNote],
  });

  const preview = await compilePromptPreview(ctx, db, BASE_BRIEF);
  assert.equal(preview.contextPack.status, 'competitor_only');
  assert.equal(preview.canGenerate, false);
  assert.ok(preview.blockingReason, 'should have blockingReason');
  assert.ok(
    preview.blockingReason!.toLowerCase().includes('competitor') || preview.blockingReason!.toLowerCase().includes('abstract'),
    `blockingReason should mention competitor/abstract, got: ${preview.blockingReason}`
  );
  assert.equal(preview.contextPack.selectedExamples.length, 0, 'no direct examples allowed in competitor_only');
  assert.ok(preview.contextPack.marketPatternNotes.length > 0, 'market pattern notes must be present');

  const compExcluded = preview.contextPack.excludedCandidates.find((e) => e.id === 'comp-1');
  assert.ok(compExcluded, 'competitor asset must be excluded');
  assert.equal(compExcluded!.reason, 'competitor_direct_example_forbidden');

  assert.ok(!preview.compiledPrompt.includes('comp-1'), 'competitor id must not appear in compiled prompt');
});

// ---------------------------------------------------------------------------
// Task 4: Generated asset approval loop
// ---------------------------------------------------------------------------
test('generated asset starts pending/suggested and is excluded, then approved becomes eligible', async () => {
  const tenantId = '9203';
  const ctx = makeTenant(tenantId);

  // Start with a ready prompt recipe in DB
  const promptRecipe = {
    id: 'pr-1',
    tenant_id: tenantId,
    compiled_prompt: 'MEMORY PROMPT',
    context_pack: {
      status: 'ready',
      promptProvenance: { baselinePrompt: 'BASELINE PROMPT', compiledPrompt: 'MEMORY PROMPT', canGenerate: true },
    },
  };

  // An Aries-generated creative asset
  const ariesAsset = {
    id: 'gen-asset-1',
    tenant_id: tenantId,
    source_type: 'generated_by_aries',
    permission_scope: 'generated',
    learning_lifecycle: 'suggested',
    usable_for_generation: false,
    served_asset_ref: '/materials/gen/img.jpg',
    media_type: 'image',
    exact_image_text: [],
    created_at: new Date().toISOString(),
  };

  const db = makeDb({
    businessProfiles: [makeProfile('GenBrand')],
    styleCards: [],
    creativeAssets: [ariesAsset],
    marketPatternNotes: [],
    promptRecipes: [promptRecipe],
  });

  // Step 1: Create candidate
  const candidate = await createGeneratedAssetCandidate(ctx, db, { promptRecipeId: 'pr-1', creativeAssetId: 'gen-asset-1', variantKind: 'memory_assisted' });
  assert.equal(candidate.learningLifecycle, 'suggested');
  assert.equal(candidate.reviewStatus, 'pending');

  // Step 2: Retrieval excludes pending asset (not approved_for_generation)
  const card = makeStyleCard('sc-x', tenantId, 0.9);
  const dbWithCard = makeDb({
    businessProfiles: [makeProfile('GenBrand')],
    styleCards: [card],
    creativeAssets: [ariesAsset], // still pending
    marketPatternNotes: [],
  });
  const packBefore = await retrieveCreativeContextPack(ctx, dbWithCard, BASE_BRIEF);
  assert.equal(packBefore.selectedExamples.length, 0, 'pending generated asset must be excluded from examples');

  // Step 3: Approve it
  // Need usable asset for approval path
  const dbForApproval = makeDb({
    businessProfiles: [makeProfile('GenBrand')],
    styleCards: [card],
    creativeAssets: [ariesAsset],
    marketPatternNotes: [],
    promptRecipes: [promptRecipe],
    generatedAssets: [{ id: candidate.id, tenant_id: tenantId, creative_asset_id: 'gen-asset-1', review_status: 'pending', learning_lifecycle: 'suggested' }],
  });
  const approved = await updateGeneratedAssetReview(ctx, dbForApproval, { generatedAssetId: candidate.id, reviewStatus: 'approved' });
  assert.equal(approved!.reviewStatus, 'approved');
  assert.equal(approved!.learningLifecycle, 'approved_for_generation');

  // Step 4: Verify approval mutates the linked creative_assets row, then retrieval learns from that same DB state.
  assert.equal(ariesAsset.usable_for_generation, true, 'approval must mark linked creative asset usable');
  assert.equal(ariesAsset.learning_lifecycle, 'approved_for_generation', 'approval must mark linked creative asset approved_for_generation');
  const packAfter = await retrieveCreativeContextPack(ctx, dbForApproval, BASE_BRIEF);
  assert.equal(packAfter.selectedExamples.length, 1, 'approved generated asset must appear in selectedExamples');
  assert.equal(packAfter.selectedExamples[0].id, 'gen-asset-1');
});

test('rejected generated asset remains excluded', async () => {
  const tenantId = '92031';
  const ctx = makeTenant(tenantId);
  const promptRecipe = {
    id: 'pr-2',
    compiled_prompt: 'MEMORY',
    context_pack: { status: 'ready', promptProvenance: { baselinePrompt: 'BASELINE', compiledPrompt: 'MEMORY', canGenerate: true } },
  };
  const ariesAsset = {
    id: 'gen-asset-2',
    tenant_id: tenantId,
    source_type: 'generated_by_aries',
    permission_scope: 'generated',
    learning_lifecycle: 'suggested',
    usable_for_generation: false,
    served_asset_ref: null,
    media_type: 'image',
    created_at: new Date().toISOString(),
  };
  const db = makeDb({
    businessProfiles: [makeProfile('GenBrand')],
    styleCards: [],
    creativeAssets: [ariesAsset],
    marketPatternNotes: [],
    promptRecipes: [promptRecipe],
    generatedAssets: [{ id: 'ga-rej', tenant_id: tenantId, creative_asset_id: 'gen-asset-2', review_status: 'pending', learning_lifecycle: 'suggested' }],
  });
  const rejected = await updateGeneratedAssetReview(ctx, db, { generatedAssetId: 'ga-rej', reviewStatus: 'rejected' });
  assert.equal(rejected!.reviewStatus, 'rejected');
  assert.equal(rejected!.learningLifecycle, 'archived');
});

// ---------------------------------------------------------------------------
// Task 5: Label idempotency
// ---------------------------------------------------------------------------
test('label idempotent replay returns same label with idempotentReplay: true', async () => {
  const db = makeDb({ campaignLearningLabels: [] });
  const ctx = makeTenant('9204');
  const input = { idempotencyKey: 'idem-1', label: 'used_in_campaign' as const, promptRecipeId: 'pr-1' };
  const first = await saveCampaignLearningLabel(ctx, db, input);
  assert.equal(first.idempotentReplay, false);
  const second = await saveCampaignLearningLabel(ctx, db, input);
  assert.equal(second.idempotentReplay, true);
  assert.equal(second.label, first.label);
});

test('same idempotency key with different label returns conflict', async () => {
  const db = makeDb({ campaignLearningLabels: [] });
  const ctx = makeTenant('9204');
  await saveCampaignLearningLabel(ctx, db, { idempotencyKey: 'idem-2', label: 'useful', promptRecipeId: 'pr-1' });
  await assert.rejects(
    () => saveCampaignLearningLabel(ctx, db, { idempotencyKey: 'idem-2', label: 'not_useful', promptRecipeId: 'pr-1' }),
    /different outcome label or target/
  );
});

test('same idempotency key with different promptRecipeId returns conflict', async () => {
  const db = makeDb({ campaignLearningLabels: [] });
  const ctx = makeTenant('9204');
  await saveCampaignLearningLabel(ctx, db, { idempotencyKey: 'idem-3', label: 'useful', promptRecipeId: 'pr-1' });
  await assert.rejects(
    () => saveCampaignLearningLabel(ctx, db, { idempotencyKey: 'idem-3', label: 'useful', promptRecipeId: 'pr-2' }),
    /different outcome label or target/
  );
});

test('same idempotency key with different source returns conflict', async () => {
  const db = makeDb({ campaignLearningLabels: [] });
  const ctx = makeTenant('9204');
  await saveCampaignLearningLabel(ctx, db, { idempotencyKey: 'idem-4', label: 'useful', promptRecipeId: 'pr-1', source: 'operator' });
  await assert.rejects(
    () => saveCampaignLearningLabel(ctx, db, { idempotencyKey: 'idem-4', label: 'useful', promptRecipeId: 'pr-1', source: 'automated' }),
    /different outcome label or target/
  );
});

test('missing target rejects before writing', async () => {
  const db = makeDb({ campaignLearningLabels: [] });
  const ctx = makeTenant('9204');
  await assert.rejects(
    () => saveCampaignLearningLabel(ctx, db, { idempotencyKey: 'idem-5', label: 'useful' }),
    /reference a prompt recipe or generated asset/
  );
});

test('label alone does not make a non-approved asset selected by retrieval', async () => {
  const tenantId = '92041';
  const ctx = makeTenant(tenantId);
  const ineligibleAsset = makeIneligibleAsset('asset-labeled', tenantId, 'observed');
  const labeledGeneratedAsset = {
    id: 'generated-labeled',
    tenant_id: tenantId,
    creative_asset_id: 'asset-labeled',
    review_status: 'pending',
    learning_lifecycle: 'suggested',
  };
  const db = makeDb({
    businessProfiles: [makeProfile('LabelBrand')],
    styleCards: [],
    creativeAssets: [ineligibleAsset],
    marketPatternNotes: [],
    generatedAssets: [labeledGeneratedAsset],
    campaignLearningLabels: [],
  });
  // Apply a "useful" label to the generated_assets row linked to the creative asset.
  // Labels are confidence signals only; they must not change creative_assets lifecycle approval.
  await saveCampaignLearningLabel(ctx, db, { idempotencyKey: 'lbl-asset', label: 'useful', generatedAssetId: 'generated-labeled' });
  // Retrieval should still exclude the linked creative asset until the approval loop marks it approved_for_generation.
  const pack = await retrieveCreativeContextPack(ctx, db, BASE_BRIEF);
  assert.equal(pack.selectedExamples.length, 0, 'labeled but non-approved asset must not be selected');
  const excluded = pack.excludedCandidates.find((e) => e.id === 'asset-labeled');
  assert.ok(excluded, 'non-approved asset must appear in excludedCandidates');
});

// ---------------------------------------------------------------------------
// Task 6: Tenant isolation
// ---------------------------------------------------------------------------
test('tenant A and tenant B preferences never leak into each other', async () => {
  const tenantA = '9300';
  const tenantB = '9301';
  const ctxA = makeTenant(tenantA);
  const ctxB = makeTenant(tenantB);

  const cardA = makeStyleCard('sc-dark-luxury', tenantA, 0.95, {
    prompt_guidance: 'dark luxury premium hero obsidian charcoal',
    negative_guidance: 'no bright candy colors',
  });
  const cardB = makeStyleCard('sc-bright-playful', tenantB, 0.95, {
    prompt_guidance: 'bright saturated coral aqua color blocking',
    negative_guidance: 'no dark luxury minimalism',
  });
  const assetA = makeApprovedAsset('asset-a', tenantA);
  const assetB = makeApprovedAsset('asset-b', tenantB);

  const db = makeDb({
    businessProfiles: [
      { ...makeProfile('Nocturne Skin'), tenant_id: tenantA },
      { ...makeProfile('PopGlow Lab'), tenant_id: tenantB },
    ],
    styleCards: [cardA, cardB],
    creativeAssets: [assetA, assetB],
    marketPatternNotes: [],
  });

  const previewA = await compilePromptPreview(ctxA, db, BASE_BRIEF);
  const previewB = await compilePromptPreview(ctxB, db, BASE_BRIEF);

  assert.equal(previewA.contextPack.status, 'ready');
  assert.equal(previewB.contextPack.status, 'ready');

  // A includes A guidance, excludes B guidance
  assert.ok(previewA.compiledPrompt.includes('dark luxury premium hero'), 'tenant A must have dark luxury guidance');
  assert.ok(!previewA.compiledPrompt.includes('bright saturated coral'), 'tenant A must not have tenant B bright guidance');
  assert.ok(previewA.negativePrompt.includes('no bright candy colors'), 'tenant A negative prompt must have A card guidance');

  // B includes B guidance, excludes A guidance
  assert.ok(previewB.compiledPrompt.includes('bright saturated coral'), 'tenant B must have bright playful guidance');
  assert.ok(!previewB.compiledPrompt.includes('dark luxury premium hero'), 'tenant B must not have tenant A dark guidance');
  assert.ok(previewB.negativePrompt.includes('no dark luxury minimalism'), 'tenant B negative prompt must have B card guidance');

  // Selected ids are tenant-local
  const idsA = previewA.contextPack.selectedStyleCards.map((c) => c.id);
  const idsB = previewB.contextPack.selectedStyleCards.map((c) => c.id);
  assert.ok(idsA.includes('sc-dark-luxury'));
  assert.ok(!idsA.includes('sc-bright-playful'));
  assert.ok(idsB.includes('sc-bright-playful'));
  assert.ok(!idsB.includes('sc-dark-luxury'));

  const examplesA = previewA.contextPack.selectedExamples.map((e) => e.id);
  const examplesB = previewB.contextPack.selectedExamples.map((e) => e.id);
  assert.ok(examplesA.includes('asset-a'));
  assert.ok(!examplesA.includes('asset-b'));
  assert.ok(examplesB.includes('asset-b'));
  assert.ok(!examplesB.includes('asset-a'));
});

// ---------------------------------------------------------------------------
// Task 7: LIMIT 30 retrieval regression - 30 ineligible + 1 older eligible
// ---------------------------------------------------------------------------
test('30 recent ineligible assets must not hide an older eligible asset', async () => {
  const tenantId = '9400';
  const ctx = makeTenant(tenantId);

  // 30 most recent ineligible assets
  const ineligible = Array.from({ length: 30 }, (_, i) => makeIneligibleAsset(`bad-${i}`, tenantId, 'observed'));
  // 1 older approved eligible asset
  const eligible = makeApprovedAsset('old-eligible', tenantId, 1000 * 60 * 60 * 24 * 7); // 7 days older
  const card = makeStyleCard('sc-limit', tenantId, 0.9);

  const db = makeDb({
    businessProfiles: [makeProfile('LimitBrand')],
    styleCards: [card],
    creativeAssets: [...ineligible, eligible],
    marketPatternNotes: [],
  });

  const pack = await retrieveCreativeContextPack(ctx, db, BASE_BRIEF);

  // If bug exists: selectedExamples.length === 0 because LIMIT 30 hides eligible asset
  // This test documents/catches the bug
  if (pack.selectedExamples.length === 0) {
    // Document the bug explicitly
    assert.fail(
      'RETRIEVAL BUG: 30 recent ineligible assets in creative_assets query cause LIMIT 30 to exclude the older eligible asset. ' +
      'Fix: filter eligibility in SQL before applying LIMIT, or increase the query window.'
    );
  }
  assert.equal(pack.selectedExamples[0].id, 'old-eligible', 'older eligible asset must be selected');
  assert.equal(pack.selectedExamples[0].rank, 1, 'selected safe examples should use contiguous rank after filtering');
});

test('recent SQL-eligible but projection-unsafe assets must not hide an older safe eligible asset', async () => {
  const tenantId = '9401';
  const ctx = makeTenant(tenantId);
  const card = makeStyleCard('sc-unsafe-limit', tenantId, 0.9);
  const unsafeRecent = Array.from({ length: 10 }, (_, i) => ({
    ...makeApprovedAsset(`unsafe-recent-${i}`, tenantId, i * 1000),
    served_asset_ref: `/home/node/private/${i}.jpg`,
  }));
  const safeOlder = makeApprovedAsset('older-safe-eligible', tenantId, 1000 * 60 * 60 * 24 * 7);
  const db = makeDb({
    businessProfiles: [makeProfile('ProjectionSafetyBrand')],
    styleCards: [card],
    creativeAssets: [...unsafeRecent, safeOlder],
    marketPatternNotes: [],
  });

  const pack = await retrieveCreativeContextPack(ctx, db, BASE_BRIEF);
  assert.equal(pack.status, 'ready', 'older safe asset should make context ready even after unsafe recent candidates');
  assert.equal(pack.selectedExamples[0].id, 'older-safe-eligible');
  assert.equal(pack.selectedExamples[0].rank, 1, 'rank should be assigned after projection-safe filtering');
  assert.ok(pack.excludedCandidates.some((e) => e.id === 'unsafe-recent-0' && e.reason === 'asset_not_eligible_for_direct_generation'));
});

// ---------------------------------------------------------------------------
// Task 8: Asset safety and frontend-safe response
// ---------------------------------------------------------------------------
test('assets with usable_for_generation=false are excluded', async () => {
  const tenantId = '9500';
  const ctx = makeTenant(tenantId);
  const unusableAsset = { ...makeApprovedAsset('unusable', tenantId), usable_for_generation: false };
  const db = makeDb({
    businessProfiles: [makeProfile('SafetyBrand')],
    styleCards: [],
    creativeAssets: [unusableAsset],
    marketPatternNotes: [],
  });
  const pack = await retrieveCreativeContextPack(ctx, db, BASE_BRIEF);
  assert.equal(pack.selectedExamples.length, 0);
  const excluded = pack.excludedCandidates.find((e) => e.id === 'unusable');
  assert.ok(excluded, 'unusable asset must appear in excludedCandidates');
  assert.equal(excluded.reason, 'asset_unusable_for_generation');
});

test('assets with unsafe served_asset_ref are excluded', async () => {
  const tenantId = '95001';
  const ctx = makeTenant(tenantId);
  const unsafeAsset = {
    ...makeApprovedAsset('unsafe', tenantId),
    served_asset_ref: '/home/node/secret/path.jpg', // filesystem path - blocked by sanitizer
  };
  const db = makeDb({
    businessProfiles: [makeProfile('SafetyBrand')],
    styleCards: [],
    creativeAssets: [unsafeAsset],
    marketPatternNotes: [],
  });
  const pack = await retrieveCreativeContextPack(ctx, db, BASE_BRIEF);
  assert.equal(pack.selectedExamples.length, 0, 'asset with unsafe path must be excluded');
});

test('context pack response does not leak storage_key, tenant_id, or raw asset URL fields', async () => {
  const tenantId = '9501';
  const ctx = makeTenant(tenantId);
  const rawAssetUrlLeakMarker = 'raw-file-url-leak-marker';
  const assetWithSensitive = {
    ...makeApprovedAsset('safe-1', tenantId),
    storage_key: 's3://bucket/key',  // must not appear in response
    file_url: `https://assets.example.invalid/${rawAssetUrlLeakMarker}.jpg`, // must be stripped
  };
  const db = makeDb({
    businessProfiles: [makeProfile('SafetyBrand')],
    styleCards: [makeStyleCard('sc-s', tenantId, 0.9)],
    creativeAssets: [assetWithSensitive],
    marketPatternNotes: [],
  });
  // assertFrontendSafeResponse in retrieval.ts will throw if response contains unsafe keys
  // If safe, it passes through; if unsafe, it throws
  const pack = await retrieveCreativeContextPack(ctx, db, BASE_BRIEF);
  const selected = pack.selectedExamples.find((example) => example.id === 'safe-1');
  assert.ok(selected, 'safe asset should remain selected after sensitive fields are stripped');
  assert.equal(selected.servedAssetRef, '/materials/assets/img.jpg');
  assert.equal(Object.prototype.hasOwnProperty.call(selected, 'file_url'), false, 'response must not have file_url key');
  const json = JSON.stringify(pack);
  assert.ok(!json.includes('/home/'), 'response must not contain /home/ filesystem path');
  assert.ok(!json.includes(rawAssetUrlLeakMarker), 'response must not contain raw asset URL values');
  // storage_key and tenant_id are blocked by assertFrontendSafeResponse
  assert.ok(!json.includes('"storage_key"'), 'response must not have storage_key key');
  assert.ok(!json.includes('"tenant_id"'), 'response must not have tenant_id key');
});

// ---------------------------------------------------------------------------
// Task 9: Golden profile fixtures
// ---------------------------------------------------------------------------

interface GoldenProfile {
  name: string;
  brandName: string;
  tenantId: string;
  cardGuidance: string;
  cardNegative: string;
  cardId: string;
  assetId: string;
  expectedInclude: string[];
  expectedExclude: string[];
  expectedNegative: string[];
}

const GOLDEN_PROFILES: GoldenProfile[] = [
  {
    name: 'golden-profile-01-dark-luxury',
    brandName: 'Nocturne Skin',
    tenantId: '9601',
    cardId: 'gp01-sc',
    assetId: 'gp01-asset',
    cardGuidance: 'dark premium product hero, obsidian charcoal, soft rim lighting, champagne-gold accent, generous negative space',
    cardNegative: 'no bright candy colors, no cluttered prop spreads, no cartoon shapes, no loud sale bursts, no clinical white lab scenes',
    expectedInclude: ['dark premium product hero', 'obsidian charcoal', 'champagne-gold accent'],
    expectedExclude: ['bright saturated coral', 'oversized simple shapes', 'founder-recorded UGC'],
    expectedNegative: ['no bright candy colors', 'no cluttered prop spreads'],
  },
  {
    name: 'golden-profile-02-bright-playful-dtc',
    brandName: 'PopGlow Lab',
    tenantId: '9602',
    cardId: 'gp02-sc',
    assetId: 'gp02-asset',
    cardGuidance: 'saturated coral lemon aqua color blocking, oversized simple shapes, bold product-first layout, playful sticker-like CTA',
    cardNegative: 'no black luxury minimalism, no muted beige palettes, no moody shadows, no tiny whisper typography',
    expectedInclude: ['saturated coral lemon aqua', 'oversized simple shapes', 'playful sticker-like CTA'],
    expectedExclude: ['obsidian charcoal', 'champagne-gold accent', 'founder-recorded UGC'],
    expectedNegative: ['no black luxury minimalism', 'no muted beige palettes'],
  },
  {
    name: 'golden-pref-03-founder-led-ugc',
    brandName: 'Northstar Ops Lab',
    tenantId: '9603',
    cardId: 'gp03-sc',
    assetId: 'gp03-asset',
    cardGuidance: 'founder-recorded UGC look, handheld desk selfie, natural light, unpolished crop, messy whiteboard breakdown',
    cardNegative: 'no polished studio lighting, no corporate stock people, no glossy SaaS UI mockups, no sterile infographic grid',
    expectedInclude: ['founder-recorded UGC look', 'handheld desk selfie', 'messy whiteboard breakdown'],
    expectedExclude: ['obsidian charcoal', 'saturated coral lemon aqua', 'direct-response offer card'],
    expectedNegative: ['no polished studio lighting', 'no corporate stock people'],
  },
  {
    name: 'golden-pref-04-direct-response-offer-heavy',
    brandName: 'SprintStack',
    tenantId: '9604',
    cardId: 'gp04-sc',
    assetId: 'gp04-asset',
    cardGuidance: 'direct-response offer card, oversized benefit headline, checklist mockup, bright CTA, proof badge, arrow toward CTA',
    cardNegative: 'no subtle editorial layout, no vague brand manifesto, no tiny CTA, no lifestyle-first composition',
    expectedInclude: ['direct-response offer card', 'oversized benefit headline', 'proof badge'],
    expectedExclude: ['obsidian charcoal', 'founder-recorded UGC', 'warm off-white negative space'],
    expectedNegative: ['no subtle editorial layout', 'no tiny CTA'],
  },
  {
    name: 'golden-profile-05-premium-sparse-editorial',
    brandName: 'Atelier Vale',
    tenantId: '9605',
    cardId: 'gp05-sc',
    assetId: 'gp05-asset',
    cardGuidance: 'premium sparse editorial, warm off-white negative space, one calm home vignette, refined serif headline, understated CTA',
    cardNegative: 'no cluttered layouts, no sale badges, no cartoon icons, no loud colors, no starburst offers',
    expectedInclude: ['premium sparse editorial', 'warm off-white negative space', 'refined serif headline'],
    expectedExclude: ['oversized simple shapes', 'founder-recorded UGC', 'direct-response offer card'],
    expectedNegative: ['no cluttered layouts', 'no sale badges'],
  },
  {
    name: 'golden-profile-06-local-friendly-practical',
    brandName: 'Maple Street Home Services',
    tenantId: '9606',
    cardId: 'gp06-sc',
    assetId: 'gp06-asset',
    cardGuidance: 'friendly local-business layout, bright real-home crop, readable sans-serif headline, rounded service card, warm daylight, practical next steps',
    cardNegative: 'no luxury fashion styling, no abstract editorial whitespace, no corporate stock handshake, no dark moody palette, no jargon',
    expectedInclude: ['friendly local-business layout', 'bright real-home crop', 'warm daylight'],
    expectedExclude: ['obsidian charcoal', 'saturated coral lemon aqua', 'premium sparse editorial'],
    expectedNegative: ['no luxury fashion styling', 'no dark moody palette'],
  },
];

for (const profile of GOLDEN_PROFILES) {
  test(`golden profile: ${profile.name} - before seeding blocked, after seeding ready`, async () => {
    const ctx = makeTenant(profile.tenantId);

    // BEFORE: no memory
    const dbBefore = makeDb({
      businessProfiles: [makeProfile(profile.brandName)],
      styleCards: [],
      creativeAssets: [],
      marketPatternNotes: [],
    });
    const previewBefore = await compilePromptPreview(ctx, dbBefore, BASE_BRIEF);
    assert.equal(previewBefore.contextPack.status, 'insufficient_memory', `${profile.name}: should be blocked before seeding`);
    assert.equal(previewBefore.canGenerate, false);

    // AFTER: seed profile preferences
    const card = makeStyleCard(profile.cardId, profile.tenantId, 0.9, {
      prompt_guidance: profile.cardGuidance,
      negative_guidance: profile.cardNegative,
    });
    const asset = makeApprovedAsset(profile.assetId, profile.tenantId);
    const dbAfter = makeDb({
      businessProfiles: [makeProfile(profile.brandName)],
      styleCards: [card],
      creativeAssets: [asset],
      marketPatternNotes: [],
    });

    const previewAfter = await compilePromptPreview(ctx, dbAfter, BASE_BRIEF);
    assert.equal(previewAfter.contextPack.status, 'ready', `${profile.name}: should be ready after seeding`);
    assert.equal(previewAfter.canGenerate, true);

    // Expected style card id selected
    const selectedCardIds = previewAfter.contextPack.selectedStyleCards.map((c) => c.id);
    assert.ok(selectedCardIds.includes(profile.cardId), `${profile.name}: expected card ${profile.cardId} to be selected`);

    // Expected asset id selected
    const selectedAssetIds = previewAfter.contextPack.selectedExamples.map((e) => e.id);
    assert.ok(selectedAssetIds.includes(profile.assetId), `${profile.name}: expected asset ${profile.assetId} to be selected`);

    // Expected included prompt phrases
    for (const phrase of profile.expectedInclude) {
      assert.ok(previewAfter.compiledPrompt.includes(phrase), `${profile.name}: compiledPrompt must include "${phrase}"`);
    }

    // Expected excluded phrases (from other profiles)
    for (const phrase of profile.expectedExclude) {
      assert.ok(!previewAfter.compiledPrompt.includes(phrase), `${profile.name}: compiledPrompt must NOT include "${phrase}" (from another profile)`);
    }

    // Expected negative guidance phrases
    for (const phrase of profile.expectedNegative) {
      assert.ok(previewAfter.negativePrompt.includes(phrase), `${profile.name}: negativePrompt must include "${phrase}"`);
    }
  });
}
