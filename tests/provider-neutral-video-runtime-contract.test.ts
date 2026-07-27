import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  VideoRenderBriefSchema,
  VideoTerminalEventSchema,
  projectVideoTerminalEventToHermesCallback,
  validateVideoRenderHermesSubmission,
} from '../backend/video-runtime/hermes-contract';
import { HermesRunCallbackPayloadSchema, HermesRunSubmissionSchema, PROTOCOL_VERSION } from '@aries/hermes-protocol';

const ROOT = process.cwd();
const readJson = (relativePath: string) => JSON.parse(readFileSync(path.join(ROOT, relativePath), 'utf8')) as Record<string, unknown>;

function productionJobId(): string {
  return 'mkt_123e4567-e89b-42d3-a456-426614174000';
}

function liveSubmission(): Record<string, unknown> {
  return {
    input: 'Workflow: social_content_weekly\nAction: run\nRequest (JSON): {"input":{"media_requests":[{"type":"video.generate","count":1}]}}',
    instructions: 'Execute the provider-neutral video render contract.',
    session_id: 'marketing',
    workflow_key: 'social_content_weekly',
    workflow_version: '2026-05-social-content-weekly-v2',
    action: 'run',
    aries_run_id: 'arun_123e4567-e89b-42d3-a456-426614174001',
    job_id: productionJobId(),
    tenant_id: 'tenant-contract',
    callback_url: 'https://aries.example.com/api/internal/hermes/runs',
    callback_auth: {
      type: 'internal_api_secret_bearer',
      secret_ref: 'INTERNAL_API_SECRET',
      callback_token: 'a'.repeat(64),
    },
    callback_context: {
      workflow_key: 'social_content_weekly',
      aries_run_id: 'arun_123e4567-e89b-42d3-a456-426614174001',
      job_id: productionJobId(),
      tenant_id: 'tenant-contract',
    },
    idempotency_key: 'video-contract-test-idempotency-key',
    protocol_version: PROTOCOL_VERSION,
  };
}

test('v2 video contract is a validated projection of the live Hermes run and callback protocols', () => {
  const jobSpec = readJson('specs/video_job_contract_spec.v2.json');
  const stateSpec = readJson('specs/video_runtime_state_schema.v2.json');
  const skillContract = readJson('skills/video-render-runtime/contract.json');

  assert.equal(jobSpec.$id, 'https://aries.example/schemas/video-job-contract-spec-v2.json');
  assert.equal(jobSpec['x-aries-contract-version'], '2.0.0');
  assert.equal(jobSpec['x-aries-hermes-submission-schema'], 'HermesRunSubmissionSchema');
  assert.equal(jobSpec['x-aries-hermes-callback-schema'], 'HermesRunCallbackPayloadSchema');
  assert.equal(stateSpec.$id, 'https://aries.example/schemas/video-runtime-state-schema-v2.json');
  assert.equal(stateSpec['x-aries-state-source'], 'ExecutionRunRecord');
  assert.equal(skillContract.$ref, '../../specs/video_job_contract_spec.v2.json');

  const submission = validateVideoRenderHermesSubmission(liveSubmission());
  assert.deepEqual(submission, HermesRunSubmissionSchema.parse(submission));
  assert.equal(submission.job_id, productionJobId());
  assert.equal(submission.callback_context.aries_run_id, submission.aries_run_id);
  assert.equal(submission.callback_context.job_id, submission.job_id);
  assert.equal(submission.callback_context.tenant_id, submission.tenant_id);
});

test('video source locators accept only public HTTPS URLs and reject file, loopback, private, and traversal forms', () => {
  const base = {
    prompt: 'Create a six-second vertical product teaser.',
    aspect_ratio: '9:16' as const,
    duration_seconds: 6,
  };

  assert.equal(VideoRenderBriefSchema.parse({
    ...base,
    input_assets: [{ type: 'https_url', url: 'https://cdn.example.com/assets/hero.png' }],
  }).input_assets.length, 1);

  for (const url of [
    'file:///etc/passwd',
    'http://127.0.0.1:3000/private.png',
    'https://localhost/private.png',
    'https://10.0.0.7/private.png',
    'https://192.168.1.5/private.png',
    'https://cdn.example.com/assets/../secret.png',
    'C:\\Users\\operator\\secret.png',
  ]) {
    assert.equal(
      VideoRenderBriefSchema.safeParse({ ...base, input_assets: [{ type: 'https_url', url }] }).success,
      false,
      `expected unsafe source locator to be rejected: ${url}`,
    );
  }
});

