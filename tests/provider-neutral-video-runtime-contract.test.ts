import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const RETIRED_VIDEO_PROVIDER_IDENTIFIER = /\bveo(?:[_-]|\b)/i;
const AFFECTED_TESTS = [
  'dashboard-content-adapter.test.ts',
  'hermes-image-bridge-multischema.test.ts',
  'hermes-image-generation-fail-loud.test.ts',
  'marketing-job-facts.test.ts',
  'marketing-legacy-text-repair.regression-014.test.ts',
  'post-preview-components.test.ts',
  'video-artifact-collector.test.ts',
  'video-synthesize-dims.test.ts',
] as const;

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];

  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function readJson(filePath: string): Record<string, any> {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, any>;
}

test('active video runtime surfaces contain no retired provider contract or identifier', () => {
  const activeFiles = [
    ...['app', 'backend', 'frontend', 'hooks'].flatMap((directory) =>
      filesUnder(path.join(PROJECT_ROOT, directory)),
    ),
    path.join(PROJECT_ROOT, 'specs', 'video_job_contract_spec.v1.json'),
    path.join(PROJECT_ROOT, 'specs', 'video_runtime_state_schema.v1.json'),
    ...filesUnder(path.join(PROJECT_ROOT, 'skills')),
    ...AFFECTED_TESTS.map((fileName) => path.join(PROJECT_ROOT, 'tests', fileName)),
  ];

  const matches = activeFiles.flatMap((filePath) => {
    const source = readFileSync(filePath, 'utf8');
    return RETIRED_VIDEO_PROVIDER_IDENTIFIER.test(source)
      ? [path.relative(PROJECT_ROOT, filePath).replaceAll('\\', '/')]
      : [];
  });

  assert.deepEqual(matches, []);
  const retiredSkillDirectory = ['v', 'eo-video-runtime'].join('');
  assert.equal(existsSync(path.join(PROJECT_ROOT, 'skills', retiredSkillDirectory)), false);
  assert.equal(existsSync(path.join(PROJECT_ROOT, 'skills', 'video-render-runtime', 'SKILL.md')), true);
});

test('video job spec exposes only the generic Aries-to-Hermes render request', () => {
  const schema = readJson(path.join(PROJECT_ROOT, 'specs', 'video_job_contract_spec.v1.json'));
  const request = schema.$defs.jobCreateRequest;
  const requestRequired = request.required as string[];
  const requestProperties = request.properties as Record<string, unknown>;
  const renderRequest = schema.$defs.renderRequest;
  const renderProperties = renderRequest.properties as Record<string, unknown>;

  assert.equal((requestProperties.execution_provider as Record<string, unknown>).const, 'hermes');
  assert.ok(requestRequired.includes('execution_provider'));
  assert.ok(requestRequired.includes('render_request'));
  assert.equal(requestRequired.includes('lane'), false);
  assert.equal('max_attempts' in requestProperties, false);
  for (const forbidden of ['provider', 'model', 'api_host', 'auth']) {
    assert.equal(forbidden in renderProperties, false, `render_request must not expose ${forbidden}`);
  }

  const accepted = schema.$defs.jobAcceptedResponse;
  assert.ok((accepted.required as string[]).includes('hermes_run_id'));
  assert.equal('queue_name' in (accepted.properties as Record<string, unknown>), false);
});

test('video runtime state records Hermes execution without downstream provider state', () => {
  const schema = readJson(path.join(PROJECT_ROOT, 'specs', 'video_runtime_state_schema.v1.json'));
  const required = schema.required as string[];
  const properties = schema.properties as Record<string, unknown>;

  assert.ok(required.includes('execution_provider'));
  assert.equal((properties.execution_provider as Record<string, unknown>).const, 'hermes');
  assert.ok('hermes_run_id' in properties);
  for (const forbidden of ['lane', 'provider_job_ref', 'attempt', 'max_attempts']) {
    assert.equal(forbidden in properties, false, `runtime state must not expose ${forbidden}`);
  }
});
