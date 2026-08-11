import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

/**
 * AA-90 (S1-11, gap B1) — every container that talks to the Hermes gateway must
 * be able to RESOLVE it.
 *
 * The incident this exists to prevent, in full: the Hermes gateway is a HOST
 * process (0.0.0.0:8642), not a compose service, so HERMES_GATEWAY_URL is
 * `host.docker.internal`-scoped. Only `aries-app` carried
 * `extra_hosts: host.docker.internal:host-gateway`. The
 * `aries-insights-sync-worker` had the Hermes env pair but NOT the mapping, so
 * every classification call from that sidecar died with
 * `getaddrinfo ENOTFOUND host.docker.internal`, surfacing only as
 * `classifyComments: unreachable (fetch failed)` on ticks that had unclassified
 * comments.
 *
 * Nothing failed. Nothing alerted. The flag was ON the whole time, and
 * `insights_comment_classifications` held ZERO rows for weeks — a silent,
 * fleet-wide data loss caused by one missing compose line, mistaken for a
 * flag-flip problem (AA-90 was written as "flip the flag in prod").
 *
 * A code-level test cannot catch this: the credentials are present, the client
 * is correct, and the call is well-formed. The only artifact that encodes the
 * requirement is the compose file, so the guard belongs here.
 *
 * The rule: a service whose environment carries HERMES_GATEWAY_URL must declare
 * the host-gateway mapping. Derived from the file, not a hardcoded service
 * list, so a NEW Hermes-calling sidecar is covered the day it is added.
 */

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const COMPOSE_PATH = path.join(PROJECT_ROOT, 'docker-compose.yml');

const HOST_GATEWAY_MAPPING = 'host.docker.internal:host-gateway';

interface ComposeService {
  name: string;
  body: string;
}

/**
 * Split the `services:` block into per-service bodies.
 *
 * Services are the 2-space-indented keys under `services:`; anything more
 * deeply indented belongs to the service above it. Deliberately a small
 * indentation parser rather than a YAML dependency — this file has no YAML
 * parser today and adding one to assert two lines would be the larger change.
 */
export function parseComposeServices(source: string): ComposeService[] {
  const lines = source.split('\n');
  const servicesAt = lines.findIndex((line) => /^services:\s*$/.test(line));
  if (servicesAt < 0) return [];

  const services: ComposeService[] = [];
  let current: { name: string; lines: string[] } | null = null;

  for (const line of lines.slice(servicesAt + 1)) {
    // A non-indented, non-blank line ends the services block (e.g. `networks:`).
    if (/^\S/.test(line)) break;
    const serviceHeader = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (serviceHeader) {
      if (current) services.push({ name: current.name, body: current.lines.join('\n') });
      current = { name: serviceHeader[1], lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) services.push({ name: current.name, body: current.lines.join('\n') });
  return services;
}

const COMPOSE = fs.readFileSync(COMPOSE_PATH, 'utf8');
const SERVICES = parseComposeServices(COMPOSE);

test('the compose parser finds the real services', () => {
  // Guard the guard: a parser that found nothing would make every assertion
  // below vacuously true.
  assert.ok(SERVICES.length >= 5, `expected several services, found ${SERVICES.length}`);
  const names = SERVICES.map((s) => s.name);
  assert.ok(names.includes('aries-app'), `aries-app missing from ${names.join(', ')}`);
  assert.ok(names.includes('aries-insights-sync-worker'), 'sync worker missing');
});

test('every service that calls the Hermes gateway can resolve it', () => {
  const callers = SERVICES.filter((s) => /HERMES_GATEWAY_URL:/.test(s.body));
  assert.ok(callers.length > 0, 'expected at least one Hermes-calling service');

  const missing = callers
    .filter((s) => !s.body.includes(HOST_GATEWAY_MAPPING))
    .map((s) => s.name);

  assert.deepEqual(
    missing,
    [],
    `these services carry HERMES_GATEWAY_URL but cannot resolve host.docker.internal: ${missing.join(', ')}. ` +
      'Add `extra_hosts: ["host.docker.internal:host-gateway"]` — without it every gateway ' +
      'call fails with ENOTFOUND and the only symptom is silently missing data.',
  );
});

test('the insights sync worker specifically carries the mapping (the AA-90 incident)', () => {
  // Named explicitly as well as covered by the rule above, because this is the
  // service the outage actually happened on.
  const worker = SERVICES.find((s) => s.name === 'aries-insights-sync-worker');
  assert.ok(worker, 'aries-insights-sync-worker service not found');
  assert.ok(
    worker.body.includes(HOST_GATEWAY_MAPPING),
    'the sync worker lost its host-gateway mapping — comment classification will silently stop producing labels',
  );
  // The env pair is useless without the mapping; they must travel together.
  assert.match(worker.body, /HERMES_GATEWAY_URL:/);
  assert.match(worker.body, /HERMES_API_SERVER_KEY:/);
});

test('classification ships enabled, so an absent label is a plumbing fault not a flag', () => {
  // AA-90 was written as "flip the flag in prod". The flag was already on; the
  // classifier was unreachable. Pinning the default keeps the next reader from
  // re-diagnosing an empty table as a disabled feature.
  const worker = SERVICES.find((s) => s.name === 'aries-insights-sync-worker');
  assert.ok(worker);
  assert.match(
    worker.body,
    /ARIES_COMMENT_CLASSIFICATION_ENABLED:\s*\$\{ARIES_COMMENT_CLASSIFICATION_ENABLED:-1\}/,
  );
});
