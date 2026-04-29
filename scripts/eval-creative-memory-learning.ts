/**
 * Creative Memory Learning Eval Script
 * Deterministic local eval — no external API calls.
 * Reports before/after prompt personalization for each golden profile.
 *
 * Usage: npm run eval:creative-memory-learning
 */
import { compilePromptPreview } from '../backend/creative-memory/promptCompiler';
import type { QueryClient, QueryResult } from '../backend/creative-memory/profileContext';
import type { CreativeMemoryBrief } from '../types/creative-memory';

// ---------------------------------------------------------------------------
// Minimal fake DB (identical logic to test helpers, self-contained)
// ---------------------------------------------------------------------------
interface FakeDbTables {
  businessProfiles?: Record<string, unknown>[];
  styleCards?: Record<string, unknown>[];
  creativeAssets?: Record<string, unknown>[];
  marketPatternNotes?: Record<string, unknown>[];
}

function makeDb(tables: FakeDbTables): QueryClient {
  const rows = {
    businessProfiles: tables.businessProfiles ?? [],
    styleCards: tables.styleCards ?? [],
    creativeAssets: tables.creativeAssets ?? [],
    marketPatternNotes: tables.marketPatternNotes ?? [],
  };
  return {
    async query<Row = Record<string, unknown>>(sql: string): Promise<QueryResult<Row>> {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.includes('FROM business_profiles')) return { rows: rows.businessProfiles as Row[] };
      if (s.includes('FROM style_cards')) return { rows: rows.styleCards as Row[] };
      if (s.includes('FROM creative_assets') && s.startsWith('SELECT *') && s.includes('usable_for_generation')) {
        return {
          rows: rows.creativeAssets.filter((r) => {
            const st = String(r.source_type ?? '');
            const ps = String(r.permission_scope ?? '');
            return r.usable_for_generation === true
              && st !== 'competitor_meta_ad' && ps !== 'public_ad_library'
              && ['owned_instagram','owned_facebook','owned_meta_ad','generated_by_aries'].includes(st)
              && ['owned','generated'].includes(ps)
              && r.learning_lifecycle === 'approved_for_generation';
          }) as Row[],
        };
      }
      if (s.includes('FROM creative_assets') && s.startsWith('SELECT id,')) {
        return {
          rows: rows.creativeAssets.filter((r) => {
            const st = String(r.source_type ?? '');
            const ps = String(r.permission_scope ?? '');
            const lc = String(r.learning_lifecycle ?? '');
            return st === 'competitor_meta_ad' || ps === 'public_ad_library'
              || lc !== 'approved_for_generation' || r.usable_for_generation === false;
          }) as Row[],
        };
      }
      if (s.includes('FROM creative_assets')) return { rows: rows.creativeAssets as Row[] };
      if (s.includes('FROM market_pattern_notes')) return { rows: rows.marketPatternNotes as Row[] };
      return { rows: [] };
    },
  };
}

function makeTenant(id: string) {
  return { tenantId: id, tenantSlug: `eval-tenant-${id}`, userId: `eval-user-${id}`, role: 'tenant_admin' } as const;
}

const BASE_BRIEF: CreativeMemoryBrief = {
  objective: 'Increase trial sign-ups',
  platform: 'meta',
  placement: 'feed',
  aspectRatio: '1:1',
  funnelStage: 'awareness',
  offer: '14-day free trial',
  audience: 'Target audience',
  creativeType: 'static_image',
  cta: 'Learn More',
  imageText: ['Learn More'],
  mustAvoidAesthetics: ['stock photography'],
};

// ---------------------------------------------------------------------------
// Golden profiles (same 6 as tests)
// ---------------------------------------------------------------------------
const PROFILES = [
  { name: 'dark-luxury',          brand: 'Nocturne Skin',              tid: '9601', guidance: 'dark premium product hero, obsidian charcoal, soft rim lighting, champagne-gold accent',  negative: 'no bright candy colors, no cluttered prop spreads', include: ['dark premium product hero'], exclude: ['bright saturated coral'] },
  { name: 'bright-playful-dtc',   brand: 'PopGlow Lab',                tid: '9602', guidance: 'saturated coral lemon aqua color blocking, oversized simple shapes, bold product-first layout', negative: 'no black luxury minimalism, no muted beige palettes', include: ['saturated coral lemon aqua'], exclude: ['obsidian charcoal'] },
  { name: 'founder-led-ugc',      brand: 'Northstar Ops Lab',          tid: '9603', guidance: 'founder-recorded UGC look, handheld desk selfie, natural light, unpolished crop',         negative: 'no polished studio lighting, no corporate stock people', include: ['founder-recorded UGC look'], exclude: ['dark premium product hero'] },
  { name: 'direct-response',      brand: 'SprintStack',                tid: '9604', guidance: 'direct-response offer card, oversized benefit headline, checklist mockup, proof badge',     negative: 'no subtle editorial layout, no tiny CTA', include: ['direct-response offer card'], exclude: ['founder-recorded UGC'] },
  { name: 'premium-editorial',    brand: 'Atelier Vale',               tid: '9605', guidance: 'premium sparse editorial, warm off-white negative space, refined serif headline',            negative: 'no cluttered layouts, no sale badges', include: ['premium sparse editorial'], exclude: ['oversized simple shapes'] },
  { name: 'local-friendly',       brand: 'Maple Street Home Services', tid: '9606', guidance: 'friendly local-business layout, bright real-home crop, readable sans-serif headline',        negative: 'no luxury fashion styling, no dark moody palette', include: ['friendly local-business layout'], exclude: ['obsidian charcoal'] },
];

