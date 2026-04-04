import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const BRAND_SITE_HTML = `<!doctype html>
<html>
  <head>
    <title>Brand Example | Proof-led campaign operations</title>
    <meta property="og:site_name" content="Brand Example" />
    <meta name="description" content="Brand Example helps operators launch and review proof-led campaigns." />
  </head>
  <body>
    <h1>Brand Example</h1>
    <p>Brand Example gives operators visibility and control over campaigns.</p>
  </body>
</html>`;

const BETTERUP_SITE_HTML = `<!doctype html>
<html>
  <head>
    <title>BetterUp | Human transformation at work</title>
    <meta name="description" content="BetterUp helps leaders and teams improve performance through coaching." />
  </head>
  <body>
    <h1>BetterUp</h1>
    <a href="https://www.facebook.com/betterupco">BetterUp on Facebook</a>
    <a href="https://betterup.com/leadership-coaching">Leadership coaching</a>
  </body>
</html>`;

type ScriptResult<T> = {
  payload: T;
  stderr: string;
};

async function withWorkflowEnv<T>(run: (input: {
  rootDir: string;
  dataRoot: string;
  workdir: string;
  env: NodeJS.ProcessEnv;
}) => Promise<T>): Promise<T> {
  const artifactsRoot = path.join(PROJECT_ROOT, '.artifacts');
  await mkdir(artifactsRoot, { recursive: true });
  const rootDir = await mkdtemp(path.join(artifactsRoot, 'marketing-competitor-flow-'));
  const dataRoot = path.join(rootDir, 'data');
  const workdir = path.join(rootDir, 'workdir');
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousAllowTmpRuntimePersistence = process.env.ALLOW_TMP_RUNTIME_PERSISTENCE;
  const previousStage1CacheDir = process.env.LOBSTER_STAGE1_CACHE_DIR;
  const previousStage2CacheDir = process.env.LOBSTER_STAGE2_CACHE_DIR;
  const previousStage3CacheDir = process.env.LOBSTER_STAGE3_CACHE_DIR;
  const previousStage4CacheDir = process.env.LOBSTER_STAGE4_CACHE_DIR;

  await mkdir(dataRoot, { recursive: true });
  await mkdir(workdir, { recursive: true });

  const env = {
    ...process.env,
    CODE_ROOT: PROJECT_ROOT,
    DATA_ROOT: dataRoot,
    ALLOW_TMP_RUNTIME_PERSISTENCE: '1',
    LOBSTER_STAGE1_CACHE_DIR: path.join(rootDir, 'stage1-cache'),
    LOBSTER_STAGE2_CACHE_DIR: path.join(rootDir, 'stage2-cache'),
    LOBSTER_STAGE3_CACHE_DIR: path.join(rootDir, 'stage3-cache'),
    LOBSTER_STAGE4_CACHE_DIR: path.join(rootDir, 'stage4-cache'),
    GEMINI_API_KEY: '',
  };

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.ALLOW_TMP_RUNTIME_PERSISTENCE = '1';
  process.env.LOBSTER_STAGE1_CACHE_DIR = env.LOBSTER_STAGE1_CACHE_DIR;
  process.env.LOBSTER_STAGE2_CACHE_DIR = env.LOBSTER_STAGE2_CACHE_DIR;
  process.env.LOBSTER_STAGE3_CACHE_DIR = env.LOBSTER_STAGE3_CACHE_DIR;
  process.env.LOBSTER_STAGE4_CACHE_DIR = env.LOBSTER_STAGE4_CACHE_DIR;

  try {
    return await run({ rootDir, dataRoot, workdir, env });
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
    await rm(rootDir, { recursive: true, force: true });
  }
}

