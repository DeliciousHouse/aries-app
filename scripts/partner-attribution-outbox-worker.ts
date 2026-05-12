import 'dotenv/config';

import { drainPartnerAttributionOutboxBatch } from '@/backend/partners/outbox';
import pool from '@/lib/db';
import { partnerAttributionEnabled } from '@/lib/partner-attribution-env';

const INTERVAL_MS = 30_000;

async function tick(): Promise<void> {
  try {
    const n = await drainPartnerAttributionOutboxBatch(pool);
    if (n > 0) {
      console.log(`[partner-outbox-worker] processed ${n} outbox row(s)`);
    }
  } catch (err) {
    console.error('[partner-outbox-worker] tick failed', err);
  }
}

async function main(): Promise<void> {
  if (!partnerAttributionEnabled()) {
    console.log('[partner-outbox-worker] PARTNER_ATTRIBUTION_ENABLED is off; exiting.');
    process.exit(0);
  }

  await tick();
  setInterval(() => {
    void tick();
  }, INTERVAL_MS);
}

void main();
