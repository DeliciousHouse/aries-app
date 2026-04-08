import assert from 'node:assert/strict';
import test from 'node:test';

import { handleIntegrationsGet } from '../app/api/integrations/handlers';

const OAUTH_ENV_KEYS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'LINKEDIN_CLIENT_ID',
  'LINKEDIN_CLIENT_SECRET',
  'META_APP_ID',
  'META_APP_SECRET',
  'META_AD_ACCOUNT_ID',
  'META_ACCESS_TOKEN',
  'META_PAGE_ID',
  'OAUTH_TOKEN_ENCRYPTION_KEY',
  'REDDIT_CLIENT_ID',
  'REDDIT_CLIENT_SECRET',
  'TIKTOK_CLIENT_KEY',
  'TIKTOK_CLIENT_SECRET',
  'X_CLIENT_ID',
  'X_CLIENT_SECRET',
] as const;

function withClearedOauthEnv(fn: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of OAUTH_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }

  return fn().finally(() => {
    for (const key of OAUTH_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

test('/api/integrations marks unconfigured providers as disabled and unavailable', async () => {
  await withClearedOauthEnv(async () => {
    const response = await handleIntegrationsGet(async () => ({
      userId: 'user_123',
      tenantId: '123',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    }));

    const body = (await response.json()) as {
      status: string;
      summary: {
        total: number;
        not_connected: number;
      };
      cards: Array<{
        platform: string;
        connection_state: string;
        available_actions: string[];
        error?: {
          code: string;
          message: string;
        };
      }>;
    };

    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.summary.total, 7);
    assert.equal(body.summary.not_connected, 7);

    const linkedin = body.cards.find((card) => card.platform === 'linkedin');
    assert.equal(linkedin?.connection_state, 'disabled');
    assert.deepEqual(linkedin?.available_actions, []);
    assert.equal(linkedin?.error?.code, 'provider_unavailable');
    assert.equal(linkedin?.error?.message, 'Publishing is not ready yet.');
    assert.doesNotMatch(linkedin?.error?.message || '', /LINKEDIN_CLIENT_ID|META_APP_SECRET|OAUTH_TOKEN_ENCRYPTION_KEY/);
  });
});
