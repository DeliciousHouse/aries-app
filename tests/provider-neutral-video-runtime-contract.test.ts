import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';
import {
  createPinnedPublicSourceFetch,
  VideoRenderBriefSchema,
  VideoTerminalEventSchema,
  projectVideoTerminalEventToHermesCallback,
  validatePublicVideoSourceUrl,
  validateVideoRenderHermesSubmission,
  validateVideoRenderSourceUrls,
} from '../backend/video-runtime/hermes-contract';
import { HermesRunCallbackPayloadSchema, HermesRunSubmissionSchema, PROTOCOL_VERSION } from '@aries/hermes-protocol';

const ROOT = process.cwd();
const readJson = (relativePath: string) => JSON.parse(readFileSync(path.join(ROOT, relativePath), 'utf8')) as Record<string, any>;

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

function terminalCallback(status: 'completed' | 'failed' | 'cancelled' | 'stopped', includeError = status === 'failed') {
  return {
    event_id: `evt-video-${status}`,
    aries_run_id: 'arun_123e4567-e89b-42d3-a456-426614174001',
    hermes_run_id: 'hermes-video-1',
    status,
    stage: 'video_render',
    output: [{
      artifacts: [{
        id: 'clip-primary',
        path: '/home/node/.hermes/profiles/aries-content-generator/cache/videos/clip.mp4',
        mime_type: 'video/mp4',
        bytes: 42,
      }],
    }],
    ...(includeError ? { error: { code: 'render_failed', message: 'Render failed.', retryable: true } } : {}),
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

  const validateContract = new Ajv2020({ strict: false, validateFormats: false }).compile(jobSpec);
  const validContract = {
    video_brief: {
      prompt: 'Create a six-second vertical product teaser.',
      aspect_ratio: '9:16',
      duration_seconds: 6,
      input_assets: [{ type: 'https_url', url: 'https://cdn.example.com/source.png' }],
    },
    hermes_submission: submission,
    terminal_event: {
      event_type: 'video_render.completed',
      runtime_phase: 'succeeded',
      callback: terminalCallback('completed'),
    },
  };
  assert.equal(validateContract(validContract), true, JSON.stringify(validateContract.errors));

  const stoppedContract = structuredClone(validContract);
  stoppedContract.terminal_event = {
    event_type: 'video_render.cancelled',
    runtime_phase: 'cancelled',
    callback: terminalCallback('stopped'),
  };
  assert.equal(validateContract(stoppedContract), true, JSON.stringify(validateContract.errors));
  assert.equal(VideoTerminalEventSchema.parse(stoppedContract.terminal_event).callback.status, 'cancelled');

  for (const unsafeUrl of [
    'https://2130706433./source.png',
    'https://0x7f000001./source.png',
    'https://0177.0.0.1/source.png',
    'https://127.1/source.png',
    'https://[::ffff:127.0.0.1]/source.png',
  ]) {
    const alternateLoopbackContract = structuredClone(validContract);
    alternateLoopbackContract.video_brief.input_assets[0].url = unsafeUrl;
    assert.equal(validateContract(alternateLoopbackContract), false, unsafeUrl);
  }
});

test('RBAC contract inventory references existing active contract files', () => {
  const matrix = readJson('specs/rbac_matrix.v1.json') as { contracts_ref?: unknown };
  assert.ok(Array.isArray(matrix.contracts_ref));
  assert.ok(matrix.contracts_ref.includes('./specs/video_job_contract_spec.v2.json'));
  for (const reference of matrix.contracts_ref) {
    assert.equal(typeof reference, 'string');
    assert.equal(existsSync(path.resolve(ROOT, reference)), true, `RBAC contract reference must exist: ${reference}`);
  }
});

