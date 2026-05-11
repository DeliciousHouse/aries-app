import type { Pool, PoolClient } from 'pg';

import { postAriesSignup, type AriesSignupPayload, type VmsPostResult } from '@/backend/partners/vms-client';
import { partnerAttributionDeliveryConfigured } from '@/lib/partner-attribution-env';

export type PartnerAttributionEnqueueInput = {
  userId: string;
  refCode: string;
  name: string;
  email: string;
  company?: string | null;
  domain?: string | null;
};

export async function enqueuePartnerAttribution(
  client: PoolClient,
  input: PartnerAttributionEnqueueInput,
): Promise<void> {
  if (!partnerAttributionDeliveryConfigured()) {
    return;
  }

  await client.query(
    `
      INSERT INTO partner_attribution_outbox (
        user_id,
        ref_code,
        name,
        email,
        company,
        domain
      )
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [
      input.userId,
      input.refCode,
      input.name,
      input.email,
      input.company ?? null,
      input.domain ?? null,
    ],
  );
}

/** Exported for unit tests; must match worker retry semantics. */
export function computePartnerAttributionBackoffSeconds(attemptsAfterIncrement: number): number {
  return Math.min(30 * 2 ** Math.max(0, attemptsAfterIncrement - 1), 3600);
}

export async function drainPartnerAttributionOutboxOnce(
  client: PoolClient,
  poster: (payload: AriesSignupPayload) => Promise<VmsPostResult> = postAriesSignup,
): Promise<number> {
  if (!partnerAttributionDeliveryConfigured()) {
    return 0;
  }

  await client.query('BEGIN');
  let processed = 0;
  try {
    const pick = await client.query(
      `
        SELECT id, user_id, ref_code, name, email, company, domain, attempts
        FROM partner_attribution_outbox
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `,
    );

    if ((pick.rowCount ?? 0) === 0) {
      await client.query('COMMIT');
      return 0;
    }

    const row = pick.rows[0] as {
      id: string;
      user_id: string;
      ref_code: string;
      name: string;
      email: string;
      company: string | null;
      domain: string | null;
      attempts: number;
    };

    const result = await poster({
      refCode: row.ref_code,
      name: row.name,
      email: row.email,
      company: row.company,
      domain: row.domain,
    });

    if (result.ok) {
      await client.query(
        `
          UPDATE partner_attribution_outbox
          SET status = 'delivered',
              delivered_at = now(),
              last_error = NULL
          WHERE id = $1
        `,
        [row.id],
      );
      processed = 1;
      await client.query('COMMIT');
      return processed;
    }

    const nextAttempts = row.attempts + 1;
    const lastErr = result.bodySnippet ?? `http_${result.status}`;

    if (result.terminalReason === 'unauthorized') {
      console.error('vms_webhook_auth_failed', {
        outboxId: row.id,
        userId: row.user_id,
        status: result.status,
      });
    }

    if (!result.retryable || nextAttempts >= 10) {
      await client.query(
        `
          UPDATE partner_attribution_outbox
          SET status = 'dead',
              attempts = $2,
              last_error = $3
          WHERE id = $1
        `,
        [row.id, nextAttempts, lastErr],
      );
      processed = 1;
      await client.query('COMMIT');
      return processed;
    }

    const delay = computePartnerAttributionBackoffSeconds(nextAttempts);
    await client.query(
      `
        UPDATE partner_attribution_outbox
        SET attempts = $2,
            last_error = $3,
            next_attempt_at = now() + ($4 * interval '1 second')
        WHERE id = $1
      `,
      [row.id, nextAttempts, lastErr, delay],
    );
    processed = 1;
    await client.query('COMMIT');
    return processed;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

export async function drainPartnerAttributionOutboxBatch(
  pool: Pool,
  maxRows = 25,
  poster: (payload: AriesSignupPayload) => Promise<VmsPostResult> = postAriesSignup,
): Promise<number> {
  const client = await pool.connect();
  let total = 0;
  try {
    for (let i = 0; i < maxRows; i += 1) {
      const n = await drainPartnerAttributionOutboxOnce(client, poster);
      total += n;
      if (n === 0) {
        break;
      }
    }
    return total;
  } finally {
    client.release();
  }
}
