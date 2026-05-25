// PRD §20 invariant 12:
//   "Provider credentials must never appear in browser payloads, memory, logs,
//    or AI prompts."
//
// Operationalized as: provider credentials live encrypted at rest via
// encryptToken / decryptToken in backend/integrations/oauth-crypto.ts.  The
// encryption helper requires a 32-byte key.  Frontend (frontend/, components/,
// app/**/page.tsx) must never import the crypto module directly — if it did,
// keys would land in the browser bundle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRepoFile, scanForPattern, repoPath } from './_helpers';

test('oauth-crypto requires a configured encryption key (no silent passthrough)', () => {
  const source = readRepoFile('backend/integrations/oauth-crypto.ts');
  assert.match(
    source,
    /OAUTH_TOKEN_ENCRYPTION_KEY/,
    'oauth-crypto must surface OAUTH_TOKEN_ENCRYPTION_KEY as the configured key',
  );
  assert.match(
    source,
    /must_be_32_bytes/,
    'oauth-crypto must reject keys of the wrong length, not silently fall back to plaintext',
  );
});

test('encrypt/decrypt helpers are exported from oauth-crypto', () => {
  const source = readRepoFile('backend/integrations/oauth-crypto.ts');
  assert.match(source, /export\s+function\s+encryptToken\b/);
  assert.match(source, /export\s+function\s+decryptToken\b/);
});

test('no frontend code imports oauth-crypto (keys must stay server-side)', () => {
  const hitsInFrontend = scanForPattern(
    repoPath('frontend'),
    /from\s+['"][^'"]*oauth-crypto/,
  );
  const hitsInComponents = scanForPattern(
    repoPath('components'),
    /from\s+['"][^'"]*oauth-crypto/,
  );
  const all = [...hitsInFrontend, ...hitsInComponents];
  assert.deepEqual(
    all,
    [],
    `oauth-crypto must remain server-side; client imports found:\n${all.join('\n')}`,
  );
});
