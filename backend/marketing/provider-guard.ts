/**
 * Marketing execution provider guard.
 *
 * Handles fail-fast configuration validation for the marketing orchestrator.
 * Hermes is the sole marketing execution provider.
 */

export type MarketingProviderName = 'hermes';

type ProviderEnv = Partial<Record<string, string | undefined>>;

/**
 * Resolve which marketing execution provider is active.
 *
 * Hermes is the sole provider. `ARIES_MARKETING_EXECUTION_PROVIDER` is retained
 * as a forward-compatible selector — any value resolves to Hermes today.
 */
export function resolveMarketingProviderName(
  _env: ProviderEnv = process.env,
): MarketingProviderName {
  return 'hermes';
}

/**
 * Throw a descriptive error when the execution environment is misconfigured.
 *
 * Scope: a narrow *startup-time* guard that validates HERMES_GATEWAY_URL. The
 * full set of Hermes env (HERMES_API_SERVER_KEY, INTERNAL_API_SECRET,
 * APP_BASE_URL) is validated inside HermesMarketingPort at call time so
 * port-level config bugs surface as a typed runtime error with provider
 * context rather than a misleading "your env is broken" message at
 * orchestrator boot.
 */
export function assertMarketingExecutionPortConfigured(
  env: ProviderEnv = process.env,
): void {
  const hermesGatewayUrl = typeof env.HERMES_GATEWAY_URL === 'string'
    ? env.HERMES_GATEWAY_URL.trim()
    : '';
  if (!hermesGatewayUrl) {
    throw new Error(
      'Marketing execution is not configured: HERMES_GATEWAY_URL is required ' +
      'to enable Hermes-based execution.',
    );
  }
}
