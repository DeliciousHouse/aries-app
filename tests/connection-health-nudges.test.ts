import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
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
const composeSource = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');

type Candidate = {
  source: 'connected_accounts' | 'oauth_connections';
  connection_id: string;
  tenant_id: number;
  organization_name: string;
  platform: string;
  status: 'pending' | 'reauthorization_required';
  status_changed_at: string;
  nudge_kind: 'reauthorization_required' | 'pending_over_7_days';
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

test('connection nudge sweep is dormant behind its rollout flag', async () => {
  const h = harness([]);
  const report = await runConnectionHealthNudges(h.db, { env: {}, now: () => NOW, send: h.send });
  assert.equal(report.skipped, true);
  assert.deepEqual(h.calls, []);
});

test('the existing hourly worker schedules nudges without adding another sidecar', () => {
  assert.match(workerSource, /runConnectionHealthNudges/);
  assert.match(workerSource, /connectionNudgesEnabled/);
  assert.match(composeSource, /ARIES_CONNECTION_NUDGES_ENABLED:\s*\$\{ARIES_CONNECTION_NUDGES_ENABLED:-0\}/);
});

test('owner nudge email fires for reauthorization and stale pending live production connections', async () => {
  const h = harness([
    {
      source: 'connected_accounts',
      connection_id: '61',
      tenant_id: 61,
      organization_name: 'Customer 61',
      platform: 'facebook',
      status: 'reauthorization_required',
      status_changed_at: '2026-08-12T10:00:00.000Z',
      nudge_kind: 'reauthorization_required',
    },
    {
      source: 'connected_accounts',
      connection_id: '12',
      tenant_id: 12,
      organization_name: 'Customer 12',
      platform: 'facebook',
      status: 'pending',
      status_changed_at: '2026-08-01T10:00:00.000Z',
      nudge_kind: 'pending_over_7_days',
    },
  ]);

  const report = await runConnectionHealthNudges(h.db, { env: ON, now: () => NOW, send: h.send });

  assert.equal(report.emailsSent, 2);
  assert.deepEqual(h.sent.map((email) => email.kind), [
    'reauthorization_required',
    'pending_over_7_days',
  ]);
  assert.ok(h.sent.every((email) => email.to === 'owner@example.com'));
  assert.ok(h.sent.every((email) => email.reconnectUrl === 'https://aries.example.com/dashboard/settings/channel-integrations'));

  const candidateSql = h.calls.find((call) => call.sql.includes('WITH connection_candidates'))?.sql ?? '';
  assert.match(candidateSql, /o\.kind = 'production'/i, 'test and archived tenants must be excluded by default');
  assert.match(candidateSql, /INTERVAL '7 days'/i);
});

test('nudge claim is durable and happens before send, so a later sweep does not spam', async () => {
  const candidate: Candidate = {
    source: 'connected_accounts',
    connection_id: '61',
    tenant_id: 61,
    organization_name: 'Customer 61',
    platform: 'facebook',
    status: 'reauthorization_required',
    status_changed_at: '2026-08-12T10:00:00.000Z',
    nudge_kind: 'reauthorization_required',
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
