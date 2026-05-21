import { HermesExecutionAdapter } from './providers/hermes';
import type { ExecutionProvider } from './types';

export const DEFAULT_EXECUTION_PROVIDER = 'hermes' as const;

export type AriesExecutionProviderName = typeof DEFAULT_EXECUTION_PROVIDER;

type ExecutionProviderEnv = Partial<Record<string, string | undefined>>;

/**
 * Resolve the configured execution provider name.
 *
 * Hermes is the sole execution provider. `ARIES_EXECUTION_PROVIDER` is retained
 * as a forward-compatible selector — any value resolves to Hermes today.
 */
export function resolveExecutionProviderName(
  _env: ExecutionProviderEnv = process.env,
): AriesExecutionProviderName {
  return DEFAULT_EXECUTION_PROVIDER;
}

export function getExecutionProvider(env: ExecutionProviderEnv = process.env): ExecutionProvider {
  return new HermesExecutionAdapter(env);
}