test('terminal event type, runtime phase, and callback status are bound and project to the shared callback envelope', () => {
  const completed = {
    event_type: 'video_render.completed',
    runtime_phase: 'succeeded',
    callback: {
      event_id: 'evt-video-completed',
      aries_run_id: 'arun_123e4567-e89b-42d3-a456-426614174001',
      hermes_run_id: 'hermes-video-1',
      status: 'completed',
      stage: 'video_render',
      output: [{ artifacts: [{ id: 'clip-primary', path: '/home/node/.hermes/cache/videos/clip.mp4', mime_type: 'video/mp4', bytes: 42 }] }],
    },
  };

  const projected = projectVideoTerminalEventToHermesCallback(completed);
  assert.deepEqual(projected, HermesRunCallbackPayloadSchema.parse(completed.callback));

  for (const invalid of [
    { ...completed, runtime_phase: 'failed' },
    { ...completed, callback: { ...completed.callback, status: 'failed' } },
    { ...completed, event_type: 'video_render.failed' },
  ]) {
    assert.equal(VideoTerminalEventSchema.safeParse(invalid).success, false);
  }
});

test('video submission validation accepts production mkt UUIDs and rejects placeholder or mismatched ownership', () => {
  assert.doesNotThrow(() => validateVideoRenderHermesSubmission(liveSubmission()));

  for (const invalid of [
    { ...liveSubmission(), job_id: 'mkt_placeholder' },
    { ...liveSubmission(), job_id: 'video_demo_001' },
    {
      ...liveSubmission(),
      callback_context: { ...(liveSubmission().callback_context as Record<string, unknown>), tenant_id: 'another-tenant' },
    },
    { ...liveSubmission(), provider: 'aries-owned-provider-is-forbidden' },
  ]) {
    assert.throws(() => validateVideoRenderHermesSubmission(invalid));
  }
});

test('active tracked text files contain no retired provider identifiers outside exact historical evidence', () => {
  const retired = new RegExp(`\\b${['v', 'eo'].join('')}([_-]|\\b)`, 'i');
  const historicalAllowlist = [
    {
      path: 'CHANGELOG.md',
      context: `Hermes/${['V', 'eo'].join('')} image budget doubles`,
      reason: 'immutable release history describing the implementation at that release',
    },
    {
      path: 'docs/plans/2026-07-02-ai-slop-audit.md',
      context: `${['V', 'eo'].join('')} lane vs the shipped video pipeline`,
      reason: 'dated audit evidence documenting a removed scaffold',
    },
    {
      path: 'docs/plans/2026-07-02-ai-slop-audit.md',
      context: `dead March \"${['V', 'eo'].join('')} lane\" scaffold`,
      reason: 'dated audit evidence documenting a removed scaffold',
    },
  ] as const;

  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const observed: Array<{ path: string; context: string }> = [];

  for (const relativePath of tracked) {
    const source = readFileSync(path.join(ROOT, relativePath));
    if (source.includes(0)) continue;
    for (const line of source.toString('utf8').split(/\r?\n/)) {
      if (!retired.test(line)) continue;
      const allowed = historicalAllowlist.find((entry) => entry.path === relativePath && line.includes(entry.context));
      assert.ok(allowed, `retired provider identifier remains in active tracked source: ${relativePath}: ${line.trim()}`);
      assert.ok(allowed.reason.length > 20, `historical allowlist reason must be explicit for ${relativePath}`);
      observed.push({ path: relativePath, context: allowed.context });
    }
  }

  assert.deepEqual(
    observed.sort((a, b) => `${a.path}:${a.context}`.localeCompare(`${b.path}:${b.context}`)),
    historicalAllowlist
      .map(({ path: historicalPath, context }) => ({ path: historicalPath, context }))
      .sort((a, b) => `${a.path}:${a.context}`.localeCompare(`${b.path}:${b.context}`)),
    'historical allowlist must be exact: every allowed occurrence must still exist exactly once',
  );
});
