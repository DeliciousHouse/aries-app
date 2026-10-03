import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// @ts-expect-error — operational .mjs module.
import { dockerApi, replacementBody, replaceRelease, serviceNames, validateExecution, validateSources, validateRehearsalTarget } from '../scripts/release/ubuntu-docker-replace.mjs';
// @ts-expect-error — offline operational preflight.
import { requiredCheckpoints } from '../scripts/release/ubuntu-docker-preflight.mjs';

const sha = 'a'.repeat(40);
const image = `ghcr.io/delicioushouse/aries-app@sha256:${'b'.repeat(64)}`;
function source(name: string) {
  const id = String(serviceNames.indexOf(name) + 1).repeat(64);
  return {
    Id: id, Name: `/${name}`, Image: 'old-image', State: { Running: true },
    Config: { Image: 'old', Env: ['PRIVATE_VALUE=unit-test-only', 'ARIES_SKIP_DB_INIT=1'], User: '1001:1001' },
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, Binds: name.endsWith('-app') ? ['/safe/data:/data'] : [] },
    NetworkSettings: { Networks: { 'aries-cutover-v1': { Aliases: [name, id.slice(0, 12)], IPAddress: '172.20.0.2', IPAMConfig: null } } },
  };
}

test('replacement carries protected live configuration in memory, changes only image and dynamic endpoint identity', () => {
  const original = source(serviceNames[0]);
  const body = replacementBody(original, image);
  assert.deepEqual(body.Env, original.Config.Env);
  assert.deepEqual(body.HostConfig, original.HostConfig);
  assert.equal(body.Image, image);
  assert.deepEqual(body.NetworkingConfig.EndpointsConfig, { 'aries-cutover-v1': { Aliases: [serviceNames[0]] } });
  assert.equal(original.Config.Image, 'old');
  const unexpected = source(serviceNames[0]);
  unexpected.NetworkSettings.Networks['aries-cutover-v1'].IPAMConfig = {} as never;
  assert.throws(() => replacementBody(unexpected, image), /static/);
});

function harness(fail = '') {
  const calls: string[] = [];
  const originals: ReturnType<typeof source>[] = serviceNames.map(source);
  const candidate = { Id: 'candidate-image', RepoDigests: [image], Config: { Labels: { 'org.opencontainers.image.revision': sha } } };
  const containers = new Map(originals.map((c) => [c.Id, c]));
  return {
    calls, originals, candidate, containers,
    api: async (method: string, path: string, body?: any) => {
      calls.push(`${method} ${path}`);
      if (fail && path.includes(fail)) throw new Error('private daemon error');
      if (path.endsWith('/json')) return containers.get(path.split('/')[2]);
      if (path.includes('/create')) {
        const Id = `new-${calls.length}`;
        const { HostConfig, NetworkingConfig, ...Config } = body;
        containers.set(Id, { ...source(serviceNames[0]), Id, Image: candidate.Id, Config, HostConfig });
        return { Id };
      }
      if (path.includes('/stop')) {
        const container = containers.get(path.split('/')[2]);
        if (container) containers.set(container.Id, { ...container, State: { Running: false } });
      }
      return {};
    },
    verify: async (phase: string) => { calls.push(phase); if (fail === phase) throw new Error('private probe output'); },
    health: async () => { calls.push('health'); if (fail === 'health') throw new Error('unhealthy'); },
  };
}

