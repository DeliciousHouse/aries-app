import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

type IdentityFixture = {
  websiteUrl: string;
  canonicalUrl: string;
  brandName: string;
  audience: string;
  positioning: string;
  problemStatement: string;
  offer: string;
  primaryCta: string;
  proofPoints: string[];
  brandVoice: string[];
  landingHook: string;
};

async function withRuntimeEnv<T>(run: (input: { dataRoot: string; workdir: string }) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousAllowTmpRuntimePersistence = process.env.ALLOW_TMP_RUNTIME_PERSISTENCE;
  const previousStage1CacheDir = process.env.LOBSTER_STAGE1_CACHE_DIR;
  const previousStage2CacheDir = process.env.LOBSTER_STAGE2_CACHE_DIR;
  const previousStage3CacheDir = process.env.LOBSTER_STAGE3_CACHE_DIR;
  const previousStage4CacheDir = process.env.LOBSTER_STAGE4_CACHE_DIR;
  const previousOpenClawLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-brand-identity-'));
  const workdir = await mkdtemp(path.join(tmpdir(), 'aries-brand-identity-workdir-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.OPENCLAW_LOBSTER_CWD = path.join(PROJECT_ROOT, 'lobster');
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
    if (previousOpenClawLobsterCwd === undefined) delete process.env.OPENCLAW_LOBSTER_CWD;
    else process.env.OPENCLAW_LOBSTER_CWD = previousOpenClawLobsterCwd;
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
        OPENCLAW_LOBSTER_CWD: path.join(PROJECT_ROOT, 'lobster'),
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

function fakeTenantClient() {
  return {
    async query() {
      return {
        rowCount: 1,
        rows: [{ id: 11, name: 'Brand Ops', slug: 'brand-ops' }],
      };
    },
  };
}

function identityShape(value: Record<string, any> | null | undefined) {
  return {
    summary: value?.summary ?? null,
    positioning: value?.positioning ?? null,
    audience: value?.audience ?? null,
    offer: value?.offer ?? null,
    promise: value?.promise ?? null,
    toneOfVoice: value?.toneOfVoice ?? null,
    styleVibe: value?.styleVibe ?? null,
    ctaStyle: value?.ctaStyle ?? null,
    proofStyle: value?.proofStyle ?? null,
    sourceFingerprint:
      value?.provenance?.source_fingerprint ??
      value?.provenance?.sourceFingerprint ??
      null,
  };
}

async function seedCurrentSourceIdentity(input: {
  dataRoot: string;
  workdir: string;
  tenantId: string;
  jobId: string;
  fixture: IdentityFixture;
}) {
  const tenantDir = path.join(input.dataRoot, 'generated', 'validated', input.tenantId);
  const runtimeFile = path.join(input.dataRoot, 'generated', 'draft', 'marketing-jobs', `${input.jobId}.json`);
  const websiteAnalysisPath = path.join(tenantDir, 'website-analysis.json');
  const brandKitPath = path.join(tenantDir, 'brand-kit.json');

  await mkdir(tenantDir, { recursive: true });
  await mkdir(path.dirname(runtimeFile), { recursive: true });
  await writeFile(
    brandKitPath,
    JSON.stringify({
      tenant_id: input.tenantId,
      source_url: input.fixture.websiteUrl,
      canonical_url: input.fixture.canonicalUrl,
      brand_name: input.fixture.brandName,
      logo_urls: [`${input.fixture.canonicalUrl.replace(/\/$/, '')}/assets/logo.svg`],
      colors: { primary: '#111111', secondary: '#f4f4f4', accent: '#c24d2c', palette: ['#111111', '#f4f4f4', '#c24d2c'] },
      font_families: ['Manrope'],
      external_links: [{ platform: 'instagram', url: `${input.fixture.canonicalUrl.replace(/\/$/, '')}/instagram` }],
      extracted_at: '2026-04-06T00:00:00.000Z',
      brand_voice_summary: `${input.fixture.brandVoice.join(', ')}.`,
      offer_summary: input.fixture.offer,
    }, null, 2),
    'utf8',
  );
  await writeFile(
    websiteAnalysisPath,
    JSON.stringify({
      schema_version: '2026-04-06.website-analysis.v1',
      type: 'website_analysis',
      tenant_id: input.tenantId,
      brand_analysis: {
        tenant_id: input.tenantId,
        brand_name: input.fixture.brandName,
        website_url: input.fixture.websiteUrl,
        canonical_url: input.fixture.canonicalUrl,
        audience: input.fixture.audience,
        audience_summary: input.fixture.audience,
        positioning: input.fixture.positioning,
        positioning_summary: input.fixture.positioning,
        problem_statement: input.fixture.problemStatement,
        offer: input.fixture.offer,
        offer_summary: input.fixture.offer,
        brand_promise: input.fixture.landingHook,
        primary_cta: input.fixture.primaryCta,
        cta_preferences: [input.fixture.primaryCta],
        proof_points: input.fixture.proofPoints,
        brand_voice: input.fixture.brandVoice,
        hooks: {
          'landing-page': [input.fixture.landingHook],
        },
      },
    }, null, 2),
    'utf8',
  );

  const brandProfileResult = runScript({
    scriptName: 'brand-profile-db-contract',
    args: ['--json', '--brand-slug', input.tenantId],
    dataRoot: input.dataRoot,
    workdir: input.workdir,
    stdinJson: {
      run_id: `stage2-${input.jobId}`,
      generated_at: '2026-04-06T00:00:00.000Z',
      validated_website_analysis_path: websiteAnalysisPath,
      brand_analysis: {
        tenant_id: input.tenantId,
        brand_name: input.fixture.brandName,
        brand_slug: input.tenantId,
        website_url: input.fixture.websiteUrl,
        canonical_url: input.fixture.canonicalUrl,
        competitor_url: 'https://betterup.com/',
        audience: input.fixture.audience,
        positioning: input.fixture.positioning,
        problem_statement: input.fixture.problemStatement,
        offer: input.fixture.offer,
        primary_cta: input.fixture.primaryCta,
        proof_points: input.fixture.proofPoints,
        brand_voice: input.fixture.brandVoice,
        channel_specific_angles: {
          meta: 'Lead with direct proof.',
          'landing-page': 'Translate the offer into a concrete next step.',
          video: 'Open with the pain and close with a clear promise.',
        },
        hooks: {
          meta: [input.fixture.landingHook],
          'landing-page': [input.fixture.landingHook],
          video: [input.fixture.landingHook],
        },
        opening_lines: {
          meta: [input.fixture.landingHook],
          'landing-page': [input.fixture.landingHook],
          video: [input.fixture.landingHook],
        },
        business_type: 'coaching',
        primary_goal: 'Book more calls',
        launch_approver_name: 'Riley Approver',
        channels: ['meta-ads', 'landing-page', 'video'],
        brand_kit: JSON.parse(await readFile(brandKitPath, 'utf8')),
      },
    },
  });

  assert.equal(brandProfileResult.status, 0, brandProfileResult.stderr);
  const brandProfilePayload = JSON.parse(brandProfileResult.stdout) as Record<string, any>;
  const persistedBrandProfile = JSON.parse(
    await readFile(String(brandProfilePayload.validated_brand_profile_path), 'utf8'),
  ) as Record<string, any>;

  await writeFile(
    runtimeFile,
    JSON.stringify({
      schema_name: 'marketing_job_state_schema',
      schema_version: '1.0.0',
      job_id: input.jobId,
      job_type: 'brand_campaign',
      tenant_id: input.tenantId,
      state: 'approval_required',
      status: 'awaiting_approval',
      current_stage: 'production',
      stage_order: ['research', 'strategy', 'production', 'publish'],
      stages: {
        research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-research', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-strategy', summary: null, primary_output: { run_id: 'run-strategy' }, outputs: {}, artifacts: [], errors: [] },
        production: { stage: 'production', status: 'awaiting_approval', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: { approval_id: 'mkta_stage3', workflow_step_id: 'approve_stage_3' }, artifacts: [], errors: [] },
        publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      },
      approvals: {
        current: {
          stage: 'production',
          status: 'awaiting_approval',
          approval_id: 'mkta_stage3',
          workflow_name: 'marketing-pipeline',
          workflow_step_id: 'approve_stage_3',
          title: 'Strategy review required',
          message: 'Review the campaign proposal before production begins.',
          requested_at: '2026-04-06T00:00:00.000Z',
          resume_token: 'resume-stage3',
          action_label: 'Review strategy',
          publish_config: null,
        },
        history: [],
      },
      publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
      brand_kit: JSON.parse(await readFile(brandKitPath, 'utf8')),
      inputs: {
        request: {
          brandUrl: input.fixture.websiteUrl,
          websiteUrl: input.fixture.websiteUrl,
          businessName: input.fixture.brandName,
          businessType: 'coaching',
          goal: 'Book more calls',
          offer: input.fixture.offer,
          competitorUrl: 'https://betterup.com/',
          channels: ['meta-ads', 'landing-page', 'video'],
        },
        brand_url: input.fixture.websiteUrl,
        competitor_url: 'https://betterup.com/',
      },
      errors: [],
      last_error: null,
      history: [],
      created_at: '2026-04-06T00:00:00.000Z',
      updated_at: '2026-04-06T00:00:00.000Z',
    }, null, 2),
    'utf8',
  );

  const { ensureCampaignWorkspaceRecord } = await import('../backend/marketing/workspace-store');
  ensureCampaignWorkspaceRecord({
    jobId: input.jobId,
    tenantId: input.tenantId,
    payload: {
      websiteUrl: input.fixture.websiteUrl,
      businessName: input.fixture.brandName,
      businessType: 'coaching',
      goal: 'Book more calls',
      offer: input.fixture.offer,
      competitorUrl: 'https://betterup.com/',
      channels: ['meta-ads', 'landing-page', 'video'],
    },
  });

  return {
    brandProfilePayload,
    persistedBrandProfile,
  };
}

test('canonical brand identity stays in parity across validated snapshot, brand review, business profile, strategy handoff, and stage 3 reuse', async () => {
  await withRuntimeEnv(async ({ dataRoot, workdir }) => {
    const tenantId = '11';
    const jobId = 'mkt_brand_identity_parity';
    const fixture: IdentityFixture = {
      websiteUrl: 'https://sugarandleather.com/',
      canonicalUrl: 'https://sugarandleather.com/',
      brandName: 'Sugar & Leather',
      audience: 'Women rebuilding self-trust after controlling relationships.',
      positioning: 'Private coaching that helps clients recover clarity and self-trust without performative wellness language.',
      problemStatement: 'When someone has spent years adapting to control, even basic decisions can feel unsafe.',
      offer: 'Book a private Sugar & Leather consult to rebuild self-trust with direct expert support.',
      primaryCta: 'Book a consult',
      proofPoints: [
        'Private coaching designed around real-world emotional recovery.',
        'A direct, personal tone that avoids generic empowerment slogans.',
        'A clear next step that moves visitors from resonance to consultation.',
      ],
      brandVoice: ['Direct', 'Warm', 'Grounded'],
      landingHook: 'Rebuild self-trust without shrinking yourself.',
    };

    const { persistedBrandProfile } = await seedCurrentSourceIdentity({
      dataRoot,
      workdir,
      tenantId,
      jobId,
      fixture,
    });

    const { loadValidatedMarketingProfileSnapshot } = await import('../backend/marketing/validated-profile-store');
    const { buildCampaignWorkspaceView } = await import('../backend/marketing/workspace-views');
    const { getBusinessProfile } = await import('../backend/tenant/business-profile');

    const snapshot = loadValidatedMarketingProfileSnapshot(tenantId, {
      currentSourceUrl: fixture.websiteUrl,
    });
    const workspaceView = buildCampaignWorkspaceView(jobId);
    const businessProfile = await getBusinessProfile(fakeTenantClient() as never, tenantId);

    const strategyResult = runScript({
      scriptName: 'head-of-marketing',
      args: ['--json', '--mode', 'finalize', '--brand-slug', tenantId],
      dataRoot,
      workdir,
      stdinJson: {
        run_id: 'run-stage2-finalize',
        brand_profiles_record: persistedBrandProfile,
        creative_handoff: persistedBrandProfile.creative_handoff,
        campaign_plan: {
          campaign_name: 'Sugar & Leather Spring Launch',
          objective: 'Book more consults from proof-led launch messaging.',
          core_message: fixture.landingHook,
          primary_cta: fixture.primaryCta,
          audience: fixture.audience,
          positioning: fixture.positioning,
          problem_statement: fixture.problemStatement,
          offer: fixture.offer,
          proof_points: fixture.proofPoints,
          channel_plans: [{ channel: 'meta', message: 'Lead with direct proof.', cta: fixture.primaryCta }],
          competitor_context: {},
          testing_matrix: {},
          budget_testing_plan: { phases: [] },
        },
      },
    });
    assert.equal(strategyResult.status, 0, strategyResult.stderr);
    const strategyPayload = JSON.parse(strategyResult.stdout) as Record<string, any>;

    const productionResult = runScript({
      scriptName: 'creative-director',
      args: ['--json', '--mode', 'preflight', '--brand-slug', tenantId],
      dataRoot,
      workdir,
      stdinJson: {
        run_id: 'run-stage3-preflight',
        strategy_handoff: strategyPayload.strategy_handoff,
      },
    });
    assert.equal(productionResult.status, 0, productionResult.stderr);
    const productionPayload = JSON.parse(productionResult.stdout) as Record<string, any>;

    const expected = identityShape(snapshot.brandIdentity as Record<string, any>);
    assert.deepEqual(identityShape(workspaceView.brandReview?.brandIdentity as Record<string, any>), expected);
    assert.deepEqual(identityShape(businessProfile.brandIdentity as Record<string, any>), expected);
    assert.deepEqual(identityShape(strategyPayload.strategy_handoff?.brandIdentity as Record<string, any>), expected);
    assert.deepEqual(identityShape(productionPayload.production_brief?.brand_identity as Record<string, any>), expected);
  });
});

test('source switch prevents source A brand identity from surviving in read models and stage reuse', async () => {
  await withRuntimeEnv(async ({ dataRoot, workdir }) => {
    const tenantId = '11';
    const jobId = 'mkt_brand_identity_source_switch';
    const sourceA: IdentityFixture = {
      websiteUrl: 'https://sugarandleather.com/',
      canonicalUrl: 'https://sugarandleather.com/',
      brandName: 'Sugar & Leather',
      audience: 'Women rebuilding self-trust after controlling relationships.',
      positioning: 'Private coaching for rebuilding self-trust after control.',
      problemStatement: 'The aftermath of control leaves every choice feeling unsafe.',
      offer: 'Private recovery coaching for rebuilding self-trust after control.',
      primaryCta: 'Book a consult',
      proofPoints: [
        'Private coaching designed around emotional recovery.',
        'A grounded approach keeps the message calm and credible.',
        'Clear consult-first next steps reduce hesitation for qualified clients.',
      ],
      brandVoice: ['Warm', 'Grounded'],
      landingHook: 'Rebuild self-trust without shrinking yourself.',
    };
    const sourceB: IdentityFixture = {
      websiteUrl: 'https://theframex.com/',
      canonicalUrl: 'https://theframex.com/',
      brandName: 'The Framex',
      audience: 'Homeowners and design-forward teams planning custom framing.',
      positioning: 'Custom framing with modern installation support for fast-moving interiors.',
      problemStatement: 'Clients need clean framing decisions without juggling multiple vendors.',
      offer: 'Custom framing and installation packages for modern interiors.',
      primaryCta: 'Schedule a framing consult',
      proofPoints: [
        'Installation support keeps launches on schedule.',
        'Design-forward framing packages reduce vendor overhead.',
        'Consult-first next steps improve conversion quality.',
      ],
      brandVoice: ['Direct', 'Modern'],
      landingHook: 'Frame the room without slowing the project down.',
    };

    await seedCurrentSourceIdentity({
      dataRoot,
      workdir,
      tenantId,
      jobId,
      fixture: sourceA,
    });
    await seedCurrentSourceIdentity({
      dataRoot,
      workdir,
      tenantId,
      jobId,
      fixture: sourceB,
    });

    const { loadValidatedMarketingProfileSnapshot } = await import('../backend/marketing/validated-profile-store');
    const { buildCampaignWorkspaceView } = await import('../backend/marketing/workspace-views');
    const { getBusinessProfile } = await import('../backend/tenant/business-profile');
    const snapshot = loadValidatedMarketingProfileSnapshot(tenantId, {
      currentSourceUrl: sourceB.websiteUrl,
    });
    const workspaceView = buildCampaignWorkspaceView(jobId);
    const businessProfile = await getBusinessProfile(fakeTenantClient() as never, tenantId);

    const brandProfile = JSON.parse(
      await readFile(path.join(dataRoot, 'generated', 'validated', tenantId, 'brand-profile.json'), 'utf8'),
    ) as Record<string, any>;
    const strategyResult = runScript({
      scriptName: 'head-of-marketing',
      args: ['--json', '--mode', 'finalize', '--brand-slug', tenantId],
      dataRoot,
      workdir,
      stdinJson: {
        run_id: 'run-stage2-source-b',
        brand_profiles_record: brandProfile,
        creative_handoff: brandProfile.creative_handoff,
        campaign_plan: {
          campaign_name: 'The Framex Launch',
          objective: 'Book more framing consults from direct launch messaging.',
          core_message: sourceB.landingHook,
          primary_cta: sourceB.primaryCta,
          audience: sourceB.audience,
          positioning: sourceB.positioning,
          problem_statement: sourceB.problemStatement,
          offer: sourceB.offer,
          proof_points: sourceB.proofPoints,
          channel_plans: [{ channel: 'meta', message: 'Lead with installation speed.', cta: sourceB.primaryCta }],
          competitor_context: {},
          testing_matrix: {},
          budget_testing_plan: { phases: [] },
        },
      },
    });
    assert.equal(strategyResult.status, 0, strategyResult.stderr);
    const strategyPayload = JSON.parse(strategyResult.stdout) as Record<string, any>;
    const productionResult = runScript({
      scriptName: 'creative-director',
      args: ['--json', '--mode', 'preflight', '--brand-slug', tenantId],
      dataRoot,
      workdir,
      stdinJson: {
        run_id: 'run-stage3-source-b',
        strategy_handoff: strategyPayload.strategy_handoff,
      },
    });
    assert.equal(productionResult.status, 0, productionResult.stderr);
    const productionPayload = JSON.parse(productionResult.stdout) as Record<string, any>;

    const expected = identityShape(snapshot.brandIdentity as Record<string, any>);
    const staleNeedles = ['Sugar & Leather', 'sugarandleather.com', 'rebuild self-trust'];
    const currentSummary = JSON.stringify({
      snapshot: snapshot.brandIdentity,
      brandReview: workspaceView.brandReview?.brandIdentity,
      businessProfile: businessProfile.brandIdentity,
      strategy: strategyPayload.strategy_handoff?.brandIdentity,
      production: productionPayload.production_brief?.brand_identity,
    });

    assert.deepEqual(identityShape(workspaceView.brandReview?.brandIdentity as Record<string, any>), expected);
    assert.deepEqual(identityShape(businessProfile.brandIdentity as Record<string, any>), expected);
    assert.deepEqual(identityShape(strategyPayload.strategy_handoff?.brandIdentity as Record<string, any>), expected);
    assert.deepEqual(identityShape(productionPayload.production_brief?.brand_identity as Record<string, any>), expected);
    for (const needle of staleNeedles) {
      assert.equal(currentSummary.includes(needle), false);
    }
  });
});
