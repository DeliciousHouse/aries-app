import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('standup watchdog checks the same shared meetings report directory as the producer', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'aries-standup-watchdog-'));
  try {
    const date = '2026-04-29';
    const meetingsDir = path.join(tmp, 'meetings');
    const reportDir = path.join(meetingsDir, `${date}-daily-standup-reports`);
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(path.join(meetingsDir, `${date}-daily-standup.md`), '# Standup\n');
    for (const report of ['forge-report.json', 'signal-report.json', 'ledger-report.json']) {
      writeFileSync(path.join(reportDir, report), '{}\n');
    }

    const output = execFileSync(
      process.execPath,
      ['skills/operations/aries-standup-watchdog/scripts/run-watchdog.mjs', date],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          ARIES_SHARED_MEETINGS_DIR: meetingsDir,
          ARIES_CANONICAL_REPO_ROOT: path.join(tmp, 'repo'),
        },
        encoding: 'utf8',
      }
    );

    assert.match(output, /STANDUP WATCHDOG OK/);
    assert.match(output, /2026-04-29-daily-standup-reports/);
    assert.doesNotMatch(output, /standups\/2026-04-29/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
