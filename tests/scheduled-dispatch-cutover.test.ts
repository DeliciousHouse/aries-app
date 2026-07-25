import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);

type ScheduledDispatchCutoverClient = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>;
};

const { quarantineLegacyScheduledDispatches } = require('../scripts/scheduled-dispatch-cutover.js') as {
  quarantineLegacyScheduledDispatches: (
    client: ScheduledDispatchCutoverClient,
  ) => Promise<{ quarantined: number }>;
};

type LegacyRow = {
  id: number;
  dispatchStatus: 'in_flight' | 'manual_reconciliation';
  dispatchStartedAt: string | null;
};

class CutoverFixture implements ScheduledDispatchCutoverClient {
  readonly rows: LegacyRow[] = [];
  commits = 0;
  rollbacks = 0;

  async query(sql: string): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    const normalized = sql.trim();
    if (normalized === 'BEGIN') return { rows: [], rowCount: 0 };
    if (normalized === 'COMMIT') {
      this.commits += 1;
      return { rows: [], rowCount: 0 };
    }
    if (normalized === 'ROLLBACK') {
      this.rollbacks += 1;
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith('SET LOCAL lock_timeout')) return { rows: [], rowCount: 0 };
    if (normalized.startsWith('ALTER TABLE scheduled_posts')) return { rows: [], rowCount: 0 };
    if (normalized.includes('WITH legacy AS')) {
      const legacy = this.rows.filter(
        (row) => row.dispatchStatus === 'in_flight' && row.dispatchStartedAt === null,
      );
      for (const row of legacy) row.dispatchStatus = 'manual_reconciliation';
      return { rows: [{ quarantined: legacy.length }], rowCount: 1 };
    }
    throw new Error(`unexpected cutover SQL: ${normalized.slice(0, 80)}`);
  }
}

test('two deploys quarantine a legacy row created after deploy-one rollback restores the old worker', async () => {
  const fixture = new CutoverFixture();
  fixture.rows.push({ id: 1, dispatchStatus: 'in_flight', dispatchStartedAt: null });

  const deployOne = await quarantineLegacyScheduledDispatches(fixture);
  assert.equal(deployOne.quarantined, 1);
  assert.equal(fixture.rows[0]?.dispatchStatus, 'manual_reconciliation');

  // A later deploy gate fails and restores the exact pre-fence worker. That old
  // worker can create another in-flight row without dispatch_started_at.
  fixture.rows.push({ id: 2, dispatchStatus: 'in_flight', dispatchStartedAt: null });

  const deployTwo = await quarantineLegacyScheduledDispatches(fixture);
  assert.equal(deployTwo.quarantined, 1);
  assert.equal(fixture.rows[1]?.dispatchStatus, 'manual_reconciliation');
  assert.equal(fixture.commits, 2, 'the idempotent quarantine runs on every deploy/start');
  assert.equal(fixture.rollbacks, 0);
});

test('cutover never quarantines a provider-fenced in-flight attempt', async () => {
  const fixture = new CutoverFixture();
  fixture.rows.push({
    id: 3,
    dispatchStatus: 'in_flight',
    dispatchStartedAt: '2026-07-25T00:00:00.000Z',
  });

  const result = await quarantineLegacyScheduledDispatches(fixture);
  assert.equal(result.quarantined, 0);
  assert.equal(fixture.rows[0]?.dispatchStatus, 'in_flight');
});