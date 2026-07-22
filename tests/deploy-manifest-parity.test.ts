import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = process.cwd();
const distComposePath = path.join(repoRoot, 'dist', 'docker-compose.yml');

test('legacy dist deploy shim stays out of the tracked runtime surface', () => {
  const trackedDistCompose = execFileSync('git', ['ls-files', '--', distComposePath], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();

  assert.equal(trackedDistCompose, '');
});

test('runtime env examples advertise Hermes execution defaults', () => {
  const composeSource = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
  const envExampleSource = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');

  assert.match(
    composeSource,
    /ARIES_EXECUTION_PROVIDER:\s*\$\{ARIES_EXECUTION_PROVIDER:-hermes\}/,
  );
  assert.match(
    composeSource,
    /ARIES_MARKETING_EXECUTION_PROVIDER:\s*\$\{ARIES_MARKETING_EXECUTION_PROVIDER:-hermes\}/,
  );
  assert.match(composeSource, /HERMES_GATEWAY_URL:\s*\$\{HERMES_GATEWAY_URL:-\}/);
  assert.match(composeSource, /HERMES_API_SERVER_KEY:\s*\$\{HERMES_API_SERVER_KEY:-\}/);
  assert.match(composeSource, /HERMES_SESSION_KEY:\s*\$\{HERMES_SESSION_KEY:-main\}/);
  assert.match(composeSource, /INTERNAL_API_SECRET:\s*\$\{INTERNAL_API_SECRET\}/);
  assert.doesNotMatch(composeSource, /OPENAI_CLIENT_ID/);
  assert.doesNotMatch(composeSource, /OPENAI_CLIENT_SECRET/);
  assert.match(composeSource, /OAUTH_TOKEN_ENCRYPTION_KEY:\s*\$\{OAUTH_TOKEN_ENCRYPTION_KEY\}/);

  assert.match(envExampleSource, /^ARIES_EXECUTION_PROVIDER=hermes$/m);
  assert.match(envExampleSource, /^ARIES_MARKETING_EXECUTION_PROVIDER=hermes$/m);
  assert.doesNotMatch(envExampleSource, /legacy-openclaw/);
  assert.doesNotMatch(composeSource, /OPENCLAW_GATEWAY_URL/);
  assert.match(envExampleSource, /^HERMES_GATEWAY_URL=/m);
  assert.match(envExampleSource, /^HERMES_API_SERVER_KEY=/m);
  assert.match(envExampleSource, /^HERMES_SESSION_KEY=main$/m);
  assert.doesNotMatch(envExampleSource, /^OPENAI_CLIENT_ID=/m);
  assert.doesNotMatch(envExampleSource, /^OPENAI_CLIENT_SECRET=/m);
  assert.match(envExampleSource, /^OAUTH_TOKEN_ENCRYPTION_KEY=/m);

  // Hermes kanban GC worker knobs must be documented in .env.example
  assert.match(envExampleSource, /^ARIES_KANBAN_GC_ENABLED=/m);
  assert.match(envExampleSource, /^ARIES_KANBAN_GC_INTERVAL_MS=/m);
  assert.match(envExampleSource, /^ARIES_KANBAN_GC_RETENTION_DAYS=/m);

  // docker-compose.yml must wire all three kanban GC vars
  assert.match(composeSource, /ARIES_KANBAN_GC_ENABLED:\s*\$\{ARIES_KANBAN_GC_ENABLED:-1\}/);
  assert.match(composeSource, /ARIES_KANBAN_GC_INTERVAL_MS:\s*\$\{ARIES_KANBAN_GC_INTERVAL_MS:-86400000\}/);
  assert.match(composeSource, /ARIES_KANBAN_GC_RETENTION_DAYS:\s*\$\{ARIES_KANBAN_GC_RETENTION_DAYS:-7\}/);

  // Hermes run-timeout knobs must be documented in .env.example so operators
  // can discover and tune them (the 1200s default fits real production-stage
  // image-render runs; video workloads may need more, light tenants less).
  assert.match(envExampleSource, /^HERMES_RUN_TIMEOUT_MS=/m);
  assert.match(envExampleSource, /^HERMES_POLL_INTERVAL_MS=/m);

  // docker-compose.yml must wire the timeout default at 1200000ms (the
  // post-v0.1.12.12 calibration) and pass HERMES_POLL_INTERVAL_MS through.
  assert.match(composeSource, /HERMES_RUN_TIMEOUT_MS:\s*\$\{HERMES_RUN_TIMEOUT_MS:-1200000\}/);
  assert.match(composeSource, /HERMES_POLL_INTERVAL_MS:\s*\$\{HERMES_POLL_INTERVAL_MS:-\}/);
});

test('deploy workflow force-recreates every docker-compose service', () => {
  // Every service in docker-compose.yml runs the shared ARIES_APP_IMAGE and
  // imports backend code, so each one must be force-recreated onto the new
  // image during deploy. Omitting a worker leaves it running stale code
  // indefinitely (restart: unless-stopped never re-pulls) — that gap caused
  // the 2026-06-09 incident where aries-insights-sync-worker ran a 6-day-old
  // image. This test fails when a compose service is added (or renamed)
  // without a matching recreate block in .github/workflows/deploy.yml.
  const composeSource = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
  const deploySource = fs.readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'deploy.yml'),
    'utf8',
  );

  // Services that do NOT run the shared ARIES_APP_IMAGE are exempt from the
  // app-image recreate command. aries-autoheal has its own pinned image and a
  // dedicated, fail-closed recreate block in deploy.yml.
  const recreateExemptServices: string[] = ['aries-autoheal'];

  const composeServices: string[] = [];
  let inServicesBlock = false;
  for (const line of composeSource.split('\n')) {
    if (/^\s*#/.test(line)) {
      continue; // comments never open, close, or define a service
    }
    if (/^services:\s*$/.test(line)) {
      inServicesBlock = true;
      continue;
    }
    if (inServicesBlock && /^\S/.test(line)) {
      inServicesBlock = false;
    }
    if (!inServicesBlock) {
      continue;
    }
    const serviceMatch = line.match(/^ {2}([A-Za-z0-9][A-Za-z0-9._-]*):\s*(?:#.*)?$/);
    if (serviceMatch) {
      composeServices.push(serviceMatch[1]);
    }
  }
  assert.ok(
    composeServices.includes('aries-app'),
    'compose service parser failed to find aries-app — parser or compose layout changed',
  );

  // The full command each recreate block must use: the ARIES_APP_IMAGE pin is
  // load-bearing (without it compose resolves the host's .env image and the
  // worker can be "recreated" onto a stale image anyway), so it is part of the
  // required string, not just the compose flags.
  const recreateCommand =
    'ARIES_APP_IMAGE="${TARGET_IMAGE}" docker compose up -d --no-deps --force-recreate --pull always';

  // Commented-out recreate lines must not count as coverage.
  const activeDeployLines = deploySource
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'));

  // aries-app itself is recreated via the SERVICE_NAME indirection.
  assert.match(deploySource, /^\s*SERVICE_NAME: aries-app$/m);
  assert.ok(
    activeDeployLines.some((line) =>
      line.trimStart().startsWith(`${recreateCommand} "\${SERVICE_NAME}"`),
    ),
    'deploy.yml is missing the pinned force-recreate of "${SERVICE_NAME}" (aries-app)',
  );

  // Only lines that ARE the recreate command count as coverage — an echo/log
  // line or other quotation of the command text must not satisfy parity.
  const recreatedServices = new Set<string>(['aries-app']);
  for (const line of activeDeployLines) {
    const trimmed = line.trimStart();
    let target: string | null = null;
    if (trimmed.startsWith(`if ! ${recreateCommand} `)) {
      target = trimmed.slice(`if ! ${recreateCommand} `.length);
    } else if (trimmed.startsWith(`${recreateCommand} `)) {
      target = trimmed.slice(`${recreateCommand} `.length);
    }
    if (target === null) {
      continue;
    }
    // Service names start alphanumeric, so a trailing flag (e.g. a future
    // --remove-orphans) is never mistaken for a recreate target.
    const nameMatch = target.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
    if (nameMatch) {
      recreatedServices.add(nameMatch[1]);
    }
  }

  const missingFromDeploy = composeServices.filter(
    (name) => !recreatedServices.has(name) && !recreateExemptServices.includes(name),
  );
  assert.deepEqual(
    missingFromDeploy,
    [],
    `docker-compose.yml services missing a force-recreate block in deploy.yml: ${missingFromDeploy.join(', ')}. ` +
      `Each block must be an uncommented line starting with: [if ! ]${recreateCommand} <service>. ` +
      'If the recreate blocks exist, check whether their command string (image pin, flags, flag order) drifted from the one this test requires.',
  );

  // The reverse direction catches a renamed/removed compose service leaving a
  // stale recreate line behind (docker compose up would fail on it).
  const staleRecreateTargets = [...recreatedServices].filter(
    (name) => !composeServices.includes(name),
  );
  assert.deepEqual(
    staleRecreateTargets,
    [],
    `deploy.yml recreates services that no longer exist in docker-compose.yml: ${staleRecreateTargets.join(', ')}`,
  );
});

test('legacy dist deploy shim cannot reintroduce the stale public onboarding path', () => {
  if (!fs.existsSync(distComposePath)) {
    assert.ok(true);
    return;
  }

  const distComposeSource = fs.readFileSync(distComposePath, 'utf8');
  assert.doesNotMatch(distComposeSource, /\/onboarding\/start/);
});
