import type { TenantContext } from '@/lib/tenant-context';
import { pseudonymForTenant } from './pseudonym';
import type { ResearchMemoryContextEntry } from './orchestrator';

export type DispatchResearchJobInput = {
  jobId: string;
  taskSpec: Record<string, unknown>;
  memoryContext: ResearchMemoryContextEntry[];
  callbackToken: string;
};

export type DispatchResearchJobResult = {
  ok: true;
} | {
  ok: false;
  error: string;
  status?: number;
};

type DispatchEnv = Partial<Record<string, string | undefined>>;
type DispatchFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export async function dispatchResearchJob(
  ctx: Pick<TenantContext, 'tenantId'>,
  input: DispatchResearchJobInput,
  env: DispatchEnv = process.env,
  fetchImpl: DispatchFetch = globalThis.fetch,
): Promise<DispatchResearchJobResult> {
  const webhookUrl = env.HERMES_RESEARCH_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    return { ok: false, error: 'HERMES_RESEARCH_WEBHOOK_URL not configured' };
  }

  const apiKey = env.HERMES_API_SERVER_KEY?.trim();
  if (!apiKey) {
    return { ok: false, error: 'HERMES_API_SERVER_KEY not configured' };
  }

  const appBaseUrl = env.APP_BASE_URL?.trim();
  if (!appBaseUrl) {
    return { ok: false, error: 'APP_BASE_URL not configured' };
  }

  const tenantPseudonym = pseudonymForTenant(ctx.tenantId, env);

  const payload = {
    jobId: input.jobId,
    taskSpec: input.taskSpec,
    tenantPseudonym,
    memoryContext: input.memoryContext,
    callbackUrl: `${appBaseUrl.replace(/\/$/, '')}/api/internal/aries-research/callback`,
    callbackToken: input.callbackToken,
  };

  let response: Response;
  try {
    response = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Hermes request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: `Hermes returned ${response.status}`,
      status: response.status,
    };
  }

  return { ok: true };
}
