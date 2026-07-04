/**
 * Multi-workspace Phase 4 — the set-user-plan grant CLI
 * (scripts/billing/set-user-plan.ts, plan Decision 13). This is the v1 WRITER of
 * `users.plan` — the manual alternative to a payment processor. It must:
 *   - validate its args and exit NONZERO on a bad plan value / missing email,
 *     writing nothing;
 *   - on a valid grant, set plan + plan_granted_at + plan_granted_by;
 *   - be idempotent (safe to re-run) and case-insensitive on email (one email =
 *     one account via the LOWER(email) unique index).
 *
 * Two levels, matching how the repo tests its CLIs (spawnSync of the tsx script,
 * cf. tests/hermes-kanban-gc-worker.test.ts):
 *   1. VALIDATION (hermetic, no DB): a bad/absent plan or absent email exits 1
 *      BEFORE any query runs — proven by pointing DB_* at an unreachable socket
 *      and asserting the process still exits fast + nonzero (validation short-
 *      circuits before the pool is ever queried).
 *   2. WRITE + IDEMPOTENCY + CASE-INSENSITIVITY (requires-infra): against a
 *      reachable throwaway Postgres, the CLI flips a real users row's plan and
 *      stamps the audit columns; a re-run is idempotent; a case-variant email
 *      matches the same row. Self-skips without DB env (requireDbEnvOrSkip).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { requireDbEnvOrSkip } from '../helpers/requires-infra';

// This file lives in tests/tenant/ (two levels below the repo root), so resolve
// the root explicitly rather than via the tests/-relative project-root helper.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX_PATH = path.join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_PATH = path.join(PROJECT_ROOT, 'scripts', 'billing', 'set-user-plan.ts');

function runCli(
  args: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [TSX_PATH, CLI_PATH, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...envOverrides },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// An unreachable DB: the validation paths must exit NONZERO before ever querying
// it, so these never hang. (pg connects lazily — a validation throw ends the
// process before a connection is attempted.)
const UNREACHABLE_DB = {
  DB_HOST: '127.0.0.1',
  DB_PORT: '1',
  DB_USER: 'nobody',
  DB_PASSWORD: 'nobody',
  DB_NAME: 'nodb',
};

// ── 1. Validation (hermetic — no DB touched) ────────────────────────────────

test('CLI: a missing --email exits nonzero and writes nothing (validated before any DB work)', () => {
  const { status, stderr } = runCli(['--plan', 'pro'], UNREACHABLE_DB);
  assert.equal(status, 1, 'missing --email must exit nonzero');
  assert.match(stderr, /--email <email> is required/);
});

test('CLI: a bad --plan value exits nonzero and writes nothing', () => {
  const { status, stderr } = runCli(['--email', 'owner@acme.com', '--plan', 'platinum'], UNREACHABLE_DB);
  assert.equal(status, 1, 'an invalid plan must exit nonzero');
  assert.match(stderr, /--plan must be one of: free, pro/);
});

test('CLI: --email with no --plan (and not --show) exits nonzero', () => {
  const { status, stderr } = runCli(['--email', 'owner@acme.com'], UNREACHABLE_DB);
  assert.equal(status, 1);
  assert.match(stderr, /--plan must be one of: free, pro/);
});

// ── 2. Write + idempotency + case-insensitivity (requires-infra) ────────────

const TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL DEFAULT 'x',
    plan TEXT NOT NULL DEFAULT 'free',
    plan_granted_at TIMESTAMPTZ,
    plan_granted_by TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower_unique ON users (LOWER(email));
`;

test('CLI (requires-infra): grants pro, stamps the audit columns, is idempotent, and matches email case-insensitively', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const pool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    max: 2,
  });
  const email = `cli-plan-${Date.now()}@acme.com`;
  try {
    await pool.query(TABLE_DDL);
    // Seed a free account (default plan).
    await pool.query(`INSERT INTO users (email) VALUES ($1)`, [email]);

    const dbEnv = {
      DB_HOST: process.env.DB_HOST!,
      DB_PORT: process.env.DB_PORT!,
      DB_USER: process.env.DB_USER!,
      DB_PASSWORD: process.env.DB_PASSWORD!,
      DB_NAME: process.env.DB_NAME!,
    };

    // Grant pro.
    const grant = runCli(['--email', email, '--plan', 'pro', '--by', 'ticket-1'], dbEnv);
    assert.equal(grant.status, 0, `${grant.stderr}\n${grant.stdout}`);

    const afterGrant = (
      await pool.query(`SELECT plan, plan_granted_at, plan_granted_by FROM users WHERE email=$1`, [email])
    ).rows[0];
    assert.equal(afterGrant.plan, 'pro', 'plan flipped to pro');
    assert.ok(afterGrant.plan_granted_at, 'plan_granted_at stamped');
    assert.equal(afterGrant.plan_granted_by, 'cli:ticket-1', 'plan_granted_by records the attribution');

    // Idempotent re-run of the SAME grant — still pro, still exit 0.
    const rerun = runCli(['--email', email, '--plan', 'pro', '--by', 'ticket-1'], dbEnv);
    assert.equal(rerun.status, 0, `${rerun.stderr}\n${rerun.stdout}`);
    const afterRerun = (await pool.query(`SELECT plan FROM users WHERE email=$1`, [email])).rows[0];
    assert.equal(afterRerun.plan, 'pro', 're-running the grant is idempotent');

    // Case-insensitive email match: UPPER-CASE the address → same row updated.
    const revoke = runCli(['--email', email.toUpperCase(), '--plan', 'free'], dbEnv);
    assert.equal(revoke.status, 0, `${revoke.stderr}\n${revoke.stdout}`);
    const afterRevoke = (await pool.query(`SELECT plan FROM users WHERE email=$1`, [email])).rows;
    assert.equal(afterRevoke.length, 1, 'still exactly one row — no duplicate created by the case variant');
    assert.equal(afterRevoke[0].plan, 'free', 'a case-variant email matched and updated the same account');

    // A no-such-user email exits nonzero (no silent no-op).
    const missing = runCli(['--email', `nobody-${Date.now()}@none.com`, '--plan', 'pro'], dbEnv);
    assert.equal(missing.status, 1, 'a grant for a non-existent user exits nonzero');
    assert.match(missing.stderr, /no user found with email/);
  } finally {
    await pool.query(`DELETE FROM users WHERE email=$1`, [email]).catch(() => {});
    await pool.end().catch(() => {});
  }
});
