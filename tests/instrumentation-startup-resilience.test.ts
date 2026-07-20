import assert from 'node:assert/strict';
import test from 'node:test';

import { register } from '../instrumentation';
import type { HermesSocialContentRuntimeReport } from '../backend/marketing/hermes-runtime-contract';

const STARTUP_ENV = {
  NODE_ENV: 'production',
  HERMES_GATEWAY_URL: 'http://hermes:8642',
  HERMES_API_SERVER_KEY: 'server-key',
  INTERNAL_API_SECRET: 'internal-secret',
  APP_BASE_URL: 'https://aries.example.com',
  HERMES_STARTUP_HEALTHCHECK: '1',
} as const;

type RegisterDependencies = {
  env: Record<string, string | undefined>;
  probeHermesRuntime?: () => Promise<HermesSocialContentRuntimeReport>;
  sleep: (delayMs: number) => Promise<void>;
  warn: (...args: unknown[]) => void;
};

const registerWithDependencies = register as unknown as (
  dependencies: RegisterDependencies,
) => Promise<void>;

function runtimeReport(ok: boolean): HermesSocialContentRuntimeReport {
  return {
    ok,
    workflow: {
      key: 'social_content_weekly',
      version: '2026-05-social-content-weekly-v2',
      registrationMode: 'prompt-routed-via-hermes-marketing-port',
    },
    callbackContract: {
      callbackUrl: 'https://aries.example.com/api/internal/hermes/runs',
      directGatewayCallbacks: false,
      pollBridgeEnabled: true,
      callbackAuth: 'internal_api_secret_bearer',
    },
    gateway: {
      ok,
      url: 'http://hermes:8642',
      httpStatus: ok ? 200 : null,
      payload: ok ? { status: 'ok' } : null,
      ...(ok ? {} : { error: 'connect ECONNREFUSED hermes:8642' }),
    },
    capabilities: {
      ok,
      httpStatus: ok ? 200 : null,
      payload: ok ? { endpoints: {} } : null,
      requiredEndpoints: {
        runs: ok,
        runStatus: ok,
        health: ok,
      },
      pollableRuns: ok,
      ...(ok ? {} : { error: 'connect ECONNREFUSED hermes:8642' }),
    },
  };
}

async function withStartupProcessEnv(
  run: () => Promise<void>,
  fetchImpl: typeof fetch = async () => {
    throw new Error('connect ECONNREFUSED hermes:8642');
  },
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(STARTUP_ENV)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;

  try {
    await run();
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('instrumentation retries the Hermes startup probe with bounded exponential backoff and recovers', async () => {
  await withStartupProcessEnv(async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const warnings: string[] = [];

    await registerWithDependencies({
      env: STARTUP_ENV,
      probeHermesRuntime: async () => {
        attempts += 1;
        return runtimeReport(attempts === 3);
      },
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
      },
      warn: (...args) => {
        warnings.push(args.map(String).join(' '));
      },
    });

    assert.equal(attempts, 3);
    assert.deepEqual(sleeps, [1_000, 2_000]);
    assert.deepEqual(warnings, []);
  });
});

test('instrumentation fails soft when the production Hermes fetch path throws at boot', async () => {
  let fetchAttempts = 0;
  await withStartupProcessEnv(async () => {
    const sleeps: number[] = [];
    const warnings: string[] = [];

    await assert.doesNotReject(() =>
      registerWithDependencies({
        env: STARTUP_ENV,
        sleep: async (delayMs) => {
          sleeps.push(delayMs);
        },
        warn: (...args) => {
          warnings.push(args.map(String).join(' '));
        },
      }),
    );

    assert.equal(fetchAttempts, 6, 'each of three probes should call health and capabilities');
    assert.deepEqual(sleeps, [1_000, 2_000]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /failed after 3 attempts/);
    assert.match(warnings[0], /http:\/\/hermes:8642/);
    assert.match(warnings[0], /continuing in degraded mode/);
  }, async () => {
    fetchAttempts += 1;
    throw new Error('connect ECONNREFUSED hermes:8642');
  });
});

