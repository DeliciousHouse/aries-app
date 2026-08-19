import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  deriveConnectionNudgeKind,
  runConnectionHealthNudges,
  type ConnectionHealthNudgeDb,
  type ConnectionHealthNudgeEmail,
} from '@/backend/tenant/connection-health-nudges';

const NOW = new Date('2026-08-12T12:00:00.000Z');
const ON = { ARIES_CONNECTION_NUDGES_ENABLED: '1', APP_BASE_URL: 'https://aries.example.com' };
const workerSource = readFileSync(
  new URL('../scripts/automations/usage-rollup-worker.ts', import.meta.url),
  'utf8',
);
const migrationSource = readFileSync(
  new URL('../migrations/20260819000000_connection_health_nudges.sql', import.meta.url),
  'utf8',
);
const initDbSource = readFileSync(new URL('../scripts/init-db.js', import.meta.url), 'utf8');
const composeSource = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');

type Candidate = {
  source: 'connected_accounts' | 'oauth_connections';
  connection_id: string;
  tenant_id: number;
  organization_name: string;
  platform: string;
  status: 'pending' | 'reauthorization_required';
  status_changed_at: string;
};

function harness(candidates: Candidate[], claimed = new Set<string>()) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const sent: ConnectionHealthNudgeEmail[] = [];
  const db: ConnectionHealthNudgeDb = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.includes('WITH connection_candidates')) {
        return { rows: candidates, rowCount: candidates.length };
      }
      if (sql.includes('FROM organization_memberships')) {
        return { rows: [{ email: 'owner@example.com' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO connection_nudge_notifications')) {
        const key = params.join(':');
        if (claimed.has(key)) return { rows: [], rowCount: 0 };
        claimed.add(key);
        return { rows: [{}], rowCount: 1 };
      }
      throw new Error(`Unhandled SQL: ${sql}`);
    },
  };
  const send = async (email: ConnectionHealthNudgeEmail) => {
    sent.push(email);
  };
  return { db, calls, sent, send, claimed };
}

test('reauthorization_required triggers immediately', () => {
  assert.equal(
    deriveConnectionNudgeKind('reauthorization_required', '2026-08-12T11:59:59.999Z', NOW),
    'reauthorization_required',
  );
});

test('pending triggers only after more than seven days', () => {
  assert.equal(deriveConnectionNudgeKind('pending', '2026-08-05T12:00:00.000Z', NOW), null);
  assert.equal(
    deriveConnectionNudgeKind('pending', '2026-08-05T11:59:59.999Z', NOW),
    'pending_over_7_days',
  );
  assert.equal(deriveConnectionNudgeKind('connected', '2026-07-01T00:00:00.000Z', NOW), null);
});

test('connection nudge sweep is dormant behind its rollout flag', async () => {
  const h = harness([]);
  const report = await runConnectionHealthNudges(h.db, { env: {}, now: () => NOW, send: h.send });

  assert.equal(report.skipped, true);
  assert.deepEqual(h.calls, []);
});

test('owner email fires for live production reauthorization and stale pending connections', async () => {
  const h = harness([
    {
      source: 'connected_accounts',
      connection_id: '61',
      tenant_id: 61,
      organization_name: 'Customer 61',
      platform: 'facebook',
      status: 'reauthorization_required',
      status_changed_at: '2026-08-12T10:00:00.000Z',
    },
    {
      source: 'oauth_connections',
      connection_id: '12',
      tenant_id: 12,
      organization_name: 'Customer 12',
      platform: 'linkedin',
      status: 'pending',
      status_changed_at: '2026-08-01T10:00:00.000Z',
    },
  ]);

  const report = await runConnectionHealthNudges(h.db, { env: ON, now: () => NOW, send: h.send });

  assert.equal(report.emailsSent, 2);
  assert.deepEqual(h.sent.map((email) => email.kind), [
    'reauthorization_required',
    'pending_over_7_days',
  ]);
  assert.ok(h.sent.every((email) => email.to === 'owner@example.com'));
  assert.ok(h.sent.every(
    (email) => email.reconnectUrl === 'https://aries.example.com/dashboard/settings/channel-integrations',
  ));

  const candidateSql = h.calls.find((call) => call.sql.includes('WITH connection_candidates'))?.sql ?? '';
  assert.match(candidateSql, /o\.kind = 'production'/i);
});

test('durable claim happens before send and suppresses a later sweep', async () => {
  const candidate: Candidate = {
    source: 'connected_accounts',
    connection_id: '61',
    tenant_id: 61,
    organization_name: 'Customer 61',
    platform: 'facebook',
    status: 'reauthorization_required',
    status_changed_at: '2026-08-12T10:00:00.000Z',
  };
  const claimed = new Set<string>();
  const first = harness([candidate], claimed);
  const order: string[] = [];
  const db: ConnectionHealthNudgeDb = {
    query: async (sql, params) => {
      if (sql.includes('INSERT INTO connection_nudge_notifications')) order.push('claim');
      return first.db.query(sql, params);
    },
  };

  await runConnectionHealthNudges(db, {
    env: ON,
    now: () => NOW,
    send: async (email) => {
      order.push('send');
      await first.send(email);
    },
  });
  assert.deepEqual(order, ['claim', 'send']);

  const second = harness([candidate], claimed);
  const report = await runConnectionHealthNudges(second.db, {
    env: ON,
    now: () => NOW,
    send: second.send,
  });
  assert.equal(report.emailsSent, 0);
  assert.equal(report.deduped, 1);
});

test('a post-claim send failure is not retried, favoring no spam over duplicate mail', async () => {
  const candidate: Candidate = {
    source: 'connected_accounts',
    connection_id: '61',
    tenant_id: 61,
    organization_name: 'Customer 61',
    platform: 'facebook',
    status: 'reauthorization_required',
    status_changed_at: '2026-08-12T10:00:00.000Z',
  };
  const claimed = new Set<string>();
  const first = harness([candidate], claimed);
  let attempts = 0;

  const firstReport = await runConnectionHealthNudges(first.db, {
    env: ON,
    now: () => NOW,
    send: async () => {
      attempts += 1;
      throw new Error('transport state unknown');
    },
  });
  const second = harness([candidate], claimed);
  const secondReport = await runConnectionHealthNudges(second.db, {
    env: ON,
    now: () => NOW,
    send: async () => { attempts += 1; },
  });

  assert.equal(firstReport.claimed, 1);
  assert.equal(firstReport.errors, 1);
  assert.equal(secondReport.deduped, 1);
  assert.equal(attempts, 1);
});

test('existing hourly worker schedules the nudge sweep', () => {
  assert.match(workerSource, /runConnectionHealthNudges/);
  assert.match(workerSource, /connectionNudgesEnabled/);
  assert.match(
    composeSource,
    /ARIES_CONNECTION_NUDGES_ENABLED:\s*\$\{ARIES_CONNECTION_NUDGES_ENABLED:-0\}/,
  );
});

test('schema tracks status transitions and durably deduplicates each unhealthy state', () => {
  for (const source of [migrationSource, initDbSource]) {
    assert.match(source, /status_changed_at/i);
    assert.match(source, /set_connection_status_changed_at/i);
    assert.match(source, /connection_nudge_notifications/i);
    assert.match(source, /PRIMARY KEY \(source, connection_id, nudge_kind, status_changed_at\)/i);
  }
});
