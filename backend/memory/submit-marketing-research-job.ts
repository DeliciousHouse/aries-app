import { randomBytes } from 'node:crypto';

import { hashCallbackToken } from '@/lib/internal-callback-auth';
import type { TenantContext } from '@/lib/tenant-context';
import { TenantMemoryClient } from './honcho-client';
import { HonchoHttpTransport } from './honcho-http-transport';
import { dispatchResearchJob } from './hermes-dispatch';
import { createMemoryOrchestrator } from './orchestrator';
import { createJob, ensureResearchJobSchema, setStatus } from './research-jobs';

export type MarketingResearchBridgeInput = {
  marketingJobId: string;
  jobType: 'brand_campaign' | 'weekly_social_content';
  brandUrl: string;
  competitorUrl?: string | null;
  competitorBrand?: string | null;
};

type MemoryTenantCtx = Pick<TenantContext, 'tenantId' | 'tenantSlug' | 'userId' | 'role'>;

export type SubmitMarketingResearchMemoryResult =
  | { ok: true; jobId: string }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; error: string };

function researchEnabled(env: Partial<Record<string, string | undefined>>): boolean {
  const v = env.ARIES_RESEARCH_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function readTokenBudget(env: Partial<Record<string, string | undefined>>): number {
  const raw = env.ARIES_RESEARCH_MEMORY_TOKEN_BUDGET?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4096;
}

/**
 * When {@link ARIES_RESEARCH_ENABLED} is truthy, creates an `aries_research_jobs` row,
 * loads approved tenant memory for Hermes context, and POSTs to {@link HERMES_RESEARCH_WEBHOOK_URL}.
 * Failures return `ok: false` and must not throw — callers decide whether to log or abort.
 */
export async function submitMarketingResearchMemoryJob(
  ctx: MemoryTenantCtx,
  input: MarketingResearchBridgeInput,
  env: Partial<Record<string, string | undefined>> = process.env,
): Promise<SubmitMarketingResearchMemoryResult> {
  if (!researchEnabled(env)) {
    return { ok: false, skipped: true, reason: 'aries_research_disabled' };
  }

  try {
    await ensureResearchJobSchema();
  } catch (err) {
    return { ok: false, error: `research_job_schema: ${err instanceof Error ? err.message : String(err)}` };
  }

  const memoryCtx: MemoryTenantCtx = {
    tenantId: ctx.tenantId,
    tenantSlug: ctx.tenantSlug ?? '',
    userId: ctx.userId,
    role: ctx.role,
  };

  const transport = new HonchoHttpTransport(env);
  const client = new TenantMemoryClient(transport);
  const orchestrator = createMemoryOrchestrator(client);

  let memoryContext;
  try {
    const loaded = await orchestrator.loadResearchMemoryContext(memoryCtx, {
      peers: [{ kind: 'brand' }, { kind: 'policy' }],
      tokenBudget: readTokenBudget(env),
    });
    memoryContext = loaded.memoryContext;
  } catch (err) {
    return { ok: false, error: `memory_context: ${err instanceof Error ? err.message : String(err)}` };
  }

  const callbackToken = randomBytes(32).toString('hex');
  const callbackTokenHash = hashCallbackToken(callbackToken);

  const taskSpec: Record<string, unknown> = {
    source: 'marketing_research_stage',
    marketing_job_id: input.marketingJobId,
    job_type: input.jobType,
    brand_url: input.brandUrl,
    competitor_url: input.competitorUrl ?? null,
    competitor_brand: input.competitorBrand ?? null,
  };

  const job = await createJob(ctx, taskSpec, callbackTokenHash);

  const dispatch = await dispatchResearchJob(
    ctx,
    {
      jobId: job.id,
      taskSpec,
      memoryContext,
      callbackToken,
    },
    env,
  );

  if (!dispatch.ok) {
    await setStatus(job.id, 'failed');
    return { ok: false, error: dispatch.error };
  }

  await setStatus(job.id, 'submitted');
  return { ok: true, jobId: job.id };
}
