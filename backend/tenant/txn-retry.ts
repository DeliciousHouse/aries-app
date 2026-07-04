/**
 * Bounded deadlock/serialization retry for the membership mutation transactions
 * (multi-workspace Phase 4 hardening — the two follow-ups recorded in PR #764).
 *
 * The membership CRUD + accept paths take row locks across MORE than one table
 * (users, organization_memberships, workspace_invitations) and additionally
 * take FK SHARE locks on `users` when they INSERT an
 * organization_membership_events row (which references BOTH user_id and
 * actor_user_id). Two symmetric concurrent operations can acquire these in
 * OPPOSING order, so Postgres resolves the race by aborting one arm with
 * SQLSTATE 40P01 (deadlock_detected) — BEFORE the E4 last-admin guard's
 * FOR UPDATE has a chance to serialize them and return its graceful `last_admin`
 * 409. Without a retry, that surfaces to the admin as a retriable 500 instead
 * of the clean guard result. Observed cases (tests/tenant/
 * multi-workspace-phase2-concurrency.requires-infra.test.ts):
 *   - symmetric last-admin demotes (A demotes B while B demotes A);
 *   - accept-vs-revoke (an invitee accepts as the admin removes the membership).
 *
 * Each guarded function does its own BEGIN … COMMIT and ROLLBACKs + re-throws
 * on any error, so when a deadlock abort propagates out the connection is
 * already clean — the wrapper simply re-invokes the whole function. The retry
 * is BOUNDED (default 5 attempts) and only retries the deadlock/serialization
 * SQLSTATEs; any other error (or exhausting the budget) re-throws unchanged, so
 * a genuine bug is never masked or spun on. On retry the operation re-reads
 * committed state under fresh locks, so the loser now sees the winner's
 * committed row and reaches the graceful path (`last_admin` / `not_join` /
 * idempotent convergence).
 *
 * Between attempts it waits a short JITTERED backoff. This matters for the
 * SYMMETRIC races (A demotes B while B demotes A): if both arms retried in
 * lockstep they would re-collide and re-deadlock indefinitely; a small random
 * delay desynchronizes them so one wins the row locks cleanly on the retry.
 */

/** SQLSTATEs under which Postgres SAFELY aborts one arm of a concurrent race. */
const RETRYABLE_SQLSTATES = new Set(['40P01', '40001']);

function isRetryableConflict(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && RETRYABLE_SQLSTATES.has(code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withDeadlockRetry<T>(
  operation: () => Promise<T>,
  options: { maxAttempts?: number; label?: string; baseBackoffMs?: number } = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const baseBackoffMs = Math.max(0, options.baseBackoffMs ?? 8);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableConflict(error) || attempt === maxAttempts) {
        throw error;
      }
      lastError = error;
      console.warn('[txn-retry] retrying after serialization/deadlock abort', {
        label: options.label ?? 'membership-txn',
        attempt,
        maxAttempts,
        code: (error as { code?: string }).code,
      });
      // Jittered backoff: grows with the attempt and randomizes so two symmetric
      // arms do not retry in lockstep and re-deadlock.
      if (baseBackoffMs > 0) {
        await sleep(baseBackoffMs * attempt * (0.5 + Math.random()));
      }
    }
  }
  // Unreachable (the loop either returns or throws), but satisfies the type.
  throw lastError;
}
