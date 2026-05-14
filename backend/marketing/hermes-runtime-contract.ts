import {
  SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY,
  SOCIAL_CONTENT_WEEKLY_WORKFLOW_VERSION,
} from '../social-content/defaults';

type ProviderEnv = Partial<Record<string, string | undefined>>;
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type HermesGatewayHealth = {
  ok: boolean;
  url: string;
  httpStatus: number | null;
  payload: unknown;
  error?: string;
};

export type HermesGatewayCapabilities = {
  ok: boolean;
  httpStatus: number | null;
  payload: unknown;
  requiredEndpoints: {
    runs: boolean;
    runStatus: boolean;
    health: boolean;
  };
  pollableRuns: boolean;
  error?: string;
};

export type HermesSocialContentRuntimeReport = {
  ok: boolean;
  workflow: {
    key: string;
    version: string;
    registrationMode: 'prompt-routed-via-hermes-marketing-port';
  };
  callbackContract: {
    callbackUrl: string;
    directGatewayCallbacks: false;
    pollBridgeEnabled: boolean;
    callbackAuth: 'internal_api_secret_bearer';
  };
  gateway: HermesGatewayHealth;
  capabilities: HermesGatewayCapabilities;
};

function readEnvValue(env: ProviderEnv, key: string): string {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function forceHermesSocialContentEnv(
  env: ProviderEnv = process.env,
): ProviderEnv {
  return {
    ...env,
    ARIES_MARKETING_EXECUTION_PROVIDER: 'hermes',
  };
}

export function hermesPollBridgeEnabled(env: ProviderEnv = process.env): boolean {
  const raw = readEnvValue(env, 'HERMES_POLL_BRIDGE_ENABLED').toLowerCase();
  return raw !== '0' && raw !== 'false';
}

export function resolveHermesGatewayUrl(env: ProviderEnv = process.env): string {
  return readEnvValue(env, 'HERMES_GATEWAY_URL').replace(/\/+$/, '');
}

export function resolveHermesSocialContentCallbackUrl(
  env: ProviderEnv = process.env,
): string {
  const appBaseUrl = readEnvValue(env, 'APP_BASE_URL');
  if (!appBaseUrl) {
    throw new Error(
      'Hermes social-content runtime is not configured: APP_BASE_URL is required to build /api/internal/hermes/runs.',
    );
  }

  let base: URL;
  try {
    base = new URL(appBaseUrl);
  } catch {
    throw new Error(
      `Hermes social-content runtime is not configured: APP_BASE_URL must be an absolute URL (received ${JSON.stringify(appBaseUrl)}).`,
    );
  }

  return new URL('/api/internal/hermes/runs', base).toString();
}

export function assertHermesSocialContentRuntimeConfigured(
  env: ProviderEnv = process.env,
): void {
  const forcedEnv = forceHermesSocialContentEnv(env);
  const missing = [
    'HERMES_GATEWAY_URL',
    'HERMES_API_SERVER_KEY',
    'INTERNAL_API_SECRET',
    'APP_BASE_URL',
  ].filter((key) => !readEnvValue(forcedEnv, key));

  if (missing.length > 0) {
    throw new Error(
      `Hermes social-content runtime is not configured: missing ${missing.join(', ')}. ` +
      'Weekly social content is Hermes-only and cannot fall back to legacy-openclaw.',
    );
  }

  const gatewayUrl = resolveHermesGatewayUrl(forcedEnv);
  try {
    new URL(gatewayUrl);
  } catch {
    throw new Error(
      `Hermes social-content runtime is not configured: HERMES_GATEWAY_URL must be an absolute URL (received ${JSON.stringify(gatewayUrl)}).`,
    );
  }

  resolveHermesSocialContentCallbackUrl(forcedEnv);

  if (!hermesPollBridgeEnabled(forcedEnv)) {
    throw new Error(
      'Hermes social-content runtime is not configured: HERMES_POLL_BRIDGE_ENABLED must stay enabled because Hermes /v1/runs is polled and never invokes callback_url directly.',
    );
  }
}

export async function probeHermesGatewayHealth(
  env: ProviderEnv = process.env,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<HermesGatewayHealth> {
  const forcedEnv = forceHermesSocialContentEnv(env);
  const gatewayUrl = resolveHermesGatewayUrl(forcedEnv);

  try {
    assertHermesSocialContentRuntimeConfigured(forcedEnv);
  } catch (error) {
    return {
      ok: false,
      url: gatewayUrl,
      httpStatus: null,
      payload: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const response = await fetchImpl(`${gatewayUrl}/health`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    let payload: unknown = text;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }

    const ok = response.ok && !!payload && typeof payload === 'object' && (payload as Record<string, unknown>).status === 'ok';
    return {
      ok,
      url: gatewayUrl,
      httpStatus: response.status,
      payload,
      ...(ok ? {} : { error: `Hermes /health returned HTTP ${response.status}.` }),
    };
  } catch (error) {
    return {
      ok: false,
      url: gatewayUrl,
      httpStatus: null,
      payload: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function probeHermesGatewayCapabilities(
  env: ProviderEnv = process.env,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<HermesGatewayCapabilities> {
  const forcedEnv = forceHermesSocialContentEnv(env);
  const gatewayUrl = resolveHermesGatewayUrl(forcedEnv);
  const apiKey = readEnvValue(forcedEnv, 'HERMES_API_SERVER_KEY');

  try {
    assertHermesSocialContentRuntimeConfigured(forcedEnv);
  } catch (error) {
    return {
      ok: false,
      httpStatus: null,
      payload: null,
      requiredEndpoints: { runs: false, runStatus: false, health: false },
      pollableRuns: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const response = await fetchImpl(`${gatewayUrl}/v1/capabilities`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    let payload: unknown = text;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }

    const payloadRecord = payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : null;
    const endpoints = payloadRecord?.endpoints && typeof payloadRecord.endpoints === 'object'
      ? (payloadRecord.endpoints as Record<string, { path?: string } | undefined>)
      : undefined;
    const features = payloadRecord?.features && typeof payloadRecord.features === 'object'
      ? (payloadRecord.features as Record<string, unknown>)
      : undefined;
    const requiredEndpoints = {
      runs: endpoints?.runs?.path === '/v1/runs',
      runStatus: endpoints?.run_status?.path === '/v1/runs/{run_id}',
      health: endpoints?.health?.path === '/health',
    };
    const pollableRuns = features?.run_events_sse === true || requiredEndpoints.runStatus;
    const ok = response.ok
      && requiredEndpoints.runs
      && requiredEndpoints.runStatus
      && requiredEndpoints.health
      && pollableRuns;

    return {
      ok,
      httpStatus: response.status,
      payload,
      requiredEndpoints,
      pollableRuns,
      ...(ok ? {} : { error: `Hermes /v1/capabilities is missing the polled-run contract Aries expects (HTTP ${response.status}).` }),
    };
  } catch (error) {
    return {
      ok: false,
      httpStatus: null,
      payload: null,
      requiredEndpoints: { runs: false, runStatus: false, health: false },
      pollableRuns: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function probeHermesSocialContentRuntime(
  env: ProviderEnv = process.env,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<HermesSocialContentRuntimeReport> {
  const forcedEnv = forceHermesSocialContentEnv(env);
  const gateway = await probeHermesGatewayHealth(forcedEnv, fetchImpl);
  const capabilities = await probeHermesGatewayCapabilities(forcedEnv, fetchImpl);
  const callbackUrl = (() => {
    try {
      return resolveHermesSocialContentCallbackUrl(forcedEnv);
    } catch {
      return '';
    }
  })();

  return {
    ok: gateway.ok && capabilities.ok,
    workflow: {
      key: SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY,
      version: SOCIAL_CONTENT_WEEKLY_WORKFLOW_VERSION,
      registrationMode: 'prompt-routed-via-hermes-marketing-port',
    },
    callbackContract: {
      callbackUrl,
      directGatewayCallbacks: false,
      pollBridgeEnabled: hermesPollBridgeEnabled(forcedEnv),
      callbackAuth: 'internal_api_secret_bearer',
    },
    gateway,
    capabilities,
  };
}

export function shouldProbeHermesOnStartup(env: ProviderEnv = process.env): boolean {
  const raw = readEnvValue(env, 'HERMES_STARTUP_HEALTHCHECK').toLowerCase();
  if (raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  return readEnvValue(env, 'NODE_ENV').toLowerCase() === 'production';
}
