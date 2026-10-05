import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
// @ts-expect-error — .mjs script imported for its exported pure preflight.
import { preflightRelease, requiredCheckpoints } from '../scripts/release/ubuntu-docker-preflight.mjs';

const root = process.cwd();
const sha = 'a'.repeat(40);
const image = `ghcr.io/delicioushouse/aries-app@sha256:${'b'.repeat(64)}`;
function prepared() {
  return {
    host: 'ubuntu-docker',
    origin: 'https://aries.deliciouswines.org',
    sha,
    image,
    checkpoints: Object.fromEntries(requiredCheckpoints.map((name: string) => [name, {
      sha, image, evidence: 'sanitized-evidence-reference',
    }])),
  };
}

test('preflight rejects missing, wrong-target, mutable-image and unbound checkpoint evidence', () => {
  assert.throws(() => preflightRelease(null), /release plan/);
  for (const field of ['host', 'origin', 'sha', 'image', 'checkpoints']) {
    const plan: Partial<ReturnType<typeof prepared>> = prepared();
    delete plan[field as keyof typeof plan];
    assert.throws(() => preflightRelease(plan), new RegExp(field));
  }
  for (const [field, value] of [
    ['host', 'other-host'], ['origin', 'http://localhost:3000'],
    ['sha', 'master'], ['image', 'ghcr.io/delicioushouse/aries-app:latest'],
  ]) {
    assert.throws(() => preflightRelease({ ...prepared(), [field]: value }), new RegExp(field));
  }
  for (const name of requiredCheckpoints) {
    const plan = prepared();
    delete plan.checkpoints[name];
    assert.throws(() => preflightRelease(plan), new RegExp(name));
    for (const bad of [null, true, {}, { sha, image, evidence: ' ' },
      { sha: 'c'.repeat(40), image, evidence: 'stale' },
      { sha, image: `${image}0`, evidence: 'stale' }]) {
      plan.checkpoints[name] = bad;
      assert.throws(() => preflightRelease(plan), new RegExp(name));
    }
  }
});

test('complete evidence permits preparation review only, never deployment success', () => {
  assert.deepEqual(preflightRelease(prepared()), {
    status: 'prepared_not_deployed', deployed: false, sha, image,
  });
});

test('CLI fails closed without evidence and can check a complete plan without host access', () => {
  const script = path.join(root, 'scripts/release/ubuntu-docker-preflight.mjs');
  const missing = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /release plan/);
  const dir = mkdtempSync(path.join(tmpdir(), 'aries-release-preflight-'));
  try {
    const file = path.join(dir, 'plan.json');
    writeFileSync(file, JSON.stringify(prepared()));
    const result = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).deployed, false);
    writeFileSync(file, '{invalid');
    assert.equal(spawnSync(process.execPath, [script, file]).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retired deployment cannot reach ubuntu-docker through any active workflow', () => {
  assert.equal(existsSync(path.join(root, '.github/workflows/deploy.yml')), false);
  const workflows = readdirSync(path.join(root, '.github/workflows'))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => readFileSync(path.join(root, '.github/workflows', name), 'utf8'))
    .join('\n').split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(workflows, /self-hosted|DEPLOY_PATH|reset --hard|clean -fd/);
  assert.doesNotMatch(workflows, /docker compose (?:up|run|pull)|sync-env-image-pin|apply-schema-with-worker-restore/);
  assert.doesNotMatch(workflows, /sugarandleather\.com|aries-autoheal|\/home\/node\/data|docker-stack|13000:3000/);
  const preflight = readFileSync(path.join(root, 'scripts/release/ubuntu-docker-preflight.mjs'), 'utf8');
  assert.doesNotMatch(preflight, /child_process|fetch\(|process\.env|writeFile|\bdocker\s|\bssh\s/);
});

test('existing hosted publisher offers a SHA-addressable preparation image only', () => {
  const release = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  assert.match(release, /runs-on: ubuntu-latest/);
  assert.match(release, /type=sha,format=long,enable=\$\{\{ github.event_name == 'workflow_dispatch' \}\}/);
  assert.match(release, /type=raw,value=latest,enable=\$\{\{ startsWith\(github.ref, 'refs\/tags\/v'\) \}\}/);
  assert.doesNotMatch(release, /docker compose|self-hosted|environment: production/);
  const guidance = readFileSync(path.join(root, 'docs/DEPLOYMENT.md'), 'utf8');
  assert.match(guidance, /https:\/\/aries\.deliciouswines\.org/);
  assert.doesNotMatch(guidance, /aries\.sugarandleather\.com/);
});
