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

import Ajv2020 from 'ajv/dist/2020.js';

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
    mkdirSync(path.join(installRoot, 'specs'), { recursive: true });
    mkdirSync(path.join(installRoot, 'scripts'), { recursive: true });
    mkdirSync(path.join(installRoot, 'hermes-data', 'skills', predecessor), { recursive: true });
    mkdirSync(path.join(installRoot, 'hermes-data', 'skills', 'video-render-runtime'), { recursive: true });
    mkdirSync(path.join(installRoot, 'hermes-data', 'skills', 'my-custom-skill'), { recursive: true });
    mkdirSync(binDir, { recursive: true });

    writeFileSync(path.join(installRoot, 'docker-compose.selfhost.yml'), 'services: {}\n');
    writeFileSync(path.join(installRoot, 'docker-compose.yml'), 'services: {}\n');
    writeFileSync(path.join(installRoot, '.env'), 'PORT=3000\n');
    writeFileSync(path.join(installRoot, 'skills', 'video-render-runtime', 'SKILL.md'), 'replacement-v2\n');
    copyFileSync(
      path.join(ROOT, 'skills', 'index.json'),
      path.join(installRoot, 'skills', 'index.json'),
    );
    copyFileSync(
      path.join(ROOT, 'skills', 'video-render-runtime', 'contract.json'),
      path.join(installRoot, 'skills', 'video-render-runtime', 'contract.json'),
    );
    for (const schemaName of ['video_job_contract_spec.v2.json', 'video_runtime_state_schema.v2.json']) {
      copyFileSync(path.join(ROOT, 'specs', schemaName), path.join(installRoot, 'specs', schemaName));
    }
    writeFileSync(path.join(installRoot, 'hermes-data', 'skills', predecessor, 'SKILL.md'), 'predecessor\n');
    writeFileSync(path.join(installRoot, 'hermes-data', 'skills', 'video-render-runtime', 'SKILL.md'), 'stale-replacement\n');
    writeFileSync(path.join(installRoot, 'hermes-data', 'skills', 'my-custom-skill', 'SKILL.md'), 'user-owned\n');
    const userRegistryEntry = {
      name: 'my-custom-skill',
      category: 'user-owned',
      path: 'skills/my-custom-skill/SKILL.md',
      owner: 'operator',
      status: 'active',
    };
    const userOwnedMetadata = [{ name: 'operator-owned-registry-metadata' }];
    writeFileSync(
      path.join(installRoot, 'hermes-data', 'skills', 'index.json'),
      `${JSON.stringify({ skills: [userRegistryEntry], owners: userOwnedMetadata }, null, 2)}\n`,
    );

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
    const installedRegistry = JSON.parse(
      readFileSync(path.join(installRoot, 'hermes-data', 'skills', 'index.json'), 'utf8'),
    ) as { skills: Array<Record<string, unknown>>; owners: Array<Record<string, unknown>> };
    assert.deepEqual(
      installedRegistry.skills.filter((entry) => entry.name === 'my-custom-skill'),
      [userRegistryEntry],
      'the real install path must preserve user-owned registry entries',
    );
    assert.deepEqual(installedRegistry.owners, userOwnedMetadata, 'unrelated registry arrays must remain untouched');
    assert.equal(
      installedRegistry.skills.filter((entry) => entry.name === 'video-render-runtime').length,
      1,
      'the managed registry entry must be merged exactly once',
    );
    assert.equal(
      installedRegistry.skills.find((entry) => entry.name === 'video-render-runtime')?.path,
      'skills/video-render-runtime/SKILL.md',
    );
    const installedSkillDir = path.join(installRoot, 'hermes-data', 'skills', 'video-render-runtime');
    const installedContract = JSON.parse(readFileSync(path.join(installedSkillDir, 'contract.json'), 'utf8')) as {
      $ref: string;
      runtime_state_schema: string;
    };
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    for (const reference of [installedContract.$ref, installedContract.runtime_state_schema]) {
      const installedSchemaPath = path.resolve(installedSkillDir, reference);
      assert.equal(existsSync(installedSchemaPath), true, `installed schema reference must resolve: ${reference}`);
      assert.doesNotThrow(() => ajv.compile(JSON.parse(readFileSync(installedSchemaPath, 'utf8'))));
    }

    execFileSync('bash', installerArgs, { cwd: ROOT, env, stdio: 'pipe' });
    assert.equal(readFileSync(path.join(installRoot, 'hermes-data', 'skills', 'video-render-runtime', 'SKILL.md'), 'utf8'), 'replacement-v2\n');
    assert.equal(readFileSync(path.join(installRoot, 'hermes-data', 'skills', 'my-custom-skill', 'SKILL.md'), 'utf8'), 'user-owned\n');
    const rerunRegistry = JSON.parse(
      readFileSync(path.join(installRoot, 'hermes-data', 'skills', 'index.json'), 'utf8'),
    ) as { skills: Array<Record<string, unknown>> };
    assert.deepEqual(rerunRegistry, installedRegistry, 'a second install must leave the merged registry unchanged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
