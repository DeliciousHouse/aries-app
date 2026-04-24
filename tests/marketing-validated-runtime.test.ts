import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

async function withRuntimeEnv<T>(run: (input: { dataRoot: string; workdir: string }) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousAllowTmpRuntimePersistence = process.env.ALLOW_TMP_RUNTIME_PERSISTENCE;
  const previousStage1CacheDir = process.env.LOBSTER_STAGE1_CACHE_DIR;
  const previousStage2CacheDir = process.env.LOBSTER_STAGE2_CACHE_DIR;
  const previousStage3CacheDir = process.env.LOBSTER_STAGE3_CACHE_DIR;
  const previousStage4CacheDir = process.env.LOBSTER_STAGE4_CACHE_DIR;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-validated-runtime-'));
  const workdir = await mkdtemp(path.join(tmpdir(), 'aries-validated-workdir-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.ALLOW_TMP_RUNTIME_PERSISTENCE = '1';
  process.env.LOBSTER_STAGE1_CACHE_DIR = path.join(dataRoot, 'lobster-stage1-cache');
  process.env.LOBSTER_STAGE2_CACHE_DIR = path.join(dataRoot, 'lobster-stage2-cache');
  process.env.LOBSTER_STAGE3_CACHE_DIR = path.join(dataRoot, 'lobster-stage3-cache');
  process.env.LOBSTER_STAGE4_CACHE_DIR = path.join(dataRoot, 'lobster-stage4-cache');

  try {
    return await run({ dataRoot, workdir });
  } finally {
    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = previousCodeRoot;
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (previousAllowTmpRuntimePersistence === undefined) delete process.env.ALLOW_TMP_RUNTIME_PERSISTENCE;
    else process.env.ALLOW_TMP_RUNTIME_PERSISTENCE = previousAllowTmpRuntimePersistence;
    if (previousStage1CacheDir === undefined) delete process.env.LOBSTER_STAGE1_CACHE_DIR;
    else process.env.LOBSTER_STAGE1_CACHE_DIR = previousStage1CacheDir;
    if (previousStage2CacheDir === undefined) delete process.env.LOBSTER_STAGE2_CACHE_DIR;
    else process.env.LOBSTER_STAGE2_CACHE_DIR = previousStage2CacheDir;
    if (previousStage3CacheDir === undefined) delete process.env.LOBSTER_STAGE3_CACHE_DIR;
    else process.env.LOBSTER_STAGE3_CACHE_DIR = previousStage3CacheDir;
    if (previousStage4CacheDir === undefined) delete process.env.LOBSTER_STAGE4_CACHE_DIR;
    else process.env.LOBSTER_STAGE4_CACHE_DIR = previousStage4CacheDir;

    await rm(dataRoot, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  }
}

function runScript(input: {
  scriptName: string;
  args?: string[];
  stdinJson: Record<string, unknown>;
  dataRoot: string;
  workdir: string;
}) {
  return spawnSync(
    'python3',
    [path.join(PROJECT_ROOT, 'lobster', 'bin', input.scriptName), ...(input.args ?? [])],
    {
      cwd: input.workdir,
      env: {
        ...process.env,
        CODE_ROOT: PROJECT_ROOT,
        DATA_ROOT: input.dataRoot,
        ALLOW_TMP_RUNTIME_PERSISTENCE: '1',
        LOBSTER_STAGE1_CACHE_DIR: path.join(input.dataRoot, 'lobster-stage1-cache'),
        LOBSTER_STAGE2_CACHE_DIR: path.join(input.dataRoot, 'lobster-stage2-cache'),
        LOBSTER_STAGE3_CACHE_DIR: path.join(input.dataRoot, 'lobster-stage3-cache'),
        LOBSTER_STAGE4_CACHE_DIR: path.join(input.dataRoot, 'lobster-stage4-cache'),
      },
      input: `${JSON.stringify(input.stdinJson)}\n`,
      encoding: 'utf8',
    },
  );
}

test('brand-profile contract persists to validated runtime store and syncs present business-profile fields', async () => {
  await withRuntimeEnv(async ({ dataRoot, workdir }) => {
    const tenantId = 'public_sugarandleather-com';
    const tenantDir = path.join(dataRoot, 'generated', 'validated', tenantId);
    const websiteAnalysisPath = path.join(tenantDir, 'website-analysis.json');
    const brandKitPath = path.join(tenantDir, 'brand-kit.json');
    await mkdir(tenantDir, { recursive: true });
    await writeFile(
      brandKitPath,
      JSON.stringify({
        tenant_id: tenantId,
        source_url: 'https://sugarandleather.com/',
        canonical_url: 'https://sugarandleather.com/',
        brand_name: 'Sugar & Leather',
        logo_urls: [],
        colors: { primary: '#111111', secondary: '#ffffff', accent: '#d4a94f', palette: ['#111111'] },
        font_families: ['Manrope'],
        external_links: [],
        extracted_at: '2026-03-31T00:00:00+00:00',
        brand_voice_summary: 'Warm and direct.',
        offer_summary: 'Book a consult.',
      }),
      'utf8',
    );
    await writeFile(
      websiteAnalysisPath,
      JSON.stringify({
        schema_version: '2026-03-31.website-analysis.v1',
        type: 'website_analysis',
        tenant_id: tenantId,
      }),
      'utf8',
    );

    const result = runScript({
      scriptName: 'brand-profile-db-contract',
      args: ['--json', '--brand-slug', tenantId],
      dataRoot,
      workdir,
      stdinJson: {
        run_id: 'betterup-247ee49a',
        generated_at: '2026-03-31T00:00:00+00:00',
        validated_website_analysis_path: websiteAnalysisPath,
        brand_analysis: {
          tenant_id: tenantId,
          brand_name: 'Sugar & Leather',
          brand_slug: 'public-sugarandleather-com',
          website_url: 'https://sugarandleather.com/',
          canonical_url: 'https://sugarandleather.com/',
          competitor_url: 'https://betterup.com/',
          audience: 'Women rebuilding self-trust after controlling relationships.',
          positioning: 'Private coaching that helps clients recover clarity and self-trust without performative wellness language.',
          problem_statement: 'When someone has spent years adapting to control, even basic decisions can feel unsafe.',
          offer: 'Book a private Sugar & Leather consult to rebuild self-trust with direct expert support.',
          primary_cta: 'Book a consult',
          proof_points: [
            'Private coaching designed around real-world emotional recovery.',
            'A direct, personal tone that avoids generic empowerment slogans.',
            'A clear next step that moves visitors from resonance to consultation.',
          ],
          brand_voice: ['direct', 'warm', 'grounded'],
          channel_specific_angles: {
            meta: 'Lead with the emotional cost of second-guessing yourself after control.',
            'landing-page': 'Reassure the visitor that clarity and self-trust can be rebuilt with guided support.',
            video: 'Open on the internal confusion and pivot to a clear path forward through private coaching.',
          },
          hooks: {
            meta: ['Stop apologizing for needing clarity after control.', 'You are not too much. You are still recovering.'],
            'landing-page': ['Rebuild self-trust without shrinking yourself.', 'Private coaching for life after control.'],
            video: ['You can trust yourself again after control.', 'The confusion is real. So is the way out.'],
          },
          opening_lines: {
            meta: ['The aftermath of control can make every choice feel dangerous.'],
            'landing-page': ['Sugar & Leather helps you rebuild self-trust with direct private coaching.'],
            video: ['When control has shaped your choices, even calm can feel unfamiliar.', 'You can rebuild self-trust without pretending the damage was small.'],
          },
          business_type: 'coaching',
          primary_goal: 'Book more consults',
          launch_approver_name: 'Riley Operator',
          channels: ['meta-ads', 'landing-page', 'video'],
        },
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const stdout = JSON.parse(result.stdout) as Record<string, any>;
    const brandProfilePath = path.join(tenantDir, 'brand-profile.json');
    const businessProfilePath = path.join(tenantDir, 'business-profile.json');
    const persistedBrandProfile = JSON.parse(await readFile(brandProfilePath, 'utf8')) as Record<string, any>;
    const persistedBusinessProfile = JSON.parse(await readFile(businessProfilePath, 'utf8')) as Record<string, any>;

    assert.equal(stdout.persistence.backend, 'runtime-validated-store');
    assert.equal(stdout.validated_brand_profile_path, brandProfilePath);
    assert.equal(stdout.validated_website_analysis_path, websiteAnalysisPath);
    assert.equal(stdout.persistence.business_profile_path, businessProfilePath);
    assert.equal(stdout.validated_brand_profile_path.includes('/generated/validated/'), true);
    assert.equal(stdout.validated_brand_profile_path.includes('/lobster-stage'), false);
    assert.equal(stdout.validated_website_analysis_path.includes('/generated/validated/'), true);
    assert.equal(stdout.validated_website_analysis_path.includes('/lobster-stage'), false);
    assert.equal(persistedBrandProfile.brand_name, 'Sugar & Leather');
    assert.equal(persistedBrandProfile.creative_handoff.primary_cta, 'Book a consult');
    assert.deepEqual(persistedBrandProfile.proof_points.length, 3);
    assert.equal(persistedBusinessProfile.business_name, 'Sugar & Leather');
    assert.equal(persistedBusinessProfile.website_url, 'https://sugarandleather.com/');
    assert.equal(persistedBusinessProfile.competitor_url, 'https://betterup.com/');
    assert.equal(persistedBusinessProfile.offer, 'Book a private Sugar & Leather consult to rebuild self-trust with direct expert support.');
    assert.equal(persistedBusinessProfile.business_type, 'coaching');
    assert.equal(persistedBusinessProfile.primary_goal, 'Book more consults');
    assert.equal(persistedBusinessProfile.launch_approver_name, 'Riley Operator');
    assert.deepEqual(persistedBusinessProfile.channels, ['meta-ads', 'landing-page', 'video']);
  });
});

test('validated profile snapshot reads brand/profile docs in the required precedence order', async () => {
  await withRuntimeEnv(async ({ dataRoot }) => {
    const tenantId = 'tenant_precedence';
    const tenantDir = path.join(dataRoot, 'generated', 'validated', tenantId);
    await mkdir(tenantDir, { recursive: true });
    await writeFile(
      path.join(tenantDir, 'brand-profile.json'),
      JSON.stringify({
        brand_name: 'Brand Profile Name',
        brand_slug: 'brand-profile-name',
        website_url: 'https://brand-profile.example/',
        offer: 'Offer from brand profile',
        creative_handoff: {
          brand_name: 'Brand Profile Name',
          primary_cta: 'Apply now',
        },
      }),
      'utf8',
    );
    await writeFile(
      path.join(tenantDir, 'website-analysis.json'),
      JSON.stringify({
        brand_analysis: {
          brand_name: 'Website Analysis Name',
          audience: 'Audience from website analysis',
          positioning: 'Positioning from website analysis',
          problem_statement: 'Problem from website analysis',
          proof_points: ['Proof one from website analysis', 'Proof two from website analysis', 'Proof three from website analysis'],
          primary_cta: 'Website CTA',
        },
      }),
      'utf8',
    );
    await writeFile(
      path.join(tenantDir, 'business-profile.json'),
      JSON.stringify({
        business_name: 'Business Profile Name',
        business_type: 'consulting',
        primary_goal: 'Grow pipeline',
        launch_approver_name: 'Taylor Approver',
        channels: ['meta-ads'],
        competitor_url: 'https://competitor.example/',
      }),
      'utf8',
    );
    await writeFile(
      path.join(tenantDir, 'brand-kit.json'),
      JSON.stringify({
        brand_name: 'Brand Kit Name',
        source_url: 'https://brand-kit.example/',
      }),
      'utf8',
    );

    const { loadValidatedMarketingProfileSnapshot } = await import('../backend/marketing/validated-profile-store');
    const snapshot = await loadValidatedMarketingProfileSnapshot(tenantId);

    assert.equal(snapshot.brandName, 'Brand Profile Name');
    assert.equal(snapshot.websiteUrl, 'https://brand-profile.example/');
    assert.equal(snapshot.offer, 'Offer from brand profile');
    assert.equal(snapshot.audience, 'Audience from website analysis');
    assert.equal(snapshot.positioning, 'Positioning from website analysis');
    assert.equal(snapshot.problemStatement, 'Problem from website analysis');
    assert.equal(snapshot.primaryCta, 'Apply now');
    assert.deepEqual(snapshot.proofPoints, [
      'Proof one from website analysis',
      'Proof two from website analysis',
      'Proof three from website analysis',
    ]);
    assert.equal(snapshot.businessType, 'consulting');
    assert.equal(snapshot.primaryGoal, 'Grow pipeline');
    assert.equal(snapshot.launchApproverName, 'Taylor Approver');
    assert.deepEqual(snapshot.channels, ['meta-ads']);
    assert.equal(snapshot.competitorUrl, 'https://competitor.example/');
    assert.equal(snapshot.docs.paths.brandProfile, path.join(tenantDir, 'brand-profile.json'));
    assert.equal(snapshot.docs.paths.websiteAnalysis, path.join(tenantDir, 'website-analysis.json'));
    assert.equal(snapshot.docs.paths.businessProfile, path.join(tenantDir, 'business-profile.json'));
    assert.equal(snapshot.docs.paths.brandKit, path.join(tenantDir, 'brand-kit.json'));
  });
});

test('stage 3 scripts hard-fail when wrapper language reaches final creative fields', async () => {
  await withRuntimeEnv(async ({ dataRoot, workdir }) => {
    const result = runScript({
      scriptName: 'scriptwriter',
      args: ['--json', '--brand-slug', 'public_sugarandleather-com'],
      dataRoot,
      workdir,
      stdinJson: {
        run_id: 'betterup-247ee49a',
        production_brief: {
          campaign_name: 'public-sugarandleather-com-stage2-plan',
          core_message: 'You can trust yourself again after control.',
          offer_summary: 'Book a private consult with Sugar & Leather to rebuild self-trust.',
          problem_statement: 'Based on the brand data and competitive landscape analysis.',
          primary_cta: 'Book a consult',
          proof_points: [
            'Private coaching designed around emotional recovery.',
            'Direct, non-generic language that respects the stakes.',
            'A clear consultation step that moves the visitor forward.',
          ],
          creative_handoff: {
            hooks: {
              meta: ['You can trust yourself again after control.'],
              'landing-page': ['Rebuild self-trust without shrinking yourself.'],
              video: ['You can trust yourself again after control.'],
            },
            opening_lines: {
              meta: ['The aftermath of control can make every choice feel dangerous.'],
              'landing-page': ['Sugar & Leather helps you rebuild self-trust with direct private coaching.'],
              video: ['When control has shaped your choices, even calm can feel unfamiliar.'],
            },
          },
        },
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /quality_gate_failed:script\.problem_statement|quality_gate_failed/);
  });
});
