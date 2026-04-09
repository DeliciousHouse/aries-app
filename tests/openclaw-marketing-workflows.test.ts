import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ARIES_ATOMIC_MARKETING_WORKFLOW_KEYS,
  ARIES_OPENCLAW_WORKFLOWS,
} from '../backend/openclaw/workflow-catalog';
import { runAriesOpenClawWorkflow } from '../backend/openclaw/aries-execution';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function marketingWorkflows() {
  return ARIES_ATOMIC_MARKETING_WORKFLOW_KEYS.map((key) => [key, ARIES_OPENCLAW_WORKFLOWS[key]] as const);
}

function nestedWorkflowPaths(): string[] {
  return [
    path.join(PROJECT_ROOT, 'lobster', 'marketing-pipeline.lobster'),
    path.join(PROJECT_ROOT, 'lobster', 'stage-1-research', 'workflow.lobster'),
    path.join(PROJECT_ROOT, 'lobster', 'stage-2-strategy', 'review-workflow.lobster'),
    path.join(PROJECT_ROOT, 'lobster', 'stage-2-strategy', 'finalize-workflow.lobster'),
    path.join(PROJECT_ROOT, 'lobster', 'stage-3-production', 'review-workflow.lobster'),
    path.join(PROJECT_ROOT, 'lobster', 'stage-3-production', 'finalize-workflow.lobster'),
    path.join(PROJECT_ROOT, 'lobster', 'stage-4-publish-optimize', 'review-workflow.lobster'),
    path.join(PROJECT_ROOT, 'lobster', 'stage-4-publish-optimize', 'publish-workflow.lobster'),
  ];
}

function decodeBase64Json(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'string');
  const encoded = value as string;
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Record<string, unknown>;
}