test('all four replacements and functional/health readback are required for deployment receipt', async () => {
  const h = harness();
  const receipt = await replaceRelease({ sha, image }, h.originals, h.candidate, h);
  assert.equal(receipt.deployed, true);
  assert.equal(receipt.containers.length, 4);
  assert.ok(h.calls.indexOf('quiesced') < h.calls.findIndex((c) => c.includes('/stop')));
  assert.ok(h.calls.indexOf('appReady') < h.calls.findIndex((c) => c.includes('create?name=aries-a3e604b4-scheduled-posts')));
  assert.equal(h.calls.at(-1), 'accepted');
  assert.equal(h.calls.filter((c) => c.includes('/create')).length, 4);
  assert.ok(h.calls.every((c) => !/compose|autoheal|\/pg\//.test(c)));
});

test('failed quiescence has zero Docker mutations; failed replacement/health/probe stops candidates without restarting old workers', async () => {
  const before = harness('quiesced');
  await assert.rejects(replaceRelease({ sha, image }, before.originals, before.candidate, before));
  assert.deepEqual(before.calls, ['quiesced']);
  for (const failure of ['/create', '/start', '/rename', '/disconnect', '/stop', 'health', 'accepted', 'appReady']) {
    const h = harness(failure);
    await assert.rejects(replaceRelease({ sha, image }, h.originals, h.candidate, h));
    assert.ok(!h.calls.some((c) => /\/containers\/aries-a3e604b4-.*\/start/.test(c)));
    if (['/start', 'health', 'accepted', 'appReady'].includes(failure)) assert.ok(h.calls.at(-1)?.includes('/json'));
  }
});

test('execution refuses historical checkpoints, migration boundaries, source drift and missing reviewed verifier', () => {
  const now = Date.now();
  const plan = { host: 'ubuntu-docker', origin: 'https://aries.deliciouswines.org', sha, image,
    checkpoints: Object.fromEntries(requiredCheckpoints.map((name: string) => [name, { sha, image, evidence: 'unit-test-receipt' }])),
    mode: 'compatible_image_only', schemaChanged: false, checkpointAt: new Date(now).toISOString(),
    verifier: { path: process.platform === 'win32' ? 'C:/operator/probe' : '/operator/probe', sha256: 'd'.repeat(64) },
  };
  validateExecution(plan, now);
  for (const bad of [{ checkpointAt: new Date(now - 3600001).toISOString() }, { checkpointAt: new Date(now + 1).toISOString() },
    { schemaChanged: true }, { mode: 'migration' }, { verifier: undefined }]) {
    assert.throws(() => validateExecution({ ...plan, ...bad }, now));
  }
  assert.throws(() => validateSources(serviceNames.map(source), {}), /source inventory/i);
  assert.throws(() => validateSources(serviceNames.map(source), Object.fromEntries(serviceNames.map((name: string) => [name, { id: 'wrong', fingerprint: 'wrong' }]))), /drift/);
  const originals = serviceNames.map(source) as ReturnType<typeof source>[];
  const expected = Object.fromEntries(originals.map((c) => [c.Name.slice(1), { id: c.Id,
    fingerprint: createHash('sha256').update(JSON.stringify({ Config: c.Config, HostConfig: c.HostConfig, Networks: c.NetworkSettings.Networks })).digest('hex'),
  }]));
  validateSources(originals, expected);
  originals[0].Config.Env.push('DRIFT=1');
  assert.throws(() => validateSources(originals, expected), /drift/);
});

test('post-quiescence drift refuses before mutation and parity failure contains all candidates', async () => {
  const drift = harness();
  drift.verify = async () => { drift.containers.set(drift.originals[0].Id, { ...drift.originals[0], State: { Running: false } }); };
  await assert.rejects(replaceRelease({ sha, image }, drift.originals, drift.candidate, drift), /quiescence/);
  assert.ok(drift.calls.every((c) => c.startsWith('GET ')));
  const parity = harness();
  parity.verify = async (phase: string) => {
    if (phase === 'appReady') for (const [id, c] of parity.containers) if (id.startsWith('new-')) parity.containers.set(id, { ...c, Image: 'wrong' });
  };
  await assert.rejects(replaceRelease({ sha, image }, parity.originals, parity.candidate, parity), /candidates stopped/);
  assert.equal(parity.calls.filter((c) => /new-.*\/stop/.test(c)).length, 4);
});

test('Docker HTTP transport sends protected configuration only to local socket and suppresses daemon response errors', async () => {
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\aries-release-${randomUUID()}` : path.join(tmpdir(), `a-${randomUUID().slice(0, 8)}.sock`);
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.url?.endsWith('/fail')) { res.writeHead(500); res.end('unit-test-private-error'); return; }
      if (req.url?.includes('/stop')) { res.writeHead(304); res.end(); return; }
      if (req.url?.endsWith('/other304')) { res.writeHead(304); res.end(); return; }
      assert.equal(req.url, '/v1.45/containers/create');
      assert.equal(req.method, 'POST');
      assert.deepEqual(JSON.parse(body), { Env: ['PRIVATE_VALUE=unit-test-only'] });
      res.end(JSON.stringify({ Id: 'unit-test-container' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    assert.deepEqual(await dockerApi('POST', '/containers/create', { Env: ['PRIVATE_VALUE=unit-test-only'] }, socket), { Id: 'unit-test-container' });
    await assert.rejects(dockerApi('GET', '/fail', undefined, socket), { message: 'Docker request failed' });
    assert.deepEqual(await dockerApi('POST', '/containers/fixture/stop?t=120', undefined, socket), {});
    await assert.rejects(dockerApi('GET', '/other304', undefined, socket), { message: 'Docker request failed' });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('containment requires stopped-state readback even after stop success or already-stopped response', async () => {
  for (const running of [false, true, undefined]) {
    const h = harness('/start');
    const api = h.api;
    h.api = async (method: string, route: string, body?: any) => {
      const result = await api(method, route, body);
      if (route.includes('new-') && route.endsWith('/json')) return { ...result, State: { Running: running } };
      return result;
    };
    await assert.rejects(replaceRelease({ sha, image }, h.originals, h.candidate, h),
      running === false ? /candidates stopped/ : /containment failed/);
  }
});

test('rehearsal refuses unlabelled/wrong daemon, external network and non-fixture sources', () => {
  const token = 'f'.repeat(64);
  const target = { socket: path.join(tmpdir(), 'isolated.sock'), token, daemonId: 'disposable-daemon' };
  const info = { ID: target.daemonId, Labels: [`aries.replacement.rehearsal=${token}`] };
  const network = { Internal: true, Driver: 'bridge' };
  const original = { ...source(serviceNames[0]), Mounts: [],
    Config: { ...source(serviceNames[0]).Config, Labels: { 'aries.replacement.rehearsal': token } },
    HostConfig: { NetworkMode: 'aries-cutover-v1', PortBindings: {}, Privileged: false } };
  validateRehearsalTarget(target, info, network, [original]);
  for (const bad of [{ ...info, ID: 'other' }, { ...info, Labels: [] }]) {
    assert.throws(() => validateRehearsalTarget(target, bad, network));
  }
  assert.throws(() => validateRehearsalTarget(target, info, { ...network, Internal: false }));
  for (const bad of [{ ...original, Mounts: [{}] }, { ...original, Config: { ...original.Config, Labels: {} } },
    { ...original, HostConfig: { ...original.HostConfig, PortBindings: { '3000/tcp': [{}] } } },
    { ...original, HostConfig: { ...original.HostConfig, Privileged: true } }]) {
    assert.throws(() => validateRehearsalTarget(target, info, network, [bad]));
  }
});

test('Linux full CLI uses explicit isolated socket, separate lock and verifier health; never emits deployed true',
  { skip: process.platform !== 'linux' }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aries-cli-'));
    const socket = path.join(dir, 'docker.sock');
    const targetFile = path.join(dir, 'target.json');
    const verifier = path.join(dir, 'fixture-verifier');
    const phases = path.join(dir, 'phases');
    const token = 'f'.repeat(64);
    const target = { socket, token, daemonId: 'unit-test-daemon' };
    writeFileSync(targetFile, JSON.stringify(target));
    // Structural fixture only, explicitly not an Aries acceptance verifier.
    writeFileSync(verifier, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${phases}'\n`, { mode: 0o700 });
    const h = harness();
    for (const c of h.originals) Object.assign(c, { Mounts: [],
      Config: { ...c.Config, Labels: { 'aries.replacement.rehearsal': token } },
      HostConfig: { NetworkMode: 'aries-cutover-v1', PortBindings: {}, Privileged: false } });
    let labelled = true;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        const route = req.url!.replace('/v1.45', '');
        let result;
        if (route === '/info') result = { ID: target.daemonId, Labels: labelled ? [`aries.replacement.rehearsal=${token}`] : [] };
        else if (route === '/networks/aries-cutover-v1') result = { Internal: true, Driver: 'bridge' };
        else if (route.startsWith('/images/')) result = h.candidate;
        else if (serviceNames.some((name: string) => route === `/containers/${name}/json`)) {
          result = h.originals.find((c) => route.includes(c.Name));
        } else result = await h.api(req.method!, route, body ? JSON.parse(body) : undefined);
        res.end(JSON.stringify(result));
      });
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    const cli = path.resolve('scripts/release/ubuntu-docker-replace.mjs');
    const run = (...args: string[]) => promisify(execFile)(process.execPath, [cli, '--rehearsal', targetFile, ...args]);
    try {
      const inventory = JSON.parse((await run('--inventory')).stdout);
      const planFile = path.join(dir, 'plan.json');
      writeFileSync(planFile, JSON.stringify({ host: 'ubuntu-docker', origin: 'https://aries.deliciouswines.org', sha, image,
        checkpoints: Object.fromEntries(requiredCheckpoints.map((name: string) => [name, { sha, image, evidence: 'structural-fixture-only' }])),
        sources: inventory, mode: 'compatible_image_only', schemaChanged: false, checkpointAt: new Date().toISOString(),
        verifier: { path: verifier, sha256: createHash('sha256').update(readFileSync(verifier)).digest('hex') } }));
      const receipt = JSON.parse((await run('--execute', planFile)).stdout);
      assert.equal(receipt.deployed, false);
      assert.equal(receipt.status, 'rehearsal_passed');
      assert.equal(receipt.containers.length, 4);
      assert.deepEqual(readFileSync(phases, 'utf8').trim().split('\n'), ['quiesced', 'appReady', 'health', 'accepted']);
      assert.equal(existsSync(`${socket}.replacement.lock`), false);
      labelled = false;
      const callsBefore = h.calls.length;
      await assert.rejects(run('--inventory'));
      assert.equal(h.calls.length, callsBefore);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
