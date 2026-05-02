import { runAriesOpenClawWorkflow } from '../openclaw/aries-execution';
import { ExecutionError } from './errors';
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

class LegacyOpenClawWorkflowProvider implements ExecutionProvider {
  readonly name = DEFAULT_EXECUTION_PROVIDER;

  runWorkflow(key: string, input: Record<string, unknown>): Promise<WorkflowExecutionResult> {
    return runAriesOpenClawWorkflow(key as AriesWorkflowKey, input);
  }
}

class HermesExecutionProviderStub implements ExecutionProvider {
  readonly name = 'hermes' as const;

  async runWorkflow(): Promise<WorkflowExecutionResult> {
    return {
      kind: 'gateway_error',
      error: new ExecutionError({
        provider: 'hermes',
        code: 'not_configured',
        status: 503,
        message:
          'ARIES_EXECUTION_PROVIDER=hermes is not implemented yet. Set HERMES_GATEWAY_URL and HERMES_GATEWAY_TOKEN when the Hermes execution adapter lands; HERMES_SESSION_KEY stays optional.',
      }),
    };
  }
}

export function getExecutionProvider(env: ExecutionProviderEnv = process.env): ExecutionProvider {
  const providerName = resolveExecutionProviderName(env);
  if (providerName === 'hermes') {
    return new HermesExecutionProviderStub();
  }
  return new LegacyOpenClawWorkflowProvider();
}