test('instrumentation fails startup immediately when Hermes rejects its credentials', async () => {
  const report = runtimeReport(false);
  report.gateway = {
    ok: true,
    url: 'http://hermes:8642',
    httpStatus: 200,
    payload: { status: 'ok' },
  };
  report.capabilities.httpStatus = 401;
  report.capabilities.error = 'Hermes /v1/capabilities rejected the API key (HTTP 401).';

  let attempts = 0;
  const sleeps: number[] = [];
  const warnings: string[] = [];

  await assert.rejects(
    () =>
      registerWithDependencies({
        env: STARTUP_ENV,
        probeHermesRuntime: async () => {
          attempts += 1;
          return report;
        },
        sleep: async (delayMs) => {
          sleeps.push(delayMs);
        },
        warn: (...args) => {
          warnings.push(args.map(String).join(' '));
        },
      }),
    /HTTP 401/,
  );

  assert.equal(attempts, 1);
  assert.deepEqual(sleeps, []);
  assert.deepEqual(warnings, []);
});

test('instrumentation surfaces the permanent failure when Hermes checks fail for mixed reasons', async () => {
  const report = runtimeReport(false);
  report.capabilities.httpStatus = 401;
  report.capabilities.error = 'Hermes /v1/capabilities rejected the API key (HTTP 401).';

  let attempts = 0;
  await assert.rejects(
    () =>
      registerWithDependencies({
        env: STARTUP_ENV,
        probeHermesRuntime: async () => {
          attempts += 1;
          return report;
        },
        sleep: async () => {},
        warn: () => {},
      }),
    /HTTP 401/,
  );
  assert.equal(attempts, 1);
});

test('instrumentation fails startup on an incompatible Hermes capability contract', async () => {
  const report = runtimeReport(false);
  report.gateway = {
    ok: true,
    url: 'http://hermes:8642',
    httpStatus: 200,
    payload: { status: 'ok' },
  };
  report.capabilities.httpStatus = 200;
  report.capabilities.error =
    'Hermes /v1/capabilities is missing the polled-run contract Aries expects (HTTP 200).';

  let attempts = 0;
  await assert.rejects(
    () =>
      registerWithDependencies({
        env: STARTUP_ENV,
        probeHermesRuntime: async () => {
          attempts += 1;
          return report;
        },
        sleep: async () => {},
        warn: () => {},
      }),
    /missing the polled-run contract/,
  );
  assert.equal(attempts, 1);
});

test('instrumentation rejects static Hermes misconfiguration before probing', async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      registerWithDependencies({
        env: { ...STARTUP_ENV, HERMES_API_SERVER_KEY: '' },
        probeHermesRuntime: async () => {
          attempts += 1;
          return runtimeReport(true);
        },
        sleep: async () => {},
        warn: () => {},
      }),
    /missing HERMES_API_SERVER_KEY/,
  );
  assert.equal(attempts, 0);
});

test('instrumentation does not swallow unrelated startup probe exceptions', async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      registerWithDependencies({
        env: STARTUP_ENV,
        probeHermesRuntime: async () => {
          attempts += 1;
          throw new Error('unexpected probe bug');
        },
        sleep: async () => {},
        warn: () => {},
      }),
    /unexpected probe bug/,
  );
  assert.equal(attempts, 1);
});

for (const transientStatus of [408, 429, 503]) {
  test(`instrumentation degrades only after retrying transient HTTP ${transientStatus}`, async () => {
    const report = runtimeReport(false);
    report.gateway = {
      ok: true,
      url: 'http://hermes:8642',
      httpStatus: 200,
      payload: { status: 'ok' },
    };
    report.capabilities.httpStatus = transientStatus;
    report.capabilities.error = `Hermes /v1/capabilities returned HTTP ${transientStatus}.`;

    let attempts = 0;
    await assert.doesNotReject(() =>
      registerWithDependencies({
        env: STARTUP_ENV,
        probeHermesRuntime: async () => {
          attempts += 1;
          return report;
        },
        sleep: async () => {},
        warn: () => {},
      }),
    );
    assert.equal(attempts, 3);
  });
}
