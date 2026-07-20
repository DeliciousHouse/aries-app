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
  probeHermesRuntime: () => Promise<HermesSocialContentRuntimeReport>;
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

async function withStartupProcessEnv(run: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(STARTUP_ENV)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('connect ECONNREFUSED hermes:8642');
  }) as typeof fetch;

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

test('instrumentation fails soft when Hermes stays down at boot', async () => {
  await withStartupProcessEnv(async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const warnings: string[] = [];

    await assert.doesNotReject(() =>
      registerWithDependencies({
        env: STARTUP_ENV,
        probeHermesRuntime: async () => {
          attempts += 1;
          return runtimeReport(false);
        },
        sleep: async (delayMs) => {
          sleeps.push(delayMs);
        },
        warn: (...args) => {
          warnings.push(args.map(String).join(' '));
        },
      }),
    );

    assert.equal(attempts, 3);
    assert.deepEqual(sleeps, [1_000, 2_000]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /failed after 3 attempts/);
    assert.match(warnings[0], /http:\/\/hermes:8642/);
    assert.match(warnings[0], /continuing in degraded mode/);
  });
});
