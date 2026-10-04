import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFixtureConfig, assertNoDefaultRoute } from '../scripts/release/verify-worker-fixture';

const config = {
  DB_NAME: 'aries_release_fixture_0123456789abcdef', DB_HOST: '/fixture/pg', DB_USER: 'fixture',
  DOTENV_CONFIG_PATH: '/fixture/absent', ARIES_RELEASE_FIXTURE_SHA: 'a'.repeat(40),
  ARIES_RELEASE_FIXTURE_DIGEST: `sha256:${'b'.repeat(64)}`,
};

test('worker verifier refuses implicit, live or malformed targets before importing workers', () => {
  assert.doesNotThrow(() => validateFixtureConfig(config));
  for (const [key, value] of [
    ['DB_NAME', 'aries_snapshot'], ['DB_HOST', '192.168.1.240'], ['DB_USER', ''],
    ['DOTENV_CONFIG_PATH', ''], ['ARIES_RELEASE_FIXTURE_SHA', 'main'],
    ['ARIES_RELEASE_FIXTURE_DIGEST', 'latest'],
  ]) assert.throws(() => validateFixtureConfig({ ...config, [key]: value }));
});

test('worker verifier refuses IPv4 or IPv6 default routes', () => {
  assert.doesNotThrow(() => assertNoDefaultRoute('Iface Destination Gateway Flags\n', ''));
  assert.throws(() => assertNoDefaultRoute('Iface Destination Gateway Flags\neth0 00000000 01010101 0003', ''));
  assert.throws(() => assertNoDefaultRoute('', `${'0'.repeat(32)} 00 ${'0'.repeat(32)} 00 ${'0'.repeat(32)} 00000001 00000000 00000000 00000001 eth0`));
});
