import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

test('auth.ts jwt callback writes timezone onto the token', () => {
  const authSrc = readRepoFile('auth.ts');
  assert.match(authSrc, /token\.timezone\s*=\s*loadTenantTimezoneOrFallback/, 'jwt callback must write token.timezone via loadTenantTimezoneOrFallback');
});

test('auth.ts session callback projects token.timezone onto session.user.timezone', () => {
  const authSrc = readRepoFile('auth.ts');
  assert.match(authSrc, /session\.user\.timezone\s*=\s*String\(token\.timezone\)/, 'session callback must project token.timezone to session.user.timezone');
});

test('next-auth type augmentation includes timezone on Session.user', () => {
  const typesSrc = readRepoFile('types/next-auth.d.ts');
  assert.match(typesSrc, /timezone\?:\s*string/, 'Session.user type augmentation must include timezone field');
});

test('next-auth type augmentation includes timezone on JWT', () => {
  const typesSrc = readRepoFile('types/next-auth.d.ts');
  assert.match(typesSrc, /interface JWT[\s\S]*?timezone\?:\s*string/, 'JWT type augmentation must include timezone field');
});

test('use-tenant-timezone hook reads session timezone and falls back to DEFAULT_TENANT_TIMEZONE', () => {
  const hookSrc = readRepoFile('hooks/use-tenant-timezone.ts');
  assert.match(hookSrc, /SessionContext/, 'hook must use next-auth SessionContext to read session');
  assert.match(hookSrc, /DEFAULT_TENANT_TIMEZONE/, 'hook must fall back to DEFAULT_TENANT_TIMEZONE when session is missing');
  assert.match(hookSrc, /timezone/, 'hook must read timezone from session.user.timezone');
});
