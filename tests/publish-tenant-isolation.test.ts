import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { assertMediaUrlsBelongToTenant } from '../backend/integrations/media-url-ownership';

const mockPool = {
  connect: async () => ({
    query: async (sql: string, params: unknown[]) => {
      const [tenantId, url] = params;
      if (sql.includes('SELECT id FROM creative_assets')) {
        if (tenantId === 1 && url === '/assets/tenant-1/image.jpg') {
          return { rows: [{ id: 'asset-uuid-1' }] };
        }
        return { rows: [] };
      }
      return { rows: [] };
    },
    release: () => {},
  }),
} as unknown as Pool;

test('assertMediaUrlsBelongToTenant: own tenant asset passes', async () => {
  const tenantId = 1;
  const urls = ['/assets/tenant-1/image.jpg'];

  try {
    await assertMediaUrlsBelongToTenant(tenantId, urls, mockPool);
    assert.ok(true, 'Should not throw for own tenant asset');
  } catch (error) {
    assert.fail(`Should not throw: ${error}`);
  }
});

test('assertMediaUrlsBelongToTenant: other tenant asset throws', async () => {
  const tenantId = 1;
  const urls = ['/assets/tenant-2/image.jpg'];

  try {
    await assertMediaUrlsBelongToTenant(tenantId, urls, mockPool);
    assert.fail('Should throw for other tenant asset');
  } catch (error) {
    const message = String((error as Error).message);
    assert.ok(message.includes('media_url_tenant_mismatch'), `Expected media_url_tenant_mismatch, got: ${message}`);
  }
});

test('assertMediaUrlsBelongToTenant: external URL throws', async () => {
  const tenantId = 1;
  const urls = ['https://example.com/image.jpg'];

  try {
    await assertMediaUrlsBelongToTenant(tenantId, urls, mockPool);
    assert.fail('Should throw for external URL');
  } catch (error) {
    const message = String((error as Error).message);
    assert.ok(message.includes('media_url_tenant_mismatch'), `Expected media_url_tenant_mismatch, got: ${message}`);
  }
});

test('assertMediaUrlsBelongToTenant: missing asset throws', async () => {
  const tenantId = 1;
  const urls = ['/assets/tenant-1/nonexistent.jpg'];

  try {
    await assertMediaUrlsBelongToTenant(tenantId, urls, mockPool);
    assert.fail('Should throw for missing asset');
  } catch (error) {
    const message = String((error as Error).message);
    assert.ok(message.includes('media_url_tenant_mismatch'), `Expected media_url_tenant_mismatch, got: ${message}`);
  }
});

test('assertMediaUrlsBelongToTenant: empty URLs array passes', async () => {
  const tenantId = 1;
  const urls: string[] = [];

  try {
    await assertMediaUrlsBelongToTenant(tenantId, urls, mockPool);
    assert.ok(true, 'Should not throw for empty URLs');
  } catch (error) {
    assert.fail(`Should not throw: ${error}`);
  }
});
