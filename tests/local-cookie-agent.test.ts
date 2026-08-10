import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(ROOT, 'ops', 'local-cookie-agent');

function executable(pathname: string, content: string): void {
  writeFileSync(pathname, content, { mode: 0o755 });
  chmodSync(pathname, 0o755);
}

test('pull-and-refresh acts only on allowlisted stale platform names from VM state', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aries-local-cookie-agent-'));
  try {
    const bundle = path.join(root, 'bundle');
    const bin = path.join(root, 'bin');
    mkdirSync(bundle);
    mkdirSync(bin);
    copyFileSync(path.join(BUNDLE, 'pull-and-refresh.sh'), path.join(bundle, 'pull-and-refresh.sh'));
    writeFileSync(
      path.join(bundle, 'config.env'),
      "VM_SSH_TARGET='vm-test'\nVM_PROBER_STATE='/state.json'\nPLATFORMS='instagram twitter'\n",
    );
    executable(
      path.join(bin, 'ssh'),
      `#!/usr/bin/env bash
printf '%s\n' '{"platforms":{"instagram":{"status":"stale"},"twitter":{"status":"fresh"},"../../evil":{"status":"stale"}}}'
`,
    );
    executable(
      path.join(bin, 'python3'),
      `#!/usr/bin/env bash
exec python "$@"
`,
    );
    const capture = path.join(root, 'refresh-args.txt');
    executable(
      path.join(bundle, 'refresh-cookies.sh'),
      `#!/usr/bin/env bash
printf '%s\n' "$@" > "$CAPTURE_PATH"
`,
    );

    const run = spawnSync('bash', [path.join(bundle, 'pull-and-refresh.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CAPTURE_PATH: capture,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });

    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(readFileSync(capture, 'utf8').trim(), 'instagram');
    assert.match(run.stderr, /IGNORED un-allowlisted platform name\(s\).*\.\.\/\.\.\/evil/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refresh-cookies rejects platform path injection before running an exporter', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aries-local-cookie-agent-'));
  try {
    copyFileSync(path.join(BUNDLE, 'refresh-cookies.sh'), path.join(root, 'refresh-cookies.sh'));
    writeFileSync(
      path.join(root, 'config.env'),
      [
        `STAGING_DIR='${path.join(root, 'staging').replaceAll('\\', '/')}'`,
        "PLATFORMS='instagram'",
        "GPG_RECIPIENT='vm-test'",
        "VM_SSH_TARGET='vm-test'",
        "VM_INBOX='/inbox'",
        '',
      ].join('\n'),
    );

    const run = spawnSync('bash', [path.join(root, 'refresh-cookies.sh'), '../../evil'], {
      encoding: 'utf8',
      env: process.env,
    });

    assert.equal(run.status, 8, run.stderr || run.stdout);
    assert.match(run.stdout, /refusing platform name/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Bitwarden payload stays off argv and uploads stay hidden until atomic rename', () => {
  const credentials = readFileSync(path.join(BUNDLE, 'bw-fetch-creds.sh'), 'utf8');
  const refresh = readFileSync(path.join(BUNDLE, 'refresh-cookies.sh'), 'utf8');
  const executableCredentials = credentials
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

  assert.match(credentials, /printf '%s' "\$json" \| python3 -c/);
  assert.doesNotMatch(executableCredentials, /python3\s+-\s+"\$json"/);
  assert.doesNotMatch(executableCredentials, /bw get item "\$item"\s+--session/);
  assert.match(refresh, /\$remote_name\.partial/);
  assert.match(refresh, /mv -- .*\.partial.*\$remote_name/);
});
