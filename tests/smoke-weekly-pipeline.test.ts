import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'smoke-weekly-pipeline.mjs');
const SCRIPT_URL = `file://${SCRIPT_PATH}`;

type ParsedArgs = {
  tenant: string | null;
  website: string | null;
  autoApprove: boolean;
  help: boolean;
};

type SmokeErrorCtor = new (
  step: number,
  message: string,
  cause?: unknown,
) => Error & { step: number };

type HttpClient = {
  get: (stepIndex: number, p: string, init?: RequestInit) => Promise<Response>;
  post: (
    stepIndex: number,
    p: string,
    body: unknown,
    init?: RequestInit,
  ) => Promise<Response>;
  cookies: Map<string, string>;
};

type SmokeModule = {
  parseArgs: (argv: string[]) => ParsedArgs;
  validateArgs: (args: ParsedArgs) => string[];
  validateEnv: (env: Record<string, string | undefined>) => string[];
  encryptOAuthToken: (plaintext: string, base64Key: string) => string;
  buildUsageText: () => string;
  isAtApproval: (status: unknown, approvalStep: string) => boolean;
  isCompleted: (status: unknown) => boolean;
  buildHttp: (baseUrl: string) => HttpClient;
  STEP_LABELS: readonly string[];
  REQUIRED_ENV: readonly string[];
  EVIDENCE_PATHS: { evidenceDir: string; finalQaDir: string; smokeGreenFile: string };
  SmokeError: SmokeErrorCtor;
};

let cachedModule: SmokeModule | null = null;
async function loadSmoke(): Promise<SmokeModule> {
  if (cachedModule) return cachedModule;
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<SmokeModule>;
  cachedModule = await dynamicImport(SCRIPT_URL);
  return cachedModule;
}

test('parseArgs accepts exact CLI form and rejects malformed input', async () => {
  const smoke = await loadSmoke();
  const args = smoke.parseArgs([
    '--tenant',
    'smoke_1',
    '--website',
    'https://example.com',
    '--auto-approve',
  ]);
  assert.equal(args.tenant, 'smoke_1');
  assert.equal(args.website, 'https://example.com');
  assert.equal(args.autoApprove, true);
  assert.equal(args.help, false);

  const equalsForm = smoke.parseArgs(['--tenant=smoke_eq', '--website=https://eq.example']);
  assert.equal(equalsForm.tenant, 'smoke_eq');
  assert.equal(equalsForm.website, 'https://eq.example');
  assert.equal(equalsForm.autoApprove, false);

  const helpArgs = smoke.parseArgs(['--help']);
  assert.equal(helpArgs.help, true);

  const shortHelp = smoke.parseArgs(['-h']);
  assert.equal(shortHelp.help, true);
});

test('validateArgs flags every missing or malformed required flag', async () => {
  const smoke = await loadSmoke();
  const empty = smoke.validateArgs({ tenant: null, website: null, autoApprove: false, help: false });
  assert.deepEqual(
    empty.sort(),
    ['--auto-approve', '--tenant <id>', '--website <url>'].sort(),
  );

  const badUrl = smoke.validateArgs({
    tenant: 'smoke',
    website: 'not-a-url',
    autoApprove: true,
    help: false,
  });
  assert.equal(badUrl.length, 1);
  assert.match(badUrl[0], /must be a valid URL/);

  const ok = smoke.validateArgs({
    tenant: 'smoke',
    website: 'https://valid.example.com',
    autoApprove: true,
    help: false,
  });
  assert.deepEqual(ok, []);

  const blanks = smoke.validateArgs({
    tenant: '   ',
    website: '   ',
    autoApprove: true,
    help: false,
  });
  assert.deepEqual(blanks.sort(), ['--tenant <id>', '--website <url>'].sort());
});

test('validateEnv returns the names of every missing required env var', async () => {
  const smoke = await loadSmoke();
  const missing = smoke.validateEnv({});
  for (const required of smoke.REQUIRED_ENV) {
    assert.ok(missing.includes(required), `expected missing env to include ${required}`);
  }

  const provided: Record<string, string> = {
    APP_BASE_URL: 'http://127.0.0.1:3000',
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    DB_USER: 'aries_user',
    DB_PASSWORD: 'aries_pass',
    DB_NAME: 'aries_dev',
    META_TEST_PAGE_ID: '123',
    META_TEST_PAGE_ACCESS_TOKEN: 'page-token',
    OAUTH_TOKEN_ENCRYPTION_KEY: 'a'.repeat(44),
  };
  assert.deepEqual(smoke.validateEnv(provided), []);

  const blanks = { ...provided, APP_BASE_URL: '   ' };
  assert.deepEqual(smoke.validateEnv(blanks), ['APP_BASE_URL']);
});

