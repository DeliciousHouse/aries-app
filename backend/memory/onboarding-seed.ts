import type { TenantContext } from '@/lib/tenant-context';
import { curateFinding } from './curator';
import type { CurateOptions } from './curator';
import { TenantMemoryClient } from './honcho-client';
import { HonchoHttpTransport } from './honcho-http-transport';
import type { CandidateFinding, CuratorOutcome } from './types';

export type OnboardingSeedInput = {
  runId: string;
  candidates: CandidateFinding[];
};

export type OnboardingSeedFindingResult = {
  finding: CandidateFinding;
  outcome: CuratorOutcome;
  messageId?: string;
};

export type OnboardingSeedResult = {
  results: OnboardingSeedFindingResult[];
  counts: {
    approved: number;
    queued: number;
    dropped: number;
  };
};

type MinimalCtx = Pick<TenantContext, 'tenantId' | 'tenantSlug' | 'userId' | 'role'>;

export async function seedOnboardingMemory(
  ctx: MinimalCtx,
  input: OnboardingSeedInput,
  clientOverride?: TenantMemoryClient,
): Promise<OnboardingSeedResult> {
  const client = clientOverride ?? new TenantMemoryClient(new HonchoHttpTransport());
  const seedJobId = `onboarding-${input.runId}`;
  const curateOpts: CurateOptions = { jobId: seedJobId };

  const results: OnboardingSeedFindingResult[] = [];
  let approved = 0;
  let queued = 0;
  let dropped = 0;

  for (const candidate of input.candidates) {
    const outcome = curateFinding(candidate, curateOpts);

    if (outcome.decision === 'auto_approve') {
      const peerRef =
        outcome.peer === 'brand' ? { kind: 'brand' as const }
        : outcome.peer === 'policy' ? { kind: 'policy' as const }
        : null;

      if (peerRef) {
        const { messageId } = await client.appendApprovedMessage({
          ctx,
          peer: peerRef,
          session: { kind: 'onboarding', runId: input.runId },
          message: outcome.approved,
        });
        results.push({ finding: candidate, outcome, messageId });
        approved++;
        continue;
      }

      const queuedOutcome: CuratorOutcome = {
        decision: 'queue_for_review',
        peer: outcome.peer,
        reason: 'auto_approve_peer_not_supported_for_onboarding_append',
      };
      results.push({ finding: candidate, outcome: queuedOutcome });
      queued++;
      continue;
    }

    results.push({ finding: candidate, outcome });
    if (outcome.decision === 'queue_for_review') {
      queued++;
    } else {
      dropped++;
    }
  }

  return { results, counts: { approved, queued, dropped } };
}
