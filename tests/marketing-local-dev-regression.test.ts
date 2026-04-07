import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function hostCommandExists(command: string): boolean {
  return spawnSync('bash', ['-lc', `command -v ${command} >/dev/null 2>&1`]).status === 0;
}

test('runOpenClawLobsterWorkflow normalizes host-checkout absolute lobster cwd for gateway calls', async () => {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousGatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  const previousGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const previousGatewayLobsterCwd = process.env.OPENCLAW_GATEWAY_LOBSTER_CWD;
  const captured: Array<Record<string, unknown>> = [];

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.OPENCLAW_GATEWAY_URL = 'http://gateway.example.test';
  process.env.OPENCLAW_GATEWAY_TOKEN = 'debug-token';
  process.env.OPENCLAW_GATEWAY_LOBSTER_CWD = path.join(PROJECT_ROOT, 'lobster');
  (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = (payload: Record<string, unknown>) => {
    captured.push(payload);
    return { ok: true, status: 'ok', output: [], requiresApproval: null };
  };

  try {
    const {
      resolveOpenClawLobsterRuntimeContext,
      runOpenClawLobsterWorkflow,
    } = await import('../backend/openclaw/gateway-client');
    const runtime = resolveOpenClawLobsterRuntimeContext();
    await runOpenClawLobsterWorkflow({
      pipeline: 'marketing-pipeline.lobster',
      argsJson: '{}',
    });

    assert.equal(runtime.configuredCwd, path.join(PROJECT_ROOT, 'lobster'));
    assert.equal(runtime.cwd, 'aries-app/lobster');
    assert.equal((captured[0]?.args as Record<string, unknown>)?.cwd, 'aries-app/lobster');
  } finally {
    delete (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__;
    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = previousCodeRoot;
    if (previousGatewayUrl === undefined) delete process.env.OPENCLAW_GATEWAY_URL;
    else process.env.OPENCLAW_GATEWAY_URL = previousGatewayUrl;
    if (previousGatewayToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = previousGatewayToken;
    if (previousGatewayLobsterCwd === undefined) delete process.env.OPENCLAW_GATEWAY_LOBSTER_CWD;
    else process.env.OPENCLAW_GATEWAY_LOBSTER_CWD = previousGatewayLobsterCwd;
  }
});

test('resolveMarketingPipelineRuntimePaths keeps the gateway cwd and local pipeline path split in container mode', async () => {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousGatewayLobsterCwd = process.env.OPENCLAW_GATEWAY_LOBSTER_CWD;
  const previousLocalLobsterCwd = process.env.OPENCLAW_LOCAL_LOBSTER_CWD;
  const previousLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;

  process.env.CODE_ROOT = '/app';
  process.env.OPENCLAW_GATEWAY_LOBSTER_CWD = 'aries-app/lobster';
  process.env.OPENCLAW_LOCAL_LOBSTER_CWD = '/app/lobster';
  process.env.OPENCLAW_LOBSTER_CWD = '/app/lobster';

  try {
    const { resolveMarketingPipelineRuntimePaths } = await import('../backend/marketing/orchestrator');
    const paths = resolveMarketingPipelineRuntimePaths();

    assert.equal(paths.gatewayCwd, 'aries-app/lobster');
    assert.equal(paths.localCwd, '/app/lobster');
    assert.equal(paths.pipelinePath, '/app/lobster/marketing-pipeline.lobster');
    assert.equal(paths.runtime.cwd, 'aries-app/lobster');
    assert.equal(paths.runtime.configuredCwd, 'aries-app/lobster');
  } finally {
    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = previousCodeRoot;
    if (previousGatewayLobsterCwd === undefined) delete process.env.OPENCLAW_GATEWAY_LOBSTER_CWD;
    else process.env.OPENCLAW_GATEWAY_LOBSTER_CWD = previousGatewayLobsterCwd;
    if (previousLocalLobsterCwd === undefined) delete process.env.OPENCLAW_LOCAL_LOBSTER_CWD;
    else process.env.OPENCLAW_LOCAL_LOBSTER_CWD = previousLocalLobsterCwd;
    if (previousLobsterCwd === undefined) delete process.env.OPENCLAW_LOBSTER_CWD;
    else process.env.OPENCLAW_LOBSTER_CWD = previousLobsterCwd;
  }
});

test('marketing-pipeline-compat references bridge executables that exist in the repo', async () => {
  const compatPath = path.join(PROJECT_ROOT, 'lobster', 'bin', 'marketing-pipeline-compat');
  const compatSource = await readFile(compatPath, 'utf8');

  assert.match(compatSource, /stage3-finalize-bridge/);
  assert.match(compatSource, /stage4-publish-compat/);

  await access(path.join(PROJECT_ROOT, 'lobster', 'bin', 'stage3-finalize-bridge'));
  await access(path.join(PROJECT_ROOT, 'lobster', 'bin', 'stage4-publish-compat'));
});

test('assertMarketingRuntimeSchemas resolves the repo spec when CODE_ROOT assumes the container root', async () => {
  const previousCodeRoot = process.env.CODE_ROOT;

  process.env.CODE_ROOT = '/app';

  try {
    const { describeSpecResolution } = await import('../lib/runtime-paths');
    const { assertMarketingRuntimeSchemas } = await import('../backend/marketing/runtime-state');
    const resolution = describeSpecResolution('marketing_job_state_schema.v1.json');

    assert.equal(
      resolution.resolvedSpecPath,
      path.join(PROJECT_ROOT, 'specs', 'marketing_job_state_schema.v1.json'),
    );
    assert.equal(resolution.requestedCodeRoot, '/app');
    assert.equal(resolution.triedSpecPaths.includes('/app/specs/marketing_job_state_schema.v1.json'), true);
    assert.equal(resolution.triedSpecPaths.includes('/app/aries-app/specs/marketing_job_state_schema.v1.json'), true);
    assert.doesNotThrow(() => assertMarketingRuntimeSchemas());
  } finally {
    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = previousCodeRoot;
  }
});

test('runOpenClawLobsterWorkflow host-mode local fallback can run the nested stage-1 atomic marketing workflow file', async (t) => {
  const missing: string[] = [];
  if (!hostCommandExists('lobster')) missing.push('lobster');
  if (!hostCommandExists('openclaw')) missing.push('openclaw');
  if (!process.env.GEMINI_API_KEY?.trim()) missing.push('GEMINI_API_KEY');
  if (missing.length > 0) {
    t.skip(`host-mode local fallback requires ${missing.join(', ')}`);
    return;
  }

  const previousCodeRoot = process.env.CODE_ROOT;
  const previousGatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  const previousGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const previousGatewayLobsterCwd = process.env.OPENCLAW_GATEWAY_LOBSTER_CWD;
  const previousLocalLobsterCwd = process.env.OPENCLAW_LOCAL_LOBSTER_CWD;
  const previousLobsterStateDir = process.env.LOBSTER_STATE_DIR;
  const stateDir = await mkdtemp(path.join(tmpdir(), 'aries-stage1-lobster-state-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  delete process.env.OPENCLAW_GATEWAY_URL;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.OPENCLAW_GATEWAY_LOBSTER_CWD = 'aries-app/lobster';
  process.env.OPENCLAW_LOCAL_LOBSTER_CWD = path.join(PROJECT_ROOT, 'lobster');
  process.env.LOBSTER_STATE_DIR = stateDir;

  try {
    const { runOpenClawLobsterWorkflow } = await import('../backend/openclaw/gateway-client');

    const envelope = await runOpenClawLobsterWorkflow({
      pipeline: 'stage-1-research/workflow.lobster',
      cwd: 'aries-app/lobster',
      localCwd: path.join(PROJECT_ROOT, 'lobster'),
      argsJson: JSON.stringify({
        competitor_url: 'https://betterup.com',
      }),
      timeoutMs: 120000,
      maxStdoutBytes: 8 * 1024 * 1024,
    });

    assert.equal(envelope.ok, true);
    assert.equal(typeof envelope.status, 'string');
  } finally {
    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = previousCodeRoot;
    if (previousGatewayUrl === undefined) delete process.env.OPENCLAW_GATEWAY_URL;
    else process.env.OPENCLAW_GATEWAY_URL = previousGatewayUrl;
    if (previousGatewayToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = previousGatewayToken;
    if (previousGatewayLobsterCwd === undefined) delete process.env.OPENCLAW_GATEWAY_LOBSTER_CWD;
    else process.env.OPENCLAW_GATEWAY_LOBSTER_CWD = previousGatewayLobsterCwd;
    if (previousLocalLobsterCwd === undefined) delete process.env.OPENCLAW_LOCAL_LOBSTER_CWD;
    else process.env.OPENCLAW_LOCAL_LOBSTER_CWD = previousLocalLobsterCwd;
    if (previousLobsterStateDir === undefined) delete process.env.LOBSTER_STATE_DIR;
    else process.env.LOBSTER_STATE_DIR = previousLobsterStateDir;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('runOpenClawLobsterWorkflow host-mode local fallback only runs when host prerequisites exist', async (t) => {
  const missing: string[] = [];
  if (!hostCommandExists('lobster')) missing.push('lobster');
  if (!hostCommandExists('openclaw')) missing.push('openclaw');
  if (!process.env.GEMINI_API_KEY?.trim()) missing.push('GEMINI_API_KEY');
  if (missing.length > 0) {
    t.skip(`host-mode local fallback requires ${missing.join(', ')}`);
    return;
  }

  const previousCodeRoot = process.env.CODE_ROOT;
  const previousGatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  const previousGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const previousGatewayLobsterCwd = process.env.OPENCLAW_GATEWAY_LOBSTER_CWD;
  const previousLocalLobsterCwd = process.env.OPENCLAW_LOCAL_LOBSTER_CWD;
  const previousLobsterStateDir = process.env.LOBSTER_STATE_DIR;
  const stateDir = await mkdtemp(path.join(tmpdir(), 'aries-lobster-state-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  delete process.env.OPENCLAW_GATEWAY_URL;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.OPENCLAW_GATEWAY_LOBSTER_CWD = 'aries-app/lobster';
  process.env.OPENCLAW_LOCAL_LOBSTER_CWD = path.join(PROJECT_ROOT, 'lobster');
  process.env.LOBSTER_STATE_DIR = stateDir;

  try {
    const { runOpenClawLobsterWorkflow, resumeOpenClawLobsterWorkflow } = await import('../backend/openclaw/gateway-client');

    const firstEnvelope = await runOpenClawLobsterWorkflow({
      pipeline: 'marketing-pipeline.lobster',
      cwd: 'aries-app/lobster',
      localCwd: path.join(PROJECT_ROOT, 'lobster'),
      argsJson: JSON.stringify({
        brand_url: 'https://example.com',
        competitor_url: 'https://example.com',
        competitor: 'https://example.com',
        competitor_brand: '',
        facebook_page_url: '',
        ad_library_url: '',
        meta_page_id: '',
        competitor_facebook_url: '',
        brand_slug: 'public_example',
        agent_id: 'main',
      }),
      timeoutMs: 120000,
      maxStdoutBytes: 8 * 1024 * 1024,
    });

    assert.equal(firstEnvelope.ok, true);
    assert.equal(firstEnvelope.status, 'needs_approval');
    assert.equal(typeof firstEnvelope.requiresApproval?.resumeToken, 'string');

    const secondEnvelope = await resumeOpenClawLobsterWorkflow({
      token: String(firstEnvelope.requiresApproval?.resumeToken),
      approve: true,
      cwd: 'aries-app/lobster',
      localCwd: path.join(PROJECT_ROOT, 'lobster'),
      timeoutMs: 120000,
      maxStdoutBytes: 8 * 1024 * 1024,
    });

    assert.equal(secondEnvelope.ok, true);
    assert.equal(secondEnvelope.status, 'needs_approval');
    assert.equal(typeof secondEnvelope.requiresApproval?.resumeToken, 'string');
  } finally {
    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = previousCodeRoot;
    if (previousGatewayUrl === undefined) delete process.env.OPENCLAW_GATEWAY_URL;
    else process.env.OPENCLAW_GATEWAY_URL = previousGatewayUrl;
    if (previousGatewayToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = previousGatewayToken;
    if (previousGatewayLobsterCwd === undefined) delete process.env.OPENCLAW_GATEWAY_LOBSTER_CWD;
    else process.env.OPENCLAW_GATEWAY_LOBSTER_CWD = previousGatewayLobsterCwd;
    if (previousLocalLobsterCwd === undefined) delete process.env.OPENCLAW_LOCAL_LOBSTER_CWD;
    else process.env.OPENCLAW_LOCAL_LOBSTER_CWD = previousLocalLobsterCwd;
    if (previousLobsterStateDir === undefined) delete process.env.LOBSTER_STATE_DIR;
    else process.env.LOBSTER_STATE_DIR = previousLobsterStateDir;
    await rm(stateDir, { recursive: true, force: true });
  }
});