test('encryptOAuthToken matches the production AES-256-GCM JSON envelope', async () => {
  const smoke = await loadSmoke();
  const { encryptOAuthToken } = smoke;
  const { decryptToken } = await import('../backend/integrations/oauth-crypto');
  const previousKey = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  const key = Buffer.alloc(32, 7).toString('base64');
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = key;
  try {
    const ciphertext = encryptOAuthToken('test-page-token-XYZ', key);
    const parsed = JSON.parse(ciphertext) as Record<string, unknown>;
    assert.equal(parsed.v, 1);
    assert.equal(parsed.alg, 'aes-256-gcm');
    assert.equal(typeof parsed.iv, 'string');
    assert.equal(typeof parsed.tag, 'string');
    assert.equal(typeof parsed.ct, 'string');

    const roundTrip = decryptToken(ciphertext);
    assert.equal(roundTrip, 'test-page-token-XYZ');
  } finally {
    if (previousKey === undefined) {
      delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
    } else {
      process.env.OAUTH_TOKEN_ENCRYPTION_KEY = previousKey;
    }
  }
});

test('encryptOAuthToken rejects a missing or wrong-length key', async () => {
  const smoke = await loadSmoke();
  assert.throws(() => smoke.encryptOAuthToken('payload', ''), /OAUTH_TOKEN_ENCRYPTION_KEY/);
  assert.throws(() => smoke.encryptOAuthToken('payload', 'short'), /32 bytes/);
});

test('buildUsageText lists all 14 numbered steps in order', async () => {
  const smoke = await loadSmoke();
  const text = smoke.buildUsageText();
  assert.match(text, /tsx scripts\/smoke-weekly-pipeline\.mjs/);
  assert.match(text, /--tenant <id>/);
  assert.match(text, /--website <url>/);
  assert.match(text, /--auto-approve/);
  for (let stepIndex = 1; stepIndex <= 14; stepIndex += 1) {
    assert.match(text, new RegExp(`\\b${stepIndex}\\.`));
  }
  assert.match(text, /No skip flags. No soft-fail/);
});

test('STEP_LABELS exposes 14 numbered labels in order', async () => {
  const smoke = await loadSmoke();
  assert.equal(smoke.STEP_LABELS.length, 14);
  smoke.STEP_LABELS.forEach((label, index) => {
    assert.match(label, new RegExp(`^${index + 1}\\.`), `label[${index}] = ${label}`);
  });
});

test('isAtApproval matches only when the runtime exposes the requested approval step', async () => {
  const smoke = await loadSmoke();
  assert.equal(smoke.isAtApproval(null, 'approve_weekly_plan'), false);
  assert.equal(smoke.isAtApproval({}, 'approve_weekly_plan'), false);
  assert.equal(
    smoke.isAtApproval({ approvalRequired: true, approval: { approvalStep: 'approve_weekly_plan' } }, 'approve_weekly_plan'),
    true,
  );
  assert.equal(
    smoke.isAtApproval({ approvalRequired: true, approval: { step: 'approve_image_creatives' } }, 'approve_image_creatives'),
    true,
  );
  assert.equal(
    smoke.isAtApproval({ approvalRequired: false, approval: { approvalStep: 'approve_weekly_plan' } }, 'approve_weekly_plan'),
    false,
  );
  assert.equal(
    smoke.isAtApproval({ approvalRequired: true, approval: { approvalStep: 'approve_publish' } }, 'approve_weekly_plan'),
    false,
  );
});

test('isCompleted recognizes the social-content and marketing dialect state names', async () => {
  const smoke = await loadSmoke();
  assert.equal(smoke.isCompleted({ social_content_job_state: 'completed' }), true);
  assert.equal(smoke.isCompleted({ marketing_job_state: 'completed' }), true);
  assert.equal(smoke.isCompleted({ social_content_job_state: 'running' }), false);
  assert.equal(smoke.isCompleted(null), false);
  assert.equal(smoke.isCompleted({}), false);
});