// ---------------------------------------------------------------------------
// Eval runner
// ---------------------------------------------------------------------------
interface ProfileResult {
  profile: string;
  brand: string;
  beforeStatus: string;
  afterStatus: string;
  canGenerate: boolean;
  selectedCardIds: string[];
  selectedAssetIds: string[];
  includedChecks: Array<{ phrase: string; pass: boolean }>;
  excludedChecks: Array<{ phrase: string; pass: boolean }>;
  negativeCheck: { phrase: string; pass: boolean };
  pass: boolean;
}

async function evalProfile(p: typeof PROFILES[0]): Promise<ProfileResult> {
  const ctx = makeTenant(p.tid);

  const dbBefore = makeDb({ businessProfiles: [{ business_name: p.brand }], styleCards: [], creativeAssets: [], marketPatternNotes: [] });
  const previewBefore = await compilePromptPreview(ctx, dbBefore, BASE_BRIEF);

  const card = { id: `${p.name}-sc`, tenant_id: p.tid, name: `${p.name} style`, status: 'active', confidence_score: 0.9, prompt_guidance: p.guidance, negative_guidance: p.negative, visual_dna: '', copy_dna: '', updated_at: new Date().toISOString() };
  const asset = { id: `${p.name}-asset`, tenant_id: p.tid, source_type: 'owned_instagram', permission_scope: 'owned', learning_lifecycle: 'approved_for_generation', usable_for_generation: true, served_asset_ref: '/materials/assets/img.jpg', media_type: 'image', exact_image_text: ['Learn More'], created_at: new Date().toISOString() };
  const dbAfter = makeDb({ businessProfiles: [{ business_name: p.brand }], styleCards: [card], creativeAssets: [asset], marketPatternNotes: [] });
  const previewAfter = await compilePromptPreview(ctx, dbAfter, BASE_BRIEF);

  const includedChecks = p.include.map((phrase) => ({ phrase, pass: previewAfter.compiledPrompt.includes(phrase) }));
  const excludedChecks = p.exclude.map((phrase) => ({ phrase, pass: !previewAfter.compiledPrompt.includes(phrase) }));
  const negativeCheck = { phrase: p.negative.split(',')[0], pass: previewAfter.negativePrompt.includes(p.negative.split(',')[0]) };

  const pass = previewBefore.contextPack.status === 'insufficient_memory'
    && previewAfter.contextPack.status === 'ready'
    && previewAfter.canGenerate
    && includedChecks.every((c) => c.pass)
    && excludedChecks.every((c) => c.pass)
    && negativeCheck.pass;

  return {
    profile: p.name,
    brand: p.brand,
    beforeStatus: previewBefore.contextPack.status,
    afterStatus: previewAfter.contextPack.status,
    canGenerate: previewAfter.canGenerate,
    selectedCardIds: previewAfter.contextPack.selectedStyleCards.map((c) => c.id),
    selectedAssetIds: previewAfter.contextPack.selectedExamples.map((e) => e.id),
    includedChecks,
    excludedChecks,
    negativeCheck,
    pass,
  };
}

async function main() {
  console.log('# Creative Memory Learning Eval\n');
  const results: ProfileResult[] = [];
  for (const profile of PROFILES) {
    const result = await evalProfile(profile);
    results.push(result);
  }

  for (const r of results) {
    const status = r.pass ? 'PASS' : 'FAIL';
    console.log(`## ${r.profile} (${r.brand}) — ${status}`);
    console.log(`  Before: ${r.beforeStatus} | After: ${r.afterStatus} | canGenerate: ${r.canGenerate}`);
    console.log(`  Selected cards: [${r.selectedCardIds.join(', ')}]`);
    console.log(`  Selected assets: [${r.selectedAssetIds.join(', ')}]`);
    for (const c of r.includedChecks) console.log(`  [include ${c.pass ? '✓' : '✗'}] "${c.phrase}"`);
    for (const c of r.excludedChecks) console.log(`  [exclude ${c.pass ? '✓' : '✗'}] "${c.phrase}"`);
    console.log(`  [negative ${r.negativeCheck.pass ? '✓' : '✗'}] "${r.negativeCheck.phrase}"`);
    console.log();
  }

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  console.log(`## Summary: ${passed}/${total} profiles PASS`);
  console.log(JSON.stringify({ total, passed, failed: total - passed, results }, null, 2));

  if (passed < total) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
