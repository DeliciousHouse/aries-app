import { request } from 'node:http';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync, openSync, closeSync, unlinkSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { preflightRelease } from './ubuntu-docker-preflight.mjs';

export const serviceNames = ['app', 'scheduled-posts', 'insights-sync', 'weekly-trigger']
  .map((name) => `aries-a3e604b4-${name}`);
const network = 'aries-cutover-v1';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const identity = (container) => hash(JSON.stringify({
  Config: container.Config, HostConfig: container.HostConfig,
  Networks: container.NetworkSettings.Networks,
}));

// Docker responses and probe output may contain credentials: never log them.
export function dockerApi(method, route, body, socketPath = '/var/run/docker.sock') {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: `/v1.45${route}`, method,
      headers: { 'Content-Type': 'application/json' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        const alreadyStopped = res.statusCode === 304 && method === 'POST' && /^\/containers\/[^/]+\/stop\?t=120$/.test(route);
        if (!alreadyStopped && (res.statusCode < 200 || res.statusCode >= 300)) return reject(new Error('Docker request failed'));
        try { resolve(text ? JSON.parse(text) : {}); } catch { reject(new Error('Invalid Docker response')); }
      });
    });
    req.setTimeout(120000, () => req.destroy(new Error('Docker timeout')));
    req.on('error', () => reject(new Error('Docker unavailable')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

export function replacementBody(original, image) {
  const networks = original.NetworkSettings.Networks;
  if (Object.keys(networks).length !== 1 || !networks[network]) throw new Error('Unexpected network');
  const endpoint = networks[network];
  if (endpoint.IPAMConfig) throw new Error('Unsupported static endpoint');
  const aliases = (endpoint.Aliases || []).filter((alias) => alias !== original.Id && alias !== original.Id.slice(0, 12));
  return { ...structuredClone(original.Config), Image: image,
    HostConfig: structuredClone(original.HostConfig),
    NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: aliases } } } };
}

export function validateSources(originals, expected) {
  if (!expected || Object.keys(expected).sort().join() !== [...serviceNames].sort().join()) throw new Error('Missing source inventory');
  for (const original of originals) {
    const name = original.Name.slice(1);
    if (!serviceNames.includes(name) || !original.State.Running
      || original.Id !== expected[name]?.id || identity(original) !== expected[name]?.fingerprint
      || original.Config.User !== '1001:1001'
      || !original.Config.Env.includes('ARIES_SKIP_DB_INIT=1')) throw new Error('Source drift');
    // Force validation before any stop; exact protected settings remain in memory.
    replacementBody(original, original.Config.Image);
  }
}

export async function replaceRelease(plan, originals, candidate, { api, verify, health }) {
  const created = [];
  // Operations verifier must prove ingress/writes AND all publishing drained.
  await verify('quiesced');
  // Close the probe/inspection gap before any Docker mutation.
  for (const original of originals) {
    const current = await api('GET', `/containers/${original.Id}/json`);
    if (!current.State.Running || current.Id !== original.Id || identity(current) !== identity(original)) {
      throw new Error('Source changed during quiescence');
    }
  }
  try {
    for (const original of [...originals].reverse()) {
      await api('POST', `/containers/${original.Id}/stop?t=120`);
    }
    for (const original of originals) {
      const name = original.Name.slice(1);
      await api('POST', `/containers/${original.Id}/rename?name=${name}-retained-${original.Id.slice(0, 12)}`);
      await api('POST', `/networks/${network}/disconnect`, { Container: original.Id });
      const result = await api('POST', `/containers/create?name=${name}`, replacementBody(original, plan.image));
      created.push(result.Id);
      await api('POST', `/containers/${result.Id}/start`);
      if (name === serviceNames[0]) await verify('appReady');
    }
    for (const [index, id] of created.entries()) {
      const current = await api('GET', `/containers/${id}/json`);
      const { HostConfig, NetworkingConfig, ...config } = replacementBody(originals[index], plan.image);
      if (!current.State.Running || current.Image !== candidate.Id
        || !isDeepStrictEqual(current.Config, config)
        || !isDeepStrictEqual(current.HostConfig, HostConfig)
        || Object.keys(current.NetworkSettings.Networks).join() !== Object.keys(NetworkingConfig.EndpointsConfig).join()) {
        throw new Error('Replacement parity failed');
      }
    }
    await health();
    await verify('accepted');
    return { deployed: true, sha: plan.sha, image: plan.image, containers: created,
      retained: originals.map((original) => original.Id) };
  } catch {
    // No automatic old-image restart: candidate may already have written data.
    // Stop every candidate; a failed stop requires explicit operator containment.
    const stops = await Promise.allSettled(created.map(async (id) => {
      await api('POST', `/containers/${id}/stop?t=120`);
      const current = await api('GET', `/containers/${id}/json`);
      if (current.Id !== id || current.State?.Running !== false) throw new Error('Candidate not contained');
    }));
    throw new Error(stops.some((result) => result.status === 'rejected')
      ? 'Replacement failed; candidate containment failed, operator intervention required'
      : 'Replacement failed; candidates stopped, originals retained; use reviewed recovery procedure');
  }
}