test('CLI exits non-zero when required arguments are missing', () => {
  let threw: Error | null = null;
  try {
    execFileSync(process.execPath, [SCRIPT_PATH], {
      env: { ...process.env, APP_BASE_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    threw = error as Error;
  }
  assert.ok(threw, 'expected non-zero exit on missing args');
  const status = (threw as Error & { status?: number }).status;
  assert.equal(status, 1);
  const stderr = String((threw as Error & { stderr?: Buffer }).stderr ?? '');
  assert.match(stderr, /Missing or invalid arguments/);
});

test('CLI --help prints the usage block and exits 0', () => {
  const output = execFileSync(process.execPath, [SCRIPT_PATH, '--help'], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString('utf8');
  assert.match(output, /Usage:/);
  assert.match(output, /14\. dashboard image rendering/);
});

test('script source bans skip flags, soft-fail mode, and production Meta credentials', async () => {
  const source = await readFile(SCRIPT_PATH, 'utf8');
  const banned = [
    /--skip[-_][a-z]/i,
    /softFail|soft_fail/,
    /\bSKIP_[A-Z]/,
    /\bMETA_PAGE_ID\b/,
    /\bMETA_ACCESS_TOKEN\b/,
    /@ts-ignore/,
    /@ts-expect-error/,
    /\bas any\b/,
  ];
  for (const pattern of banned) {
    assert.equal(
      pattern.test(source),
      false,
      `script must not contain pattern ${pattern}`,
    );
  }
  assert.match(source, /META_TEST_PAGE_ID/);
  assert.match(source, /META_TEST_PAGE_ACCESS_TOKEN/);
});

test('SmokeError carries the failing step number through caller code', async () => {
  const smoke = await loadSmoke();
  const error = new smoke.SmokeError(7, 'creative_review timed out');
  assert.equal(error.step, 7);
  assert.equal(error.name, 'SmokeError');
  assert.match(error.message, /\[step 7\] creative_review timed out/);
});

test('EVIDENCE_PATHS points at the documented .sisyphus/evidence locations', async () => {
  const smoke = await loadSmoke();
  assert.equal(
    path.relative(REPO_ROOT, smoke.EVIDENCE_PATHS.smokeGreenFile),
    path.join('.sisyphus', 'evidence', 'task-28-smoke-green.txt'),
  );
  assert.equal(
    path.relative(REPO_ROOT, smoke.EVIDENCE_PATHS.finalQaDir),
    path.join('.sisyphus', 'evidence', 'final-qa'),
  );
  assert.equal(
    path.relative(REPO_ROOT, smoke.EVIDENCE_PATHS.evidenceDir),
    path.join('.sisyphus', 'evidence'),
  );
});

type CapturedFetch = { url: string; init: RequestInit };

function withStubbedFetch<T>(
  responder: (call: CapturedFetch) => Response,
  fn: (calls: CapturedFetch[]) => Promise<T>,
): Promise<T> {
  const previous = globalThis.fetch;
  const calls: CapturedFetch[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const captured: CapturedFetch = { url, init };
    calls.push(captured);
    return responder(captured);
  }) as typeof fetch;
  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => {
      globalThis.fetch = previous;
    });
}

test('http.post serializes JSON bodies and sets application/json content-type', async () => {
  const smoke = await loadSmoke();
  await withStubbedFetch(
    () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    async (calls) => {
      const http = smoke.buildHttp('http://aries.example.test');
      await http.post(0, '/api/social-content/jobs', { jobType: 'weekly_social_content', payload: { x: 1 } });
      assert.equal(calls.length, 1);
      const init = calls[0].init;
      assert.equal(typeof init.body, 'string');
      assert.equal(init.body, '{"jobType":"weekly_social_content","payload":{"x":1}}');
      const headers = new Headers(init.headers ?? {});
      assert.equal(headers.get('content-type'), 'application/json');
    },
  );
});

test('http.post preserves caller-provided raw body when body arg is null', async () => {
  const smoke = await loadSmoke();
  const form = new URLSearchParams({
    email: 'smoke@aries.test',
    password: 'pw',
    csrfToken: 'csrf-1',
    callbackUrl: '/dashboard',
    json: 'true',
  });
  const formText = form.toString();
  await withStubbedFetch(
    () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    async (calls) => {
      const http = smoke.buildHttp('http://aries.example.test');
      await http.post(
        0,
        '/api/auth/callback/credentials',
        null,
        {
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: formText,
        },
      );
      assert.equal(calls.length, 1);
      const init = calls[0].init;
      assert.equal(init.body, formText, 'raw form body must reach fetch unchanged');
      assert.notEqual(init.body, undefined, 'raw form body must not be dropped to undefined');
      const headers = new Headers(init.headers ?? {});
      assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded');
      assert.match(String(init.body), /email=smoke%40aries.test/);
      assert.match(String(init.body), /csrfToken=csrf-1/);
      assert.match(String(init.body), /json=true/);
    },
  );
});

test('http.post defaults to undefined body when caller passes neither body nor init.body', async () => {
  const smoke = await loadSmoke();
  await withStubbedFetch(
    () => new Response('{}', { status: 200 }),
    async (calls) => {
      const http = smoke.buildHttp('http://aries.example.test');
      await http.post(0, '/api/auth/csrf', null);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].init.body, undefined);
    },
  );
});

test('http.post merges init headers without dropping caller content-type when sending JSON body', async () => {
  const smoke = await loadSmoke();
  await withStubbedFetch(
    () => new Response('{}', { status: 200 }),
    async (calls) => {
      const http = smoke.buildHttp('http://aries.example.test');
      await http.post(
        0,
        '/api/x',
        { a: 1 },
        { headers: { 'content-type': 'application/json; charset=utf-8', 'x-trace': 'smoke' } },
      );
      const headers = new Headers(calls[0].init.headers ?? {});
      assert.equal(headers.get('content-type'), 'application/json; charset=utf-8');
      assert.equal(headers.get('x-trace'), 'smoke');
      assert.equal(calls[0].init.body, '{"a":1}');
    },
  );
});
