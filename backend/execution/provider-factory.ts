import { runAriesOpenClawWorkflow } from '../openclaw/aries-execution';
import { HermesExecutionAdapter } from './providers/hermes';
import { mapLegacyOpenClawGatewayError } from './providers/legacy-openclaw';
import type { ExecutionProvider, WorkflowExecutionResult } from './types';
import type { AriesWorkflowKey } from './workflow-catalog';

export const DEFAULT_EXECUTION_PROVIDER = 'legacy-openclaw' as const;

export type AriesExecutionProviderName = typeof DEFAULT_EXECUTION_PROVIDER | 'hermes';

type ExecutionProviderEnv = Partial<Record<string, string | undefined>>;

function readEnvValue(env: ExecutionProviderEnv, key: string): string {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveExecutionProviderName(
  env: ExecutionProviderEnv = process.env,
): AriesExecutionProviderName {
  const configured = readEnvValue(env, 'ARIES_EXECUTION_PROVIDER').toLowerCase();

  switch (configured) {
    case '':
    case 'openclaw':
    case DEFAULT_EXECUTION_PROVIDER:
      return DEFAULT_EXECUTION_PROVIDER;
    case 'hermes':
      return 'hermes';
    default:
      return DEFAULT_EXECUTION_PROVIDER;
  }
}

// Note: the runtime provider identifier is 'openclaw' to match
// LegacyOpenClawExecutionAdapter.name and the provider value used on
// ExecutionError instances. DEFAULT_EXECUTION_PROVIDER ('legacy-openclaw') is
// the config-level selector exposed via ARIES_EXECUTION_PROVIDER and is
// intentionally distinct from the runtime provider name so that callers
// branching on provider.name or error.provider see a single identifier.
class LegacyOpenClawWorkflowProvider implements ExecutionProvider {
  readonly name = 'openclaw' as const;

  async runWorkflow(key: string, input: Record<string, unknown>): Promise<WorkflowExecutionResult> {
    const result = await runAriesOpenClawWorkflow(key as AriesWorkflowKey, input);
    if (result.kind === 'gateway_error') {
      return {
        kind: 'gateway_error',
        error: mapLegacyOpenClawGatewayError(result.error),
      };
    }
    return result;
  }
}

export function getExecutionProvider(env: ExecutionProviderEnv = process.env): ExecutionProvider {
  const providerName = resolveExecutionProviderName(env);
  if (providerName === 'hermes') {
    return new HermesExecutionAdapter(env);
  }
  return new LegacyOpenClawWorkflowProvider();
}
