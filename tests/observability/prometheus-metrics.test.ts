import assert from 'node:assert/strict';
import test from 'node:test';

import { collectAriesMetrics } from '../../backend/observability/prometheus-metrics';

class FakeDb {
  index = 0;
  readonly queries: string[] = [];

  constructor(private readonly results: Array<Array<Record<string, unknown>>>) {}

  async query(text: string) {
    this.queries.push(text);
    return { rows: this.results[this.index++] ?? [] };
  }
}

test('exports dead-man, queue, publish, account, expiry and dependency metrics', async () => {
  const db = new FakeDb([
    [{ tenant_id: 61, last_attempt_at: '2026-08-11T10:00:00Z', last_success_at: '2026-08-09T09:00:00Z' }],
    [{ status: 'pending', count: '4' }, { status: 'in_flight', count: '1' }],
    [{ status: 'failed', count: '2' }, { status: 'dead_letter', count: '1' }],
    [{ tenant_id: 61, platform: 'instagram', last_success_at: '2026-08-10T08:00:00Z' }],
    [{ tenant_id: 61, provider: 'composio', platform: 'instagram', status: 'reauthorization_required', count: '1' }],
    [
      { tenant_id: 61, platform: 'instagram', reason: 'reauthorization_required', last_nudge_at: '2026-08-11T12:00:00Z' },
      { tenant_id: 12, platform: 'facebook', reason: 'pending_over_7_days', last_nudge_at: null },
    ],
    [{ expired_count: '7', expiring_24h_count: '3' }],
  ]);

  const output = await collectAriesMetrics(db, { hermesUp: false, draftExpiryAgeDays: 14 });

  assert.match(output, /aries_marketing_trigger_last_attempt_timestamp_seconds\{tenant_id="61"\} 1786442400/);
  assert.match(output, /aries_marketing_trigger_last_success_timestamp_seconds\{tenant_id="61"\} 1786266000/);
  assert.match(output, /aries_dispatch_queue_depth\{status="pending"\} 4/);
  assert.match(output, /aries_dispatch_failed_count\{status="dead_letter"\} 1/);
  assert.match(output, /aries_last_successful_publish_timestamp_seconds\{tenant_id="61",platform="instagram"\} 1786348800/);
  assert.match(output, /aries_connected_accounts\{provider="composio",platform="instagram",status="reauthorization_required"\} 1/);
  assert.match(output, /aries_connection_health_unhealthy\{tenant_id="61",platform="instagram",reason="reauthorization_required"\} 1/);
  assert.match(output, /aries_connection_health_unhealthy\{tenant_id="12",platform="facebook",reason="pending_over_7_days"\} 1/);
  assert.match(output, /aries_connection_health_nudge_last_sent_timestamp_seconds\{tenant_id="61",platform="instagram",reason="reauthorization_required"\} 1786449600/);
  assert.match(output, /aries_expiry_sweep_posts_total\{result="expired"\} 7/);
  assert.match(output, /aries_drafts_expiring_24h 3/);
  assert.match(output, /aries_external_dependency_up\{dependency="hermes"\} 0/);
  assert.match(output, /aries_external_dependency_degraded\{dependency="composio",tenant_id="61",platform="instagram"\} 1/);
  assert.match(output, /aries_external_dependency_up\{dependency="platform_api",tenant_id="61",platform="instagram"\} 0/);

  const healthSql = db.queries.find((sql) => sql.includes('WITH current_connections')) ?? '';
  assert.match(healthSql, /kind\s*=\s*'production'/i);
  assert.match(healthSql, /INTERVAL '7 days'/i);
});

test('escapes bounded Prometheus label values', async () => {
  const db = new FakeDb([[], [], [], [], [
    { tenant_id: 1, provider: 'composio', platform: 'x"\\\n', status: 'connected', count: 1 },
  ], [], [{ expired_count: 0, expiring_24h_count: 0 }]]);

  const output = await collectAriesMetrics(db, { hermesUp: true, draftExpiryAgeDays: 14 });
  assert.match(output, /platform="x\\"\\\\\\n"/);
});
