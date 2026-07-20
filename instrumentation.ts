import {
  assertHermesSocialContentRuntimeConfigured,
  probeHermesSocialContentRuntime,
  shouldProbeHermesOnStartup,
  type HermesSocialContentRuntimeReport,
} from '@/backend/marketing/hermes-runtime-contract';
import { assertMarketingExecutionPortConfigured } from '@/backend/marketing/provider-guard';
import { validateHonchoConfig } from '@/backend/memory/honcho-env';
import {
  partnerAttributionDeliveryConfigured,
  partnerAttributionEnabled,
} from '@/lib/partner-attribution-env';

type StartupEnv = Partial<Record<string, string | undefined>>;

type InstrumentationDependencies = {
  env?: StartupEnv;
  probeHermesRuntime?: (
    env: StartupEnv,
  ) => Promise<HermesSocialContentRuntimeReport>;
  sleep?: (delayMs: number) => Promise<void>;
  warn?: (...args: unknown[]) => void;
};

const HERMES_STARTUP_PROBE_BACKOFF_MS = [1_000, 2_000] as const;

function isTransientHermesStatus(status: number | null): boolean {
  return (
    status === null ||
    status === 408 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

function failedHermesChecks(report: HermesSocialContentRuntimeReport) {
  return [report.gateway, report.capabilities].filter((check) => !check.ok);
}

function isTransientHermesStartupFailure(
  report: HermesSocialContentRuntimeReport,
): boolean {
  const failedChecks = failedHermesChecks(report);
  return (
    failedChecks.length > 0 &&
    failedChecks.every((check) => isTransientHermesStatus(check.httpStatus))
  );
}

function hermesStartupFailureDetail(
  report: HermesSocialContentRuntimeReport,
): string {
  const failedChecks = failedHermesChecks(report);
  const actionableFailure = failedChecks.find(
    (check) => !isTransientHermesStatus(check.httpStatus),
  ) ?? failedChecks[0];
  return (
    actionableFailure?.error ||
    'runtime contract unavailable'
  );
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function register(dependencies: InstrumentationDependencies = {}) {
  const env = dependencies.env ?? process.env;

  // Fail fast on startup when HONCHO_ENABLED=true but required config is absent.
  validateHonchoConfig(env);

  // Weekly social content is Hermes-only. Validate the runtime contract at boot
  // so misconfigured deployments fail loudly instead of submitting a run that
  // waits forever for a callback Hermes will never send directly.
  assertMarketingExecutionPortConfigured({
    ...env,
    ARIES_MARKETING_EXECUTION_PROVIDER: 'hermes',
  });
  assertHermesSocialContentRuntimeConfigured(env);

  if (shouldProbeHermesOnStartup(env)) {
    const probeHermesRuntime =
      dependencies.probeHermesRuntime ?? probeHermesSocialContentRuntime;
    const wait = dependencies.sleep ?? sleep;
    const warn = dependencies.warn ?? console.warn;
    let report: HermesSocialContentRuntimeReport | null = null;

    for (let attempt = 0; attempt <= HERMES_STARTUP_PROBE_BACKOFF_MS.length; attempt += 1) {
      report = await probeHermesRuntime(env);
      if (report.ok) {
        break;
      }
      if (!isTransientHermesStartupFailure(report)) {
        throw new Error(
          `[startup] Hermes social-content runtime probe failed permanently against ${report.gateway.url}. ${hermesStartupFailureDetail(report)}`,
        );
      }
      if (attempt < HERMES_STARTUP_PROBE_BACKOFF_MS.length) {
        await wait(HERMES_STARTUP_PROBE_BACKOFF_MS[attempt]);
      }
    }

    if (report && !report.ok) {
      const gatewayUrl = report.gateway.url;
      const detail = hermesStartupFailureDetail(report);
      warn(
        `[startup] Hermes social-content runtime probe failed after ${HERMES_STARTUP_PROBE_BACKOFF_MS.length + 1} attempts against ${gatewayUrl}; continuing in degraded mode. ${detail}`,
      );
    }
  }

  if (partnerAttributionEnabled() && !partnerAttributionDeliveryConfigured()) {
    console.warn(
      '[startup] PARTNER_ATTRIBUTION_ENABLED is on but VMS_BASE_URL or VMS_WEBHOOK_SECRET is missing; partner delivery is disabled until configured.',
    );
  }
}
