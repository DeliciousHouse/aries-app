import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import type { NextAuthConfig } from 'next-auth';
import pg from 'pg';
import ts from 'typescript';

import { requireDbEnvOrSkip } from './helpers/requires-infra';

// The real auth.ts callback and journey helpers run against owner-created tables.
// Only the Auth.js framework registration is captured, not application SQL.
test('sign-in and request schema checks work after SET ROLE aries_app (non-owner)', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;
  const root = path.resolve(import.meta.dirname, '..');
  const schema = `request_schema_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  await admin.connect();
  let createdRole = false;
  try {
    const role = await admin.query("SELECT rolname FROM pg_roles WHERE rolname = 'aries_app'");
    if (role.rowCount === 0) {
      await admin.query('CREATE ROLE aries_app NOLOGIN');
      createdRole = true;
    }
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const initialized = spawnSync(process.execPath, ['scripts/init-db.js'], {
      cwd: root,
      env: { ...process.env, PGOPTIONS: `-c search_path=${schema}` },
      encoding: 'utf8',
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    const migration = readFileSync(path.join(root, 'migrations/20261004000000_request_schema.sql'), 'utf8');
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(migration);
    await admin.query(migration);
    await admin.query("INSERT INTO organizations (id, name, slug) VALUES (1, 'Schema test', 'schema-test')");
    await admin.query(`INSERT INTO users (id, email, password_hash, organization_id)
      VALUES (1, 'schema-test@example.invalid', 'oauth_managed', 1)`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO aries_app`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO aries_app`);
    await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO aries_app`);
    await admin.query('SET ROLE aries_app');
    assert.equal((await admin.query('SELECT current_user AS role')).rows[0].role, 'aries_app');
    assert.equal((await admin.query("SELECT pg_has_role(current_user, relowner, 'USAGE') AS owns FROM pg_class WHERE oid = 'users'::regclass")).rows[0].owns, false);
    await assert.rejects(admin.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_required BOOLEAN'), /must be owner/);

    const client = { query: admin.query.bind(admin), release() {} };
    const requestPool = { connect: async () => client, query: client.query };
    const require = createRequire(path.join(root, 'auth.ts'));
    let config: NextAuthConfig | undefined;
    const source = ts.transpileModule(readFileSync(path.join(root, 'auth.ts'), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    runInNewContext(source, {
      exports: {}, process, console,
      require(id: string) {
        if (id === 'next-auth') return {
          __esModule: true,
          default(options: NextAuthConfig) { config = options; return {}; },
          CredentialsSignin: class extends Error {},
        };
        if (id.startsWith('next-auth/providers/')) return { __esModule: true, default: (options: unknown) => options };
        if (id === './lib/db') return { __esModule: true, default: requestPool };
        return require(id.startsWith('@/') ? path.join(root, id.slice(2)) : id);
      },
    });
    assert.ok(config?.callbacks?.signIn);
    for (const provider of ['credentials', 'google']) {
      assert.equal(await config.callbacks.signIn({
        user: { id: '1', email: 'schema-test@example.invalid' },
        account: { provider, type: provider === 'google' ? 'oauth' : 'credentials', providerAccountId: '1' },
      }), true, `${provider} sign-in`);
    }
    const journey = require('./lib/auth-user-journey');
    assert.equal(await journey.resolvePostLoginDestinationForUser(client, 1), '/dashboard');
    await require('./backend/memory/onboarding-memory-hook').ensureOnboardingMemorySeedColumn(client);
    await require('./backend/memory/research-jobs').ensureResearchJobSchema(client);
    await require('./backend/feedback/report-store').ensureFeedbackReportsTable(requestPool);
    const dbPool = require('./lib/db').default;
    const originalQuery = dbPool.query;
    dbPool.query = client.query;
    try {
      await require('./lib/feedback/feedback-store').ensureFeedbackTable();
      const { POST } = require('./app/api/early-access/route');
      const response = await POST(new Request('https://example.invalid/api/early-access', {
        method: 'POST', body: JSON.stringify({ email: 'schema-test@example.invalid' }),
      }));
      assert.equal(response.status, 200);
    } finally {
      dbPool.query = originalQuery;
    }
    console.log('SET ROLE aries_app: owns users=false; ALTER denied; credentials/google sign-in=true; journey=/dashboard; schema checks=PASS');
  } finally {
    await admin.query('RESET ROLE');
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (createdRole) await admin.query('DROP ROLE aries_app');
    await admin.end();
  }
});