async function seedValidatedBrandArtifacts(dataRoot: string, tenantId: string): Promise<void> {
  const tenantDir = path.join(dataRoot, 'generated', 'validated', tenantId);
  const now = new Date().toISOString();
  await mkdir(tenantDir, { recursive: true });
  await writeFile(
    path.join(tenantDir, 'brand-kit.json'),
    JSON.stringify({
      tenant_id: tenantId,
      source_url: 'https://brand.example/',
      canonical_url: 'https://brand.example/',
      brand_name: 'Brand Example',
      logo_urls: ['https://brand.example/assets/logo.svg'],
      colors: {
        primary: '#111111',
        secondary: '#f4f4f4',
        accent: '#c24d2c',
        palette: ['#111111', '#f4f4f4', '#c24d2c'],
      },
      font_families: ['Manrope'],
      external_links: [],
      extracted_at: now,
      brand_voice_summary: 'Proof-led and operationally clear.',
      offer_summary: 'Book a walkthrough to launch proof-led campaigns.',
    }, null, 2),
    'utf8',
  );
  await writeFile(
    path.join(tenantDir, 'website-analysis.json'),
    JSON.stringify({
      schema_version: '2026-03-31.website-analysis.v1',
      type: 'website_analysis',
      tenant_id: tenantId,
      brand_analysis: {
        tenant_id: tenantId,
        brand_name: 'Brand Example',
        brand_slug: tenantId,
        website_url: 'https://brand.example/',
        canonical_url: 'https://brand.example/',
        audience: 'Operators who need campaign control and review visibility.',
        positioning: 'A campaign operations system built for review-safe execution.',
        problem_statement: 'Teams lose time and trust when campaign execution is fragmented across tools.',
        offer: 'Book a walkthrough to launch proof-led campaigns with approval visibility.',
        primary_cta: 'Book a walkthrough',
        proof_points: [
          'One workspace for planning, review, production, and launch.',
          'Clear approval checkpoints before campaigns go live.',
          'Operational visibility across strategy, creative, and publishing.',
        ],
        brand_voice: ['direct', 'proof-led', 'operational'],
        channel_specific_angles: {
          meta: 'Lead with operational control and proof-led execution.',
          'landing-page': 'Show how one system removes launch chaos and approval drift.',
          video: 'Open on fragmented execution, then show the controlled workflow.',
        },
        hooks: {
          meta: ['Launch with operator control.', 'Stop losing campaigns to workflow chaos.'],
          'landing-page': ['Proof-led campaign ops, without the scramble.', 'One system for launch-safe execution.'],
          video: ['Campaign execution should not be chaos.', 'Control the workflow before you scale it.'],
        },
        opening_lines: {
          meta: ['Operators need one place to keep launches under control.'],
          'landing-page': ['Brand Example helps operators plan, review, and launch campaigns with approval visibility.'],
          video: ['Campaigns stall when the workflow is fragmented.', 'Approval-safe execution starts with one operating system.'],
        },
        business_type: 'software',
        primary_goal: 'Book more walkthroughs',
        launch_approver_name: 'Avery Operator',
        channels: ['meta', 'landing-page', 'video'],
      },
    }, null, 2),
    'utf8',
  );
}

async function writeWorkflowFixtures(rootDir: string): Promise<{
  searchPath: string;
  stage1SiteFixture: string;
  stage2SiteFixture: string;
}> {
  const searchPath = path.join(rootDir, 'mock-search.sh');
  const searchResults = {
    results: [
      {
        title: 'BetterUp leadership coaching',
        url: 'https://betterup.com/leadership-coaching',
        snippet: 'BetterUp leadership coaching helps leaders improve performance.',
      },
      {
        title: 'BetterUp Facebook page',
        url: 'https://www.facebook.com/betterupco',
        snippet: 'Official BetterUp Facebook page.',
      },
    ],
  };
  await writeFile(
    searchPath,
    ['#!/bin/sh', `printf '%s\\n' '${JSON.stringify(searchResults)}'`].join('\n'),
    'utf8',
  );
  chmodSync(searchPath, 0o755);

  const stage1SiteFixture = path.join(rootDir, 'betterup-site.html');
  const stage2SiteFixture = path.join(rootDir, 'brand-site.html');
  await writeFile(stage1SiteFixture, BETTERUP_SITE_HTML, 'utf8');
  await writeFile(stage2SiteFixture, BRAND_SITE_HTML, 'utf8');

  return { searchPath, stage1SiteFixture, stage2SiteFixture };
}

