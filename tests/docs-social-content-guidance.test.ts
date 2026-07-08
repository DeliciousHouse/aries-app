import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = process.cwd();

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

test('.env.example documents Hermes weekly social-content defaults', () => {
  const envExample = readRepoFile('.env.example');

  const requiredVars = [
    'APP_BASE_URL',
    'INTERNAL_API_SECRET',
    'HERMES_GATEWAY_URL',
    'HERMES_API_SERVER_KEY',
    'HERMES_SESSION_KEY',
    'DB_HOST',
    'DB_PORT',
    'DB_USER',
    'DB_PASSWORD',
    'DB_NAME',
    'NEXTAUTH_URL',
    'AUTH_URL',
    'NEXTAUTH_SECRET',
    'AUTH_TRUST_HOST',
    'OAUTH_TOKEN_ENCRYPTION_KEY',
  ];

  for (const variable of requiredVars) {
    assert.match(envExample, new RegExp(`^${variable}=.+$`, 'm'));
  }

  assert.match(envExample, /Weekly social content integration requirements:/);
  assert.match(envExample, /Hermes owns ChatGPT\/OpenAI auth for weekly image\/video generation/i);
  assert.match(envExample, /openssl rand -base64 32/);
  assert.match(
    envExample,
    /Text planning can run when media generation is disabled/i,
  );

  // The legacy OpenClaw/Lobster execution path has been removed; its gateway
  // env vars must not appear in .env.example.
  assert.doesNotMatch(envExample, /^OPENCLAW_GATEWAY_URL=/m);
  assert.doesNotMatch(envExample, /^OPENCLAW_GATEWAY_TOKEN=/m);
  assert.doesNotMatch(envExample, /^OPENCLAW_SESSION_KEY=/m);
  assert.doesNotMatch(envExample, /^LOBSTER_MEDIA_GATEWAY_ENABLED=/m);
  assert.doesNotMatch(envExample, /^GEMINI_API_KEY=/m);
  assert.doesNotMatch(envExample, /legacy OpenClaw/i);
});

test('docs describe Hermes social-content operational flow and avoid lobster workflow instructions', () => {
  const docsToCheck = [
    'README.md',
    'SETUP.md',
    'DOCKER.md',
    'PRODUCTION_HANDOFF.md',
  ] as const;
  const docsForCombinedAssertions = [
    ...docsToCheck,
    'docs/SYSTEM-REFERENCE.md',
    'TOOLS.md',
  ] as const;

  for (const filePath of docsToCheck) {
    const source = readRepoFile(filePath);
    assert.match(source, /POST \/api\/social-content\/jobs/);
    assert.match(source, /\/api\/internal\/hermes\/runs/);
  }

  const combinedSource = docsForCombinedAssertions
    .map((filePath) => readRepoFile(filePath))
    .join('\n');

  assert.match(combinedSource, /Hermes-native|Hermes native/i);
  assert.match(combinedSource, /Hermes owns ChatGPT\/OpenAI auth|Hermes-owned ChatGPT\/OpenAI auth/i);
  assert.doesNotMatch(combinedSource, /social-content[\s\S]{0,160}\.lobster/i);
  assert.doesNotMatch(combinedSource, /run .*\.lobster.*social-content/i);
});

test('docs distinguish external Postgres Compose config and social-content checks from legacy marketing checks', () => {
  const readme = readRepoFile('README.md');
  const setup = readRepoFile('SETUP.md');
  const compose = readRepoFile('docker-compose.yml');

  // The BASE compose file stays external-Postgres/external-Hermes (prod
  // layout); bundled services live only in the docker-compose.selfhost.yml
  // overlay driven by install.sh.
  assert.match(readme, /\*\*external\*\* PostgreSQL and Hermes services/i);
  assert.match(readme, /base compose file does \*\*not\*\* provision PostgreSQL or Hermes/i);
  assert.match(readme, /`DB_\*` values/i);
  assert.match(readme, /install\.sh \| bash/);
  assert.match(readme, /docker-compose\.selfhost\.yml/);
  assert.doesNotMatch(readme, /DB_HOST=postgres/i);
  assert.match(readme, /For weekly social content media generation, Hermes owns ChatGPT\/OpenAI auth/i);
  assert.match(readme, /Text-only weekly planning can (still )?run when media generation is disabled/i);
  assert.doesNotMatch(compose, /DB_HOST:\s*postgres/);
  assert.doesNotMatch(compose, /postgres:16/);
  assert.doesNotMatch(compose, /pgadmin/i);
  assert.doesNotMatch(compose, /OPENAI_CLIENT_ID/);
  assert.doesNotMatch(compose, /OPENAI_CLIENT_SECRET/);

  assert.match(setup, /Social-content smoke path/);
  assert.match(setup, /tests\/social-content-weekly-defaults\.test\.ts/);
  assert.match(setup, /tests\/social-content-execution-contract\.test\.ts/);
  assert.match(setup, /Legacy marketing compatibility checks/);
  assert.doesNotMatch(setup, /### 3\. Marketing-flow smoke path/);

  assert.match(readme, /tests\/social-content-weekly-defaults\.test\.ts/);
  assert.match(readme, /tests\/social-content-execution-contract\.test\.ts/);
  assert.match(readme, /legacy compatibility/);
});