async function health() {
  for (const origin of ['http://127.0.0.1:13000', 'http://192.168.1.240:13000', 'https://aries.deliciouswines.org']) {
    for (const route of ['/', '/api/health/db']) {
      const response = await fetch(`${origin}${route}`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (response.status !== 200) throw new Error('Health check failed');
      if (route.endsWith('/db') && (await response.json()).status !== 'ok') throw new Error('Database health failed');
      await response.body?.cancel().catch(() => {});
    }
  }
}

export function validateExecution(plan, now = Date.now()) {
  preflightRelease(plan);
  if (plan.mode !== 'compatible_image_only' || plan.schemaChanged !== false) throw new Error('Schema/cutover changes are not supported');
  const checkpointTime = Date.parse(plan.checkpointAt);
  if (!Number.isFinite(checkpointTime) || checkpointTime > now || now - checkpointTime > 3600000) throw new Error('Fresh release checkpoint required');
  if (!path.isAbsolute(plan.verifier?.path || '') || !/^[a-f0-9]{64}$/.test(plan.verifier?.sha256 || '')) throw new Error('Reviewed verifier required');
}

export function validateRehearsalTarget(target, info, isolatedNetwork, originals = []) {
  if (!path.isAbsolute(target?.socket || '') || !/^[a-f0-9]{64}$/.test(target?.token || '')
    || typeof target.daemonId !== 'string' || !target.daemonId || info.ID !== target.daemonId
    || !info.Labels?.includes(`aries.replacement.rehearsal=${target.token}`)
    || isolatedNetwork.Internal !== true || isolatedNetwork.Driver !== 'bridge') throw new Error('Invalid isolated target');
  for (const original of originals) {
    if (original.Config.Labels?.['aries.replacement.rehearsal'] !== target.token
      || original.Mounts?.length !== 0 || Object.keys(original.HostConfig.PortBindings || {}).length
      || original.HostConfig.Privileged || original.HostConfig.NetworkMode !== network) throw new Error('Non-fixture source');
    replacementBody(original, original.Config.Image);
  }
}

async function main() {
  if (process.platform !== 'linux') throw new Error('Wrong execution platform');
  const args = process.argv.slice(2);
  let target;
  if (args[0] === '--rehearsal') {
    const targetPath = args[1];
    target = JSON.parse(readFileSync(targetPath, 'utf8'));
    // No DOCKER_HOST fallback or production socket alias (including symlinks).
    target.socket = realpathSync(target.socket);
    if (['/run/docker.sock', '/var/run/docker.sock'].includes(target.socket)) throw new Error('Production socket forbidden');
    args.splice(0, 2);
  } else if (hostname() !== 'ubuntu-docker') throw new Error('Wrong execution host');
  const api = (method, route, body) => dockerApi(method, route, body, target?.socket);
  if (target) validateRehearsalTarget(target, await api('GET', '/info'), await api('GET', `/networks/${network}`));
  const mode = args[0];
  if (!['--inventory', '--execute'].includes(mode)) throw new Error('Use --inventory or --execute <plan.json>');
  // A local single-writer lock is also held for inventory. Stale lock removal is manual.
  const lockPath = target ? `${target.socket}.replacement.lock` : '/home/node/.aries-replacement.lock';
  const lock = openSync(lockPath, 'wx', 0o600);
  try {
    let plan;
    if (mode === '--execute') {
      plan = JSON.parse(readFileSync(args[1], 'utf8'));
      validateExecution(plan);
      if (hash(readFileSync(plan.verifier.path)) !== plan.verifier.sha256) throw new Error('Verifier drift');
    }
    const originals = await Promise.all(serviceNames.map((name) => api('GET', `/containers/${name}/json`)));
    if (target) validateRehearsalTarget(target, await api('GET', '/info'), await api('GET', `/networks/${network}`), originals);
    if (mode === '--inventory') {
      console.log(JSON.stringify(Object.fromEntries(originals.map((c) => [c.Name.slice(1), { id: c.Id, fingerprint: identity(c) }]))));
      return;
    }
    validateSources(originals, plan.sources);
    // Candidate must already be staged by digest; this command never pulls or builds.
    const candidate = await api('GET', `/images/${encodeURIComponent(plan.image)}/json`);
    if (!candidate.RepoDigests?.includes(plan.image) || candidate.Config?.Labels?.['org.opencontainers.image.revision'] !== plan.sha) {
      throw new Error('Candidate digest/revision mismatch');
    }
    const verify = async (phase) => {
      // No shell and no inherited application env. Reviewed probe owns functional
      // checks and durable quiescence; output is suppressed even when it fails.
      if (hash(readFileSync(plan.verifier.path)) !== plan.verifier.sha256) throw new Error('Verifier drift');
      const result = spawnSync(plan.verifier.path, [phase, plan.sha, plan.image], {
        env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, encoding: 'utf8', timeout: 180000,
      });
      if (result.status !== 0) throw new Error('Operations verifier failed');
    };
    const receipt = await replaceRelease(plan, originals, candidate, { api, verify,
      health: target ? () => verify('health') : health });
    console.log(JSON.stringify(target ? { ...receipt, deployed: false, status: 'rehearsal_passed' } : receipt));
  } finally { closeSync(lock); unlinkSync(lockPath); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Includes parser/probe/daemon failures: no credential-bearing diagnostics.
    console.error('Replacement refused or failed. Keep rollout gated; inspect protected operator evidence and retained containers.');
    process.exitCode = 1;
  });
}