test('video source locators accept public HTTPS and reject local, private, unspecified, mapped, link-local, and traversal forms', () => {
  const base = {
    prompt: 'Create a six-second vertical product teaser.',
    aspect_ratio: '9:16' as const,
    duration_seconds: 6,
  };

  for (const url of [
    'https://cdn.example.com/assets/hero.png',
    'https://192.0.1.1/assets/public.mp4',
    'https://[2001:4860:4860::8888]/hero.png',
  ]) {
    assert.equal(VideoRenderBriefSchema.safeParse({
      ...base,
      input_assets: [{ type: 'https_url', url }],
    }).success, true, `expected safe source locator to pass: ${url}`);
  }

  for (const url of [
    'file:///etc/passwd',
    'http://127.0.0.1:3000/private.png',
    'https://localhost/private.png',
    'https://0.0.0.0/private.png',
    'https://10.0.0.7/private.png',
    'https://192.168.1.5/private.png',
    'https://[::]/private.png',
    'https://[::1]/private.png',
    'https://[::ffff:127.0.0.1]/private.png',
    'https://[::ffff:10.0.0.7]/private.png',
    'https://[::ffff:c0a8:101]/private.png',
    'https://[fc00::1]/private.png',
    'https://[fd12::1]/private.png',
    'https://[fe80::1]/private.png',
    'https://[fea0::1]/private.png',
    'https://[febf::1]/private.png',
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

test('public video source redirect validation rejects pivots to private destinations and allows safe chains', async () => {
  const safeCalls: string[] = [];
  const safeFinal = await validatePublicVideoSourceUrl('https://cdn.example.com/start.mp4', async (url) => {
    safeCalls.push(String(url));
    return safeCalls.length === 1
      ? new Response(null, { status: 302, headers: { location: 'https://media.example.com/final.mp4' } })
      : new Response(null, { status: 200 });
  }, async () => ['93.184.216.34']);
  assert.equal(safeFinal, 'https://media.example.com/final.mp4');
  assert.deepEqual(safeCalls, ['https://cdn.example.com/start.mp4', 'https://media.example.com/final.mp4']);

  let pivotCalls = 0;
  await assert.rejects(
    validatePublicVideoSourceUrl('https://cdn.example.com/start.mp4', async () => {
      pivotCalls += 1;
      return new Response(null, { status: 302, headers: { location: 'https://[::ffff:127.0.0.1]/admin' } });
    }, async () => ['93.184.216.34']),
    /public HTTPS/i,
  );
  assert.equal(pivotCalls, 1, 'private redirect target must be rejected before it is fetched');
});

test('public video source validation pins each bounded request to the addresses that passed DNS validation', async () => {
  let approvedAddresses: readonly string[] | undefined;
  await validatePublicVideoSourceUrl('https://cdn.example.com/source.mp4', async (...args: unknown[]) => {
    approvedAddresses = args[2] as readonly string[] | undefined;
    return new Response(null, { status: 206 });
  }, async () => ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
  assert.deepEqual(approvedAddresses, ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
});

test('DNS-pinned retrieval falls through public addresses while retaining original Host and SNI', async () => {
  const attempts: Array<{
    connectAddress: string;
    hostname: string;
    hostHeader: string;
    servername?: string;
  }> = [];
  const fetchPinned = createPinnedPublicSourceFetch({
    addressAttemptTimeoutMs: 50,
    requestAddress: async (request) => {
      attempts.push({
        connectAddress: request.connectAddress,
        hostname: request.hostname,
        hostHeader: request.hostHeader,
        servername: request.servername,
      });
      if (request.connectAddress === '93.184.216.30') {
        throw new Error('first approved address is unreachable');
      }
      return new Response(null, { status: 206 });
    },
  });

  const response = await fetchPinned(
    'https://cdn.example.com:8443/source.mp4',
    { method: 'GET', headers: { range: 'bytes=0-0' } },
    ['93.184.216.30', '93.184.216.34'],
  );
  assert.equal(response.status, 206);
  assert.deepEqual(attempts, [
    {
      connectAddress: '93.184.216.30',
      hostname: 'cdn.example.com',
      hostHeader: 'cdn.example.com:8443',
      servername: 'cdn.example.com',
    },
    {
      connectAddress: '93.184.216.34',
      hostname: 'cdn.example.com',
      hostHeader: 'cdn.example.com:8443',
      servername: 'cdn.example.com',
    },
  ]);

  let privatePivotFetches = 0;
  await assert.rejects(
    validatePublicVideoSourceUrl(
      'https://cdn.example.com/source.mp4',
      async () => {
        privatePivotFetches += 1;
        return new Response(null, { status: 206 });
      },
      async () => ['93.184.216.34', '127.0.0.1'],
    ),
    /resolve only to public/i,
  );
  assert.equal(privatePivotFetches, 0, 'a mixed public/private DNS answer must fail before any connection');
});

test('source validation bounds concurrency across sixteen assets', async () => {
  let active = 0;
  let maxActive = 0;
  const payload = {
    video_brief: {
      prompt: 'Create a bounded source montage.',
      aspect_ratio: '16:9',
      duration_seconds: 15,
      input_assets: Array.from({ length: 16 }, (_, index) => ({
        type: 'https_url',
        url: `https://cdn${index}.example.com/source.mp4`,
      })),
    },
  };

  const startedAt = Date.now();
  await validateVideoRenderSourceUrls(
    payload,
    async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return new Response(null, { status: 206 });
    },
    async () => ['93.184.216.34'],
    { concurrency: 4, perSourceDeadlineMs: 500, totalDeadlineMs: 1_000 },
  );
  const elapsedMs = Date.now() - startedAt;
  assert.equal(maxActive, 4);
  assert.ok(elapsedMs < 220, `sixteen 20ms sources should complete concurrently, observed ${elapsedMs}ms`);
});

test('source validation applies deterministic per-source and submission deadlines', async () => {
  const payload = {
    video_brief: {
      prompt: 'Create a timeout-bound montage.',
      aspect_ratio: '16:9',
      duration_seconds: 15,
      input_assets: Array.from({ length: 4 }, (_, index) => ({
        type: 'https_url',
        url: `https://slow${index}.example.com/source.mp4`,
      })),
    },
  };
  const slowFetch = async (_url: string | URL, init?: RequestInit) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 80);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('controlled source request aborted'));
      }, { once: true });
    });
    return new Response(null, { status: 206 });
  };

  await assert.rejects(
    validateVideoRenderSourceUrls(
      payload,
      slowFetch,
      async () => ['93.184.216.34'],
      { concurrency: 2, perSourceDeadlineMs: 250, totalDeadlineMs: 30 },
    ),
    /video source submission validation deadline exceeded/i,
  );

  await assert.rejects(
    validatePublicVideoSourceUrl(
      'https://slow.example.com/source.mp4',
      slowFetch,
      async () => ['93.184.216.34'],
      { deadlineMs: 20 },
    ),
    /video source validation deadline exceeded/i,
  );
});

