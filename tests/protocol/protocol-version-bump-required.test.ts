import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROTOCOL_VERSION } from '../../packages/aries-hermes-protocol/src/index';

const PROTOCOL_SCHEMAS_PATH = path.resolve(
  import.meta.dirname ?? __dirname,
  '../../packages/aries-hermes-protocol/src/schemas.ts',
);

describe('protocol-version-bump-required', () => {
  it('PROTOCOL_VERSION is a valid semver string', () => {
    assert.match(PROTOCOL_VERSION, /^\d+\.\d+\.\d+$/, 'PROTOCOL_VERSION must be semver x.y.z');
  });

  it('schema file exists and exports PROTOCOL_VERSION', () => {
    assert.ok(fs.existsSync(PROTOCOL_SCHEMAS_PATH), 'schemas.ts must exist');
    const source = fs.readFileSync(PROTOCOL_SCHEMAS_PATH, 'utf8');
    assert.ok(
      source.includes('PROTOCOL_VERSION'),
      'schemas.ts must export PROTOCOL_VERSION',
    );
    assert.ok(
      source.includes(PROTOCOL_VERSION),
      `schemas.ts must contain the current version string "${PROTOCOL_VERSION}"`,
    );
  });

  it('schema file changed on this branch only if protocol files changed', () => {
    // If schemas.ts is modified relative to master, we verify PROTOCOL_VERSION
    // differs from the master version. This prevents silent schema drift.
    let schemasChangedVsMaster = false;
    let masterVersion: string | null = null;

    try {
      const diffOutput = execSync(
        'git diff origin/master -- packages/aries-hermes-protocol/src/schemas.ts',
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      schemasChangedVsMaster = diffOutput.trim().length > 0;
    } catch {
      // Not in a git repo or no origin/master — skip diff check.
      return;
    }

    if (!schemasChangedVsMaster) {
      // No schema changes — no version bump required.
      return;
    }

    // schemas.ts changed — confirm PROTOCOL_VERSION was also bumped.
    try {
      const masterSchemasSource = execSync(
        'git show origin/master:packages/aries-hermes-protocol/src/schemas.ts',
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const match = masterSchemasSource.match(/PROTOCOL_VERSION\s*=\s*['"]([^'"]+)['"]/);
      masterVersion = match ? match[1] : null;
    } catch {
      // Package didn't exist on master yet — first introduction, no bump needed.
      return;
    }

    if (masterVersion === null) {
      // Can't determine master version — skip.
      return;
    }

    assert.notEqual(
      PROTOCOL_VERSION,
      masterVersion,
      `schemas.ts changed vs master but PROTOCOL_VERSION is still "${masterVersion}". ` +
      'Bump PROTOCOL_VERSION in packages/aries-hermes-protocol/src/schemas.ts when changing schemas.',
    );
  });
});