function runJsonPythonScript<T>(input: {
  scriptName: string;
  args?: string[];
  stdinJson?: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  workdir: string;
}): ScriptResult<T> {
  const result = spawnSync(
    'python3',
    [path.join(PROJECT_ROOT, 'lobster', 'bin', input.scriptName), ...(input.args ?? [])],
    {
      cwd: input.workdir,
      env: input.env,
      input: input.stdinJson ? `${JSON.stringify(input.stdinJson)}\n` : undefined,
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return {
    payload: JSON.parse(result.stdout) as T,
    stderr: result.stderr || '',
  };
}

test('workflow acceptance: betterup competitor website stays canonical through Stage 1 and Stage 2', async () => {
  await withWorkflowEnv(async ({ rootDir, dataRoot, workdir, env }) => {
    const tenantId = 'tenant_betterup_flow';
    await seedValidatedBrandArtifacts(dataRoot, tenantId);
    const fixtures = await writeWorkflowFixtures(rootDir);
    const workflowEnv = {
      ...env,
      LOBSTER_WEB_SEARCH_CMD: fixtures.searchPath,
      LOBSTER_STAGE1_SITE_HTML_FIXTURE: fixtures.stage1SiteFixture,
      LOBSTER_STAGE2_SITE_HTML_FIXTURE: fixtures.stage2SiteFixture,
    };

    const stage1Extract = runJsonPythonScript<Record<string, any>>({
      scriptName: 'meta-ads-extractor',
      args: ['--json', '--competitor-url', 'https://betterup.com'],
      env: workflowEnv,
      workdir,
    });
    const stage1Analysis = runJsonPythonScript<Record<string, any>>({
      scriptName: 'meta-ads-analyser',
      args: ['--json'],
      stdinJson: stage1Extract.payload,
      env: workflowEnv,
      workdir,
    });
    const stage1Creative = runJsonPythonScript<Record<string, any>>({
      scriptName: 'ad-creative-analysis',
      args: ['--json'],
      stdinJson: stage1Analysis.payload,
      env: workflowEnv,
      workdir,
    });
    const stage1Compile = runJsonPythonScript<Record<string, any>>({
      scriptName: 'ads-analyst',
      args: ['--json', '--mode', 'compile'],
      stdinJson: stage1Creative.payload,
      env: workflowEnv,
      workdir,
    });
    const stage2Website = runJsonPythonScript<Record<string, any>>({
      scriptName: 'website-brand-analysis',
      args: ['--json', '--website-url', 'https://brand.example/', '--brand-slug', tenantId],
      stdinJson: stage1Compile.payload,
      env: workflowEnv,
      workdir,
    });
    const stage2Profile = runJsonPythonScript<Record<string, any>>({
      scriptName: 'brand-profile-db-contract',
      args: ['--json', '--brand-slug', tenantId],
      stdinJson: stage2Website.payload,
      env: workflowEnv,
      workdir,
    });
    const stage2Plan = runJsonPythonScript<Record<string, any>>({
      scriptName: 'campaign-planner',
      args: ['--json', '--brand-slug', tenantId],
      stdinJson: stage2Profile.payload,
      env: workflowEnv,
      workdir,
    });
    const stage2Review = runJsonPythonScript<Record<string, any>>({
      scriptName: 'strategy-review-preview',
      args: ['--json', '--brand-slug', tenantId],
      stdinJson: stage2Plan.payload,
      env: workflowEnv,
      workdir,
    });

    const combinedStderr = [
      stage1Extract.stderr,
      stage1Analysis.stderr,
      stage1Creative.stderr,
      stage1Compile.stderr,
      stage2Website.stderr,
      stage2Profile.stderr,
      stage2Plan.stderr,
      stage2Review.stderr,
    ].join('\n');

    assert.equal(stage1Extract.payload.competitorIdentity.canonicalDomain, 'betterup.com');
    assert.ok(['trusted', 'probable', 'override'].includes(stage1Extract.payload.trustValidation.classification));
    assert.equal(stage1Extract.payload.metaLocator.facebookPageUrl, 'https://www.facebook.com/betterupco');
    assert.equal(stage1Compile.payload.stage1_summary.competitorIdentity.canonicalDomain, 'betterup.com');
    assert.match(String(stage2Plan.payload.campaign_plan.competitor_context.competitor_url), /^https:\/\/betterup\.com\/?$/);
    assert.equal(stage2Plan.payload.campaign_plan.competitor_context.canonical_domain, 'betterup.com');
    assert.ok(['trusted', 'probable', 'override'].includes(stage2Plan.payload.campaign_plan.competitor_context.trust_classification));
    assert.match(String(stage2Review.payload.review_packet.competitor_website), /^https:\/\/betterup\.com\/?$/);
    assert.equal(stage2Review.payload.review_packet.competitor_canonical_domain, 'betterup.com');
    assert.ok(['trusted', 'probable', 'override'].includes(stage2Review.payload.review_packet.competitor_trust_classification));
    assert.doesNotMatch(combinedStderr, /stage1_competitor_domain_mismatch:no_trustworthy_same_domain_evidence:facebook\.com/);
  });
});
