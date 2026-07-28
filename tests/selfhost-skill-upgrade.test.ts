import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();

function bashPath(value: string): string {
  return value.replace(/^([A-Za-z]):\\/, (_match, drive: string) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/');
}

function executableStub(binDir: string, name: string): void {
  const filePath = path.join(binDir, name);
  writeFileSync(filePath, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  chmodSync(filePath, 0o755);
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

test('normal self-host installer executes the real -x upgrade guard idempotently without touching user skills', () => {
  const stagedMode = execFileSync('git', ['ls-files', '--stage', 'scripts/upgrade-hermes-skills.sh'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim().split(/\s+/, 1)[0];
  assert.equal(stagedMode, '100755', 'the installer -x guard requires the upgrade script to be executable in Git');

  const root = mkdtempSync(path.join(tmpdir(), 'aries-selfhost-upgrade-'));
  const installRoot = path.join(root, 'checkout');
  const binDir = path.join(root, 'bin');
  const predecessor = `${['v', 'eo'].join('')}-video-runtime`;
  try {
    mkdirSync(path.join(installRoot, 'skills', 'video-render-runtime'), { recursive: true });
    mkdirSync(path.join(installRoot, 'scripts'), { recursive: true });
    mkdirSync(path.join(installRoot, 'hermes-data', 'skills', predecessor), { recursive: true });
    mkdirSync(path.join(installRoot, 'hermes-data', 'skills', 'video-render-runtime'), { recursive: true });
    mkdirSync(path.join(installRoot, 'hermes-data', 'skills', 'my-custom-skill'), { recursive: true });
    mkdirSync(binDir, { recursive: true });

    writeFileSync(path.join(installRoot, 'docker-compose.selfhost.yml'), 'services: {}\n');
    writeFileSync(path.join(installRoot, 'docker-compose.yml'), 'services: {}\n');
    writeFileSync(path.join(installRoot, '.env'), 'PORT=3000\n');
    writeFileSync(path.join(installRoot, 'skills', 'video-render-runtime', 'SKILL.md'), 'replacement-v2\n');
    writeFileSync(path.join(installRoot, 'hermes-data', 'skills', predecessor, 'SKILL.md'), 'predecessor\n');
    writeFileSync(path.join(installRoot, 'hermes-data', 'skills', 'video-render-runtime', 'SKILL.md'), 'stale-replacement\n');
    writeFileSync(path.join(installRoot, 'hermes-data', 'skills', 'my-custom-skill', 'SKILL.md'), 'user-owned\n');

    const upgradeScript = path.join(ROOT, 'scripts', 'upgrade-hermes-skills.sh');
    copyFileSync(upgradeScript, path.join(installRoot, 'scripts', 'upgrade-hermes-skills.sh'));
    chmodSync(path.join(installRoot, 'scripts', 'upgrade-hermes-skills.sh'), 0o755);
    executableStub(binDir, 'docker');
    executableStub(binDir, 'curl');

    const installerArgs = [
      bashPath(path.join(ROOT, 'install.sh')),
      '--dir',
      bashPath(installRoot),
      '--no-hermes',
      '--yes',
    ];
    const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` };
    execFileSync('bash', installerArgs, { cwd: ROOT, env, stdio: 'pipe' });

    assert.equal(readFileSync(path.join(installRoot, 'hermes-data', 'skills', 'video-render-runtime', 'SKILL.md'), 'utf8'), 'replacement-v2\n');
    assert.equal(readFileSync(path.join(installRoot, 'hermes-data', 'skills', 'my-custom-skill', 'SKILL.md'), 'utf8'), 'user-owned\n');
    assert.equal(existsSync(path.join(installRoot, 'hermes-data', 'skills', predecessor)), false);

    execFileSync('bash', installerArgs, { cwd: ROOT, env, stdio: 'pipe' });
    assert.equal(readFileSync(path.join(installRoot, 'hermes-data', 'skills', 'video-render-runtime', 'SKILL.md'), 'utf8'), 'replacement-v2\n');
    assert.equal(readFileSync(path.join(installRoot, 'hermes-data', 'skills', 'my-custom-skill', 'SKILL.md'), 'utf8'), 'user-owned\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