function installTestInvoker(
  captured: Array<Record<string, unknown>>,
  envelope: Record<string, unknown> = { ok: true, status: 'ok', output: [{}], requiresApproval: null },
) {
  (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = (payload: Record<string, unknown>) => {
    captured.push(payload);
    return envelope;
  };
}

function clearTestInvoker() {
  delete (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__;
}

async function withTempCacheRoot<T>(
  envKey: string,
  run: (cacheRoot: string) => Promise<T>,
): Promise<T> {
  const previousValue = process.env[envKey];
  const cacheRoot = await mkdtemp(path.join(tmpdir(), `${envKey.toLowerCase()}-`));

  process.env[envKey] = cacheRoot;
  try {
    return await run(cacheRoot);
  } finally {
    if (previousValue === undefined) delete process.env[envKey];
    else process.env[envKey] = previousValue;
    await rm(cacheRoot, { recursive: true, force: true });
  }
}

async function writeCachedStepPayload(
  cacheRoot: string,
  runId: string,
  stepName: string,
  payload: Record<string, unknown>,
) {
  const runDir = path.join(cacheRoot, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, `${stepName}.json`), JSON.stringify(payload, null, 2));
}

test('every marketing workflow-catalog pipeline path exists on disk', async () => {
  for (const [, workflow] of marketingWorkflows()) {
    await access(path.join(PROJECT_ROOT, 'lobster', workflow.pipeline));
  }
});

test('runAriesOpenClawWorkflow dispatches every marketing workflow key to the exact catalog pipeline and cwd', async () => {
  await withTempCacheRoot('LOBSTER_STAGE3_CACHE_DIR', async (stage3CacheRoot) => {
    await writeCachedStepPayload(stage3CacheRoot, 'run-production-review', 'production_review_preview', {
      type: 'production_review_preview',
      run_id: 'run-production-review',
      brand_slug: 'brand-example',
    });
    await writeCachedStepPayload(stage3CacheRoot, 'run-production-finalize', 'creative_director_finalize', {
      type: 'creative_director_finalize',
      run_id: 'run-production-finalize',
      production_handoff: {
        run_id: 'run-production-finalize',
        brand_slug: 'brand-example',
      },
    });

    for (const [key, workflow] of marketingWorkflows()) {
      const captured: Array<Record<string, unknown>> = [];
      installTestInvoker(captured);

      try {
        const baseStrategyHandoff = {
          run_id: 'run-strategy',
          brand_slug: 'brand-example',
          core_message: 'Proof-led launch control.',
          primary_cta: 'Book a walkthrough',
        };
        const baseProductionHandoff = {
          run_id: 'run-production',
          brand_slug: 'brand-example',
          campaign_name: 'Brand Example Launch',
        };
        const inputsByKey: Record<string, Record<string, unknown>> = {
          marketing_stage1_research: {
            competitorUrl: 'https://betterup.com',
          },
          marketing_stage2_strategy_review: {
            brandUrl: 'https://brand.example',
            research_output: {
              run_id: 'run-stage1',
              competitor_url: 'https://betterup.com',
            },
          },
          marketing_stage2_strategy_finalize: {
            runId: 'run-stage2',
          },
          marketing_stage3_production_review: {
            strategy_handoff: baseStrategyHandoff,
          },
          marketing_stage3_production_finalize: {
            runId: 'run-production-review',
          },
          marketing_stage4_publish_review: {
            production_handoff: baseProductionHandoff,
          },
          marketing_stage4_publish_finalize: {
            runId: 'run-production-finalize',
          },
        };

      const executed = await runAriesOpenClawWorkflow(key, {
        inputs: inputsByKey[key],
      });

      assert.equal(executed.kind, 'ok');
      assert.equal((captured[0]?.args as Record<string, unknown>)?.pipeline, workflow.pipeline);
      assert.equal((captured[0]?.args as Record<string, unknown>)?.cwd, 'lobster');
      } finally {
        clearTestInvoker();
      }
    }
  });
});

test('atomic marketing workflows remain scoped to the tenant workflow adapter surface', async () => {
  const { MARKETING_CLIENT_EXECUTION_MODEL, MARKETING_PIPELINE_FILE } = await import('../backend/marketing/orchestrator');

  assert.deepEqual(
    marketingWorkflows().map(([key]) => key),
    ARIES_ATOMIC_MARKETING_WORKFLOW_KEYS,
  );
  assert.equal(MARKETING_CLIENT_EXECUTION_MODEL, 'marketing_pipeline_run_resume');
  assert.equal(MARKETING_PIPELINE_FILE, 'marketing-pipeline.lobster');
});

test('runAriesOpenClawWorkflow flattens stage-1 marketing inputs into the stage contract', async () => {
  const captured: Array<Record<string, unknown>> = [];
  installTestInvoker(captured);

  try {
    const executed = await runAriesOpenClawWorkflow('marketing_stage1_research', {
      tenant_id: 'Tenant 42',
      actor_id: 'user_1',
      inputs: {
        competitorUrl: 'https://competitor.example',
        competitor: 'Competitor Example',
        competitorBrand: 'Competitor Inc',
        facebookPageUrl: 'https://facebook.com/competitor',
        adLibraryUrl: 'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&q=competitor',
        metaPageId: '123456',
        researchModel: 'gemini/custom-model',
      },
    });

    assert.equal(executed.kind, 'ok');
    const argsJson = JSON.parse(String((captured[0]?.args as Record<string, unknown>)?.argsJson ?? '{}')) as Record<string, unknown>;
    assert.equal('inputs' in argsJson, false);
    assert.equal(argsJson.competitor_url, 'https://competitor.example');
    assert.equal(argsJson.competitor, 'Competitor Example');
    assert.equal(argsJson.competitor_brand, 'Competitor Inc');
    assert.equal(argsJson.facebook_page_url, 'https://facebook.com/competitor');
    assert.equal(argsJson.competitor_facebook_url, 'https://facebook.com/competitor');
    assert.equal(
      argsJson.ad_library_url,
      'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&q=competitor',
    );
    assert.equal(argsJson.meta_page_id, '123456');
    assert.equal(argsJson.research_model, 'gemini/custom-model');
    assert.deepEqual(Object.keys(argsJson).sort(), [
      'ad_library_url',
      'competitor',
      'competitor_brand',
      'competitor_facebook_url',
      'competitor_url',
      'facebook_page_url',
      'meta_page_id',
      'research_model',
    ]);
  } finally {
    clearTestInvoker();
  }
});

test('stage-2 review resolves cached stage-1 research and derives a filesystem-safe brand_slug', async () => {
  await withTempCacheRoot('LOBSTER_STAGE1_CACHE_DIR', async (cacheRoot) => {
    await writeCachedStepPayload(cacheRoot, 'run-stage1', 'ads_analyst_compile', {
      type: 'ads_analyst_compile',
      run_id: 'run-stage1',
      competitor: 'Competitor Example',
      competitor_url: 'https://competitor.example',
      competitor_facebook_url: 'https://facebook.com/competitor',
      competitorIdentity: {
        brandName: 'Competitor Example',
        canonicalUrl: 'https://competitor.example',
      },
      metaLocator: {
        facebookPageUrl: 'https://facebook.com/competitor',
      },
      evidence: {
        ctaUrls: ['https://competitor.example/demo'],
      },
      trustValidation: {
        classification: 'verified',
      },
    });

    const captured: Array<Record<string, unknown>> = [];
    installTestInvoker(captured);

    try {
      const executed = await runAriesOpenClawWorkflow('marketing_stage2_strategy_review', {
        tenant_id: 'Tenant 42 / Brand Ops',
        inputs: {
          brandUrl: 'https://brand.example',
          runId: 'run-stage1',
        },
      });

      assert.equal(executed.kind, 'ok');
      const argsJson = JSON.parse(String((captured[0]?.args as Record<string, unknown>)?.argsJson ?? '{}')) as Record<string, unknown>;
      assert.equal(argsJson.brand_url, 'https://brand.example');
      assert.equal(argsJson.brand_slug, 'tenant-42-brand-ops');
      assert.equal(argsJson.research_model, 'gemini/gemini-3-flash-preview');
      const stage1Payload = decodeBase64Json(argsJson.stage1_summary_base64);
      assert.equal(stage1Payload.run_id, 'run-stage1');
      assert.equal(stage1Payload.competitor_url, 'https://competitor.example');
      assert.equal('run_id' in argsJson, false);
    } finally {
      clearTestInvoker();
    }
  });
});

test('stage-2 strategy review workflow runs brand-kit bootstrap before website-brand-analysis', async () => {
  const workflowPath = path.join(PROJECT_ROOT, 'lobster', 'stage-2-strategy', 'review-workflow.lobster');
  const content = await readFile(workflowPath, 'utf8');

  const brandKitIndex = content.indexOf('brand-kit-bootstrap.ts');
  const websiteAnalysisIndex = content.indexOf('website-brand-analysis');
  assert.notEqual(brandKitIndex, -1);
  assert.notEqual(websiteAnalysisIndex, -1);
  assert.ok(brandKitIndex < websiteAnalysisIndex);
});

test('stage-3 review resolves cached strategy handoff by run_id', async () => {
  await withTempCacheRoot('LOBSTER_STAGE2_CACHE_DIR', async (cacheRoot) => {
    await writeCachedStepPayload(cacheRoot, 'run-stage2', 'head_of_marketing', {
      type: 'head_of_marketing',
      run_id: 'run-stage2',
      brand_slug: 'brand-ops',
      strategy_handoff: {
        run_id: 'run-stage2',
        brand_slug: 'brand-ops',
        campaign_name: 'Brand Ops Launch',
        core_message: 'Proof-led operator control.',
        primary_cta: 'Book a walkthrough',
      },
    });

    const captured: Array<Record<string, unknown>> = [];
    installTestInvoker(captured);

    try {
      const executed = await runAriesOpenClawWorkflow('marketing_stage3_production_review', {
        inputs: {
          runId: 'run-stage2',
        },
      });

      assert.equal(executed.kind, 'ok');
      const argsJson = JSON.parse(String((captured[0]?.args as Record<string, unknown>)?.argsJson ?? '{}')) as Record<string, unknown>;
      assert.equal(argsJson.brand_slug, 'brand-ops');
      assert.equal(argsJson.research_model, 'gemini/gemini-3-flash-preview');
      const strategyPayload = decodeBase64Json(argsJson.strategy_handoff_base64);
      assert.equal((strategyPayload.strategy_handoff as Record<string, unknown>).core_message, 'Proof-led operator control.');
      assert.equal('run_id' in argsJson, false);
    } finally {
      clearTestInvoker();
    }
  });
});

test('stage-4 review resolves cached production handoff by run_id without path transport drift', async () => {
  await withTempCacheRoot('LOBSTER_STAGE3_CACHE_DIR', async (cacheRoot) => {
    await writeCachedStepPayload(cacheRoot, 'run-stage3', 'creative_director_finalize', {
      type: 'creative_director_finalize',
      run_id: 'run-stage3',
      brand_slug: 'brand-ops',
      production_handoff: {
        run_id: 'run-stage3',
        brand_slug: 'brand-ops',
        campaign_name: 'Brand Ops Launch',
      },
    });

    const captured: Array<Record<string, unknown>> = [];
    installTestInvoker(captured);

    try {
      const executed = await runAriesOpenClawWorkflow('marketing_stage4_publish_review', {
        inputs: {
          runId: 'run-stage3',
        },
      });

      assert.equal(executed.kind, 'ok');
      const argsJson = JSON.parse(String((captured[0]?.args as Record<string, unknown>)?.argsJson ?? '{}')) as Record<string, unknown>;
      assert.equal(argsJson.brand_slug, 'brand-ops');
      assert.equal('production_handoff_path' in argsJson, false);
      const productionPayload = decodeBase64Json(argsJson.production_handoff_base64);
      assert.equal((productionPayload.production_handoff as Record<string, unknown>).campaign_name, 'Brand Ops Launch');
    } finally {
      clearTestInvoker();
    }
  });
});

test('stage-4 publish uses run_id only and keeps the publish adapter', async () => {
  await withTempCacheRoot('LOBSTER_STAGE3_CACHE_DIR', async (cacheRoot) => {
    await writeCachedStepPayload(cacheRoot, 'run-stage4', 'creative_director_finalize', {
      type: 'creative_director_finalize',
      run_id: 'run-stage4',
      brand_slug: 'brand-ops',
      production_handoff: {
        run_id: 'run-stage4',
        brand_slug: 'brand-ops',
      },
    });

    const captured: Array<Record<string, unknown>> = [];
    installTestInvoker(captured);

    try {
      const executed = await runAriesOpenClawWorkflow('marketing_stage4_publish_finalize', {
        inputs: {
          runId: 'run-stage4',
        },
      });

      assert.equal(executed.kind, 'ok');
      const argsJson = JSON.parse(String((captured[0]?.args as Record<string, unknown>)?.argsJson ?? '{}')) as Record<string, unknown>;
      assert.deepEqual(argsJson, {
        brand_slug: 'brand-ops',
        run_id: 'run-stage4',
      });
    } finally {
      clearTestInvoker();
    }
  });
});

test('finalize workflows keep the audited bridge wrappers in place', async () => {
  const stage2Workflow = await readFile(path.join(PROJECT_ROOT, 'lobster', 'stage-2-strategy', 'finalize-workflow.lobster'), 'utf8');
  const stage3Workflow = await readFile(path.join(PROJECT_ROOT, 'lobster', 'stage-3-production', 'finalize-workflow.lobster'), 'utf8');
  const stage4Workflow = await readFile(path.join(PROJECT_ROOT, 'lobster', 'stage-4-publish-optimize', 'publish-workflow.lobster'), 'utf8');

  assert.match(stage2Workflow, /stage2-finalize-bridge/);
  assert.match(stage3Workflow, /stage3-finalize-bridge/);
  assert.match(stage4Workflow, /stage4-publish-compat/);
  assert.match(stage2Workflow, /--run-id/);
  assert.match(stage3Workflow, /--run-id/);
  assert.match(stage4Workflow, /--run-id/);
  assert.doesNotMatch(stage4Workflow, /production-handoff-path/);

  await access(path.join(PROJECT_ROOT, 'lobster', 'bin', 'stage2-finalize-bridge'));
  await access(path.join(PROJECT_ROOT, 'lobster', 'bin', 'stage3-finalize-bridge'));
  await access(path.join(PROJECT_ROOT, 'lobster', 'bin', 'stage4-publish-compat'));
});

test('marketing review workflows reject deprecated public transport aliases', async () => {
  const stage2 = await runAriesOpenClawWorkflow('marketing_stage2_strategy_review', {
    inputs: {
      brandUrl: 'https://brand.example',
      stage1SummaryBase64: 'deprecated',
    },
  });
  assert.equal(stage2.kind, 'gateway_error');
  assert.equal(stage2.error.code, 'openclaw_gateway_request_invalid');
  assert.match(stage2.error.message, /stage1SummaryBase64/);

  const stage3 = await runAriesOpenClawWorkflow('marketing_stage3_production_review', {
    inputs: {
      strategyHandoffBase64: 'deprecated',
    },
  });
  assert.equal(stage3.kind, 'gateway_error');
  assert.equal(stage3.error.code, 'openclaw_gateway_request_invalid');
  assert.match(stage3.error.message, /strategyHandoffBase64/);

  const stage4Review = await runAriesOpenClawWorkflow('marketing_stage4_publish_review', {
    inputs: {
      productionHandoffPath: '/tmp/legacy.json',
    },
  });
  assert.equal(stage4Review.kind, 'gateway_error');
  assert.equal(stage4Review.error.code, 'openclaw_gateway_request_invalid');
  assert.match(stage4Review.error.message, /productionHandoffPath/);

  const stage4Publish = await runAriesOpenClawWorkflow('marketing_stage4_publish_finalize', {
    inputs: {
      productionHandoffBase64: 'deprecated',
      runId: 'run-stage4',
    },
  });
  assert.equal(stage4Publish.kind, 'gateway_error');
  assert.equal(stage4Publish.error.code, 'openclaw_gateway_request_invalid');
  assert.match(stage4Publish.error.message, /productionHandoffBase64/);
});

test('aries execution no longer uses the stage1-only marketing compat fallback for atomic workflows', async () => {
  const source = await readFile(path.join(PROJECT_ROOT, 'backend', 'openclaw', 'aries-execution.ts'), 'utf8');
  assert.equal(source.includes('marketing-pipeline-compat'), false);
  assert.equal(source.includes('runLocalMarketingCompat'), false);
});

test('nested marketing workflows do not reference legacy missing-helper commands', async () => {
  const forbidden = [
    '../bin/',
    'validate_args.py',
    'check_requirements.py',
    'bootstrap_marketing_workspace.sh',
    'invoke_skill.py',
    'marketing-pipeline-compat',
  ];

  for (const workflowPath of nestedWorkflowPaths()) {
    const content = await readFile(workflowPath, 'utf8');
    for (const token of forbidden) {
      assert.equal(content.includes(token), false, `${path.basename(workflowPath)} should not reference ${token}`);
    }
  }
});

test('nested marketing workflows only keep the reviewed transport arguments', async () => {
  const stage2Review = await readFile(path.join(PROJECT_ROOT, 'lobster', 'stage-2-strategy', 'review-workflow.lobster'), 'utf8');
  const stage3Review = await readFile(path.join(PROJECT_ROOT, 'lobster', 'stage-3-production', 'review-workflow.lobster'), 'utf8');
  const stage4Review = await readFile(path.join(PROJECT_ROOT, 'lobster', 'stage-4-publish-optimize', 'review-workflow.lobster'), 'utf8');
  const stage4Publish = await readFile(path.join(PROJECT_ROOT, 'lobster', 'stage-4-publish-optimize', 'publish-workflow.lobster'), 'utf8');

  assert.match(stage2Review, /stage1-summary-base64/);
  assert.match(stage3Review, /strategy-handoff-base64/);
  assert.match(stage4Review, /production-handoff-base64/);
  assert.doesNotMatch(stage4Review, /production-handoff-path/);
  assert.doesNotMatch(stage4Publish, /production-handoff-path/);
});
