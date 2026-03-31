import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

test('meta-ads-extractor reports configured Meta env flags without exposing raw ids', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'meta-ads-extractor-'));

  try {
    const mockSearchPath = path.join(tempDir, 'mock-search.sh');
    writeFileSync(
      mockSearchPath,
      [
        '#!/bin/sh',
        "printf '%s\\n' '{\"results\":[{\"title\":\"Acme growth campaign\",\"url\":\"https://example.com\",\"snippet\":\"Campaign proof point.\"}]}'",
      ].join('\n'),
      'utf8',
    );
    chmodSync(mockSearchPath, 0o755);

    const result = spawnSync(
      'python3',
      [path.join(PROJECT_ROOT, 'lobster/bin/meta-ads-extractor'), '--json', '--competitor', 'Acme'],
      {
        env: {
          ...process.env,
          LOBSTER_WEB_SEARCH_CMD: mockSearchPath,
          LOBSTER_STAGE1_CACHE_DIR: path.join(tempDir, 'cache'),
          META_ACCESS_TOKEN: 'secret-value',
          META_AD_ACCOUNT_ID: '123456789',
          META_PAGE_ID: '',
          GEMINI_API_KEY: '',
        },
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout) as {
      meta_config: Record<string, unknown>;
    };

    assert.deepEqual(payload.meta_config, {
      has_access_token: true,
      has_ad_account_id: true,
      has_page_id: false,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
