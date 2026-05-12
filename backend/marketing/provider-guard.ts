/**
 * Marketing execution provider guard.
 *
 * This module handles provider selection and fail-fast configuration
 * validation for the full orchestrator, including the legacy OpenClaw opt-in
 * path. It is intentionally separate from execution-port.ts so that
 * social-content routes can import the Hermes-only execution contract without
 * pulling in legacy references.
 */

export type MarketingProviderName = 'hermes' | 'legacy-openclaw';

type ProviderEnv = Partial<Record<string, string | undefined>>;

/**
 * Resolve which marketing execution provider is active.
 *
 * Hermes is the default. The deprecated legacy OpenClaw path is activated only
 * by an explicit ARIES_MARKETING_EXECUTION_PROVIDER=legacy-openclaw opt-in.
 * Any other unrecognised value also falls through to Hermes.
 */
export function resolveMarketingProviderName(
  env: ProviderEnv = process.env,
): MarketingProviderName {
  const value = typeof env.ARIES_MARKETING_EXECUTION_PROVIDER === 'string'
    ? env.ARIES_MARKETING_EXECUTION_PROVIDER.trim().toLowerCase()
    : '';
  if (value === 'legacy-openclaw') return 'legacy-openclaw';
  return 'hermes';
}

/**
 * Throw a descriptive error when the execution environment is misconfigured.
 *
 * On the default Hermes path, HERMES_GATEWAY_URL must be present. If neither
 * Hermes is configured nor an explicit legacy-openclaw opt-in is set, we fail
 * fast rather than silently returning a configuration-error embedded in the
 * execution result (which would surface as a runtime marketing job failure
 * with no operator-visible explanation at startup time).
 */
export function assertMarketingExecutionPortConfigured(
  env: ProviderEnv = process.env,
): void {
  const provider = resolveMarketingProviderName(env);
  if (provider === 'legacy-openclaw') {
    // Legacy path explicitly opted in — no Hermes configuration required.
    // The LegacyOpenClawMarketingPort handles its own env checks at call time.
    return;
  }
  const hermesGatewayUrl = typeof env.HERMES_GATEWAY_URL === 'string'
    ? env.HERMES_GATEWAY_URL.trim()
    : '';
  if (!hermesGatewayUrl) {
    throw new Error(
      'Marketing execution is not configured: HERMES_GATEWAY_URL is required ' +
      'when ARIES_MARKETING_EXECUTION_PROVIDER is not set to "legacy-openclaw". ' +
      'Set HERMES_GATEWAY_URL to enable Hermes-based execution, or set ' +
      'ARIES_MARKETING_EXECUTION_PROVIDER=legacy-openclaw to use the deprecated OpenClaw path.',
    );
  }
}
