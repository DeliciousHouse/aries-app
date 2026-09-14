import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import pg from 'pg';

import { collectAriesMetrics } from '@/backend/observability/prometheus-metrics';
import { runConnectionHealthNudges } from '@/backend/tenant/connection-health-nudges';
import { requireDbEnvOrSkip } from './helpers/requires-infra';

// Transaction-local schema: never alter the caller's application tables.
test('lifecycle migrations preserve transitions, dedupe nudges and join fleet health', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;
  const db = new pg.Client({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  await db.connect();
  try {
    await db.query("BEGIN; SET LOCAL TIME ZONE 'UTC'");
    await db.query(`CREATE SCHEMA lifecycle_${process.pid}; SET LOCAL search_path TO lifecycle_${process.pid}`);
    await db.query(`
      CREATE TABLE organizations (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE connected_accounts (
        id BIGINT PRIMARY KEY, tenant_id INTEGER, platform TEXT, provider TEXT, status TEXT,
        created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE oauth_connections (
        id BIGINT PRIMARY KEY, tenant_id INTEGER, provider TEXT, status TEXT,
        created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
      );
      INSERT INTO organizations VALUES (1, 'Customer'), (2, 'Canary'), (3, 'Archived');
      INSERT INTO connected_accounts (id, tenant_id, platform, provider, status, updated_at)
        VALUES (1, 1, 'facebook', 'composio', 'pending', '2026-01-01 00:00:00.123456+00'),
               (2, 2, 'facebook', 'composio', 'reauthorization_required', now()),
               (3, 3, 'facebook', 'composio', 'reauthorization_required', now());
    `);
    for (let pass = 0; pass < 2; pass++) {
      for (const name of ['organization_kind', 'connection_health_nudges']) {
        await db.query(readFileSync(new URL(`../migrations/20260819000000_${name}.sql`, import.meta.url), 'utf8'));
      }
    }
    assert.deepEqual((await db.query('SELECT kind FROM organizations ORDER BY id')).rows.map((r) => r.kind),
      ['production', 'production', 'production']);
    await db.query("UPDATE organizations SET kind = 'test' WHERE id = 2; UPDATE organizations SET kind = 'archived' WHERE id = 3");
    await db.query(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
      CREATE TABLE organization_memberships (organization_id INTEGER, user_id INTEGER, status TEXT, role TEXT);
      INSERT INTO users VALUES (1, 'owner@example.com');
      INSERT INTO organization_memberships VALUES (1, 1, 'active', 'tenant_admin');
      CREATE TABLE marketing_schedule (tenant_id INTEGER, enabled BOOLEAN, last_attempt_at TIMESTAMPTZ, last_success_at TIMESTAMPTZ);
      CREATE TABLE scheduled_posts (id INTEGER, tenant_id INTEGER, post_id INTEGER, dispatch_status TEXT);
      CREATE TABLE scheduled_post_dispatches (scheduled_post_id INTEGER, platform TEXT, status TEXT, dispatched_at TIMESTAMPTZ);
      CREATE TABLE posts (id INTEGER, tenant_id INTEGER, expired_at TIMESTAMPTZ, published_status TEXT, published_at TIMESTAMPTZ, platform_post_id TEXT, updated_at TIMESTAMPTZ);
    `);
    const sent: string[] = [];
    const env = { ARIES_CONNECTION_NUDGES_ENABLED: '1', APP_BASE_URL: 'https://aries.example.com' };
    const first = await runConnectionHealthNudges(db, { env, send: async (email) => { sent.push(email.to); } });
    assert.equal(first.candidates, 1, 'test and archived tenants are not nudge candidates');
    assert.equal(first.emailsSent, 1);
    const second = await runConnectionHealthNudges(db, { env, send: async () => { assert.fail('duplicate mail'); } });
    assert.equal(second.deduped, 1);
    assert.deepEqual(sent, ['owner@example.com']);
    const output = await collectAriesMetrics(db, { hermesUp: true, draftExpiryAgeDays: 14 });
    assert.match(output, /aries_connection_health_nudge_last_sent_timestamp_seconds\{tenant_id="1"/);
    assert.doesNotMatch(output, /tenant_id="[23]"/);
    const included = await collectAriesMetrics(db, { hermesUp: true, draftExpiryAgeDays: 14, tenantKinds: ['production', 'test'] });
    assert.match(included, /aries_connection_health_unhealthy\{tenant_id="2"/);
    await db.query("UPDATE connected_accounts SET status = status, updated_at = now() WHERE id = 1");
    assert.equal((await db.query('SELECT status_changed_at::text FROM connected_accounts WHERE id = 1')).rows[0].status_changed_at,
      '2026-01-01 00:00:00.123456+00');
    await db.query("UPDATE connected_accounts SET status = 'reauthorization_required' WHERE id = 1");
    const transition = await runConnectionHealthNudges(db, { env, send: async () => {} });
    assert.equal(transition.emailsSent, 1, 'a new unhealthy transition can nudge again');
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
});