test('public video source validation follows the bounded GET redirect chain instead of trusting divergent HEAD behavior', async () => {
  const requests: Array<{ method: string; range: string | null }> = [];
  await assert.rejects(
    validatePublicVideoSourceUrl('https://cdn.example.com/start.mp4', async (_url, init) => {
      const method = String(init?.method ?? 'GET');
      requests.push({ method, range: new Headers(init?.headers).get('range') });
      if (method === 'HEAD') {
        return new Response(null, { status: 405 });
      }
      return new Response(null, {
        status: 302,
        headers: { location: 'https://127.0.0.1/private.mp4' },
      });
    }, async () => ['93.184.216.34']),
    /public HTTPS/i,
  );
  assert.deepEqual(requests, [{ method: 'GET', range: 'bytes=0-0' }]);
});

test('terminal event type, runtime phase, callback status, and failed-event errors are bound', () => {
  const completed = {
    event_type: 'video_render.completed',
    runtime_phase: 'succeeded',
    callback: terminalCallback('completed'),
  };
  const failed = {
    event_type: 'video_render.failed',
    runtime_phase: 'failed',
    callback: terminalCallback('failed'),
  };
  const stopped = {
    event_type: 'video_render.cancelled',
    runtime_phase: 'cancelled',
    callback: terminalCallback('stopped'),
  };

  assert.deepEqual(
    projectVideoTerminalEventToHermesCallback(completed),
    HermesRunCallbackPayloadSchema.parse(completed.callback),
  );
  assert.equal(VideoTerminalEventSchema.safeParse(failed).success, true);
  assert.equal(VideoTerminalEventSchema.parse(stopped).callback.status, 'cancelled');
  assert.equal(projectVideoTerminalEventToHermesCallback(stopped).status, 'cancelled');

  for (const invalid of [
    { ...completed, runtime_phase: 'failed' },
    { ...completed, callback: { ...completed.callback, status: 'failed' } },
    { ...completed, event_type: 'video_render.failed' },
    {
      event_type: 'video_render.failed',
      runtime_phase: 'failed',
      callback: terminalCallback('failed', false),
    },
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

test('video submission validation rejects Hermes-owned selectors recursively inside structured request input', () => {
  const nestedMediaSelector = {
    ...liveSubmission(),
    input: [
      'Workflow: social_content_weekly',
      'Request (JSON): {"input":{"media_requests":[{"type":"video.generate","provider":"operator-selected","model":"operator-model"}]}}',
    ].join('\n'),
  };
  assert.throws(
    () => validateVideoRenderHermesSubmission(nestedMediaSelector),
    /Hermes owns execution selection.*media_requests\[0\]\.provider/i,
  );

  const opaqueNestedSelector = {
    ...liveSubmission(),
    input: [
      'Workflow: social_content_weekly',
      'Request (JSON): {"input":{"media_requests":[{"type":"video.generate"}],"opaque":{"render":{"routing_selector":{"model_id":"operator-model"}}}}}',
    ].join('\n'),
  };
  assert.throws(
    () => validateVideoRenderHermesSubmission(opaqueNestedSelector),
    /Hermes owns execution selection.*opaque\.render\.routing_selector/i,
  );

  assert.doesNotThrow(() => validateVideoRenderHermesSubmission(liveSubmission()));

  const cyclicContext = liveSubmission();
  const callbackContext = cyclicContext.callback_context as Record<string, unknown>;
  callbackContext.self = callbackContext;
  assert.doesNotThrow(() => validateVideoRenderHermesSubmission(cyclicContext));
});

test('video submission validation rejects normalized selector aliases in request and prior-stage JSON blocks', () => {
  const aliases = [
    'providerId',
    'provider-id',
    'mediaProvider',
    'media-provider',
    'modelId',
    'model-id',
    'providerOptions',
    'provider-options',
    'routingSelector',
    'routing-selector',
  ];

  for (const blockLabel of ['Request', 'Prior stage output']) {
    for (const alias of aliases) {
      const submission = {
        ...liveSubmission(),
        input: [
          'Workflow: social_content_weekly',
          'Request (JSON): {"input":{"media_requests":[{"type":"video.generate","count":1}]}}',
          `${blockLabel} (JSON): {"nested":{"${alias}":"operator-selected"}}`,
        ].join('\n'),
      };

      assert.throws(
        () => validateVideoRenderHermesSubmission(submission),
        new RegExp(`Hermes owns execution selection.*${alias}`, 'i'),
        `${blockLabel} must reject ${alias}`,
      );
    }
  }
});

test('the v2 runtime schema validates actual ExecutionRunRecord values and mirrors live enums', async () => {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-video-runtime-schema-'));
  process.env.DATA_ROOT = dataRoot;
  try {
    const { createExecutionRunRecord, markExecutionRunEventApplied } = await import('../backend/execution/run-store');
    const schema = readJson('specs/video_runtime_state_schema.v2.json');
    const ajv = new Ajv2020({ strict: true, validateFormats: false });
    for (const keyword of ['x-aries-contract-version', 'x-aries-state-source', 'x-terminal-origin-rule']) {
      ajv.addKeyword({ keyword });
    }
    const validate = ajv.compile(schema);

    assert.equal(schema.properties.schema_version.const, '1.0.0');
    assert.deepEqual(schema.properties.action.enum, ['run', 'resume', 'cancel']);
    assert.deepEqual(schema.properties.status.enum, [
      'submitted',
      'running',
      'awaiting_approval',
      'completed',
      'failed',
      'cancelled',
    ]);

    for (const action of ['run', 'resume', 'cancel'] as const) {
      const record = createExecutionRunRecord({
        provider: 'hermes',
        domain: 'marketing',
        workflowKey: 'social_content_weekly',
        action,
        tenantId: 'tenant-contract',
        marketingJobId: productionJobId(),
        stage: 'production',
      });
      assert.equal(validate(record), true, ajv.errorsText(validate.errors));
    }

    const statuses = ['running', 'awaiting_approval', 'completed', 'failed', 'cancelled'] as const;
    for (const status of statuses) {
      const record = createExecutionRunRecord({
        provider: 'hermes',
        domain: 'marketing',
        workflowKey: 'social_content_weekly',
        action: 'run',
        tenantId: 'tenant-contract',
        marketingJobId: productionJobId(),
        stage: 'production',
      });
      const updated = markExecutionRunEventApplied(record.aries_run_id, {
        eventId: `evt-${status}`,
        status,
        ...(status === 'failed' ? { error: { code: 'render_failed', message: 'failed' } } : {}),
      });
      assert.equal(validate(updated), true, ajv.errorsText(validate.errors));
    }
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('active tracked text files contain no retired provider identifiers outside exact historical evidence', async () => {
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
    const source = await readFile(path.join(ROOT, relativePath));
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
