import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();

function bashPath(value: string): string {
  return value.replace(/^([A-Za-z]):\\/, (_match, drive: string) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/');
}

test('video-render-runtime is active in the index-managed skill registry', () => {
  const index = JSON.parse(readFileSync(path.join(ROOT, 'skills', 'index.json'), 'utf8')) as {
    skills?: Array<Record<string, unknown>>;
  };
  const entries = index.skills?.filter((entry) => entry.name === 'video-render-runtime') ?? [];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'active');
  assert.equal(entries[0].path, 'skills/video-render-runtime/SKILL.md');
});

test('self-host skill upgrade installs the replacement, retires only its predecessor, and preserves user skills idempotently', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aries-skill-upgrade-'));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  const predecessor = `${['v', 'eo'].join('')}-video-runtime`;
  try {
    mkdirSync(path.join(source, 'video-render-runtime'), { recursive: true });
    writeFileSync(path.join(source, 'video-render-runtime', 'SKILL.md'), 'replacement-v2\n');
    mkdirSync(path.join(target, predecessor), { recursive: true });
    writeFileSync(path.join(target, predecessor, 'SKILL.md'), 'predecessor\n');
    mkdirSync(path.join(target, 'video-render-runtime'), { recursive: true });
    writeFileSync(path.join(target, 'video-render-runtime', 'SKILL.md'), 'stale-replacement\n');
    mkdirSync(path.join(target, 'my-custom-skill'), { recursive: true });
    writeFileSync(path.join(target, 'my-custom-skill', 'SKILL.md'), 'user-owned\n');

    const script = path.join(ROOT, 'scripts', 'upgrade-hermes-skills.sh');
    execFileSync('bash', [bashPath(script), bashPath(source), bashPath(target)], { cwd: ROOT, stdio: 'pipe' });
    assert.equal(readFileSync(path.join(target, 'video-render-runtime', 'SKILL.md'), 'utf8'), 'replacement-v2\n');
    assert.equal(readFileSync(path.join(target, 'my-custom-skill', 'SKILL.md'), 'utf8'), 'user-owned\n');
    assert.throws(() => readFileSync(path.join(target, predecessor, 'SKILL.md'), 'utf8'));

    execFileSync('bash', [bashPath(script), bashPath(source), bashPath(target)], { cwd: ROOT, stdio: 'pipe' });
    assert.equal(readFileSync(path.join(target, 'video-render-runtime', 'SKILL.md'), 'utf8'), 'replacement-v2\n');
    assert.equal(readFileSync(path.join(target, 'my-custom-skill', 'SKILL.md'), 'utf8'), 'user-owned\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the self-host installer runs the idempotent managed-skill upgrade for non-empty skill volumes', () => {
  const installer = readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  assert.match(installer, /upgrade-hermes-skills\.sh/);
  assert.match(installer, /scripts\/upgrade-hermes-skills\.sh skills hermes-data\/skills/);
});
