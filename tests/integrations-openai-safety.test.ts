import assert from 'node:assert/strict';
import test from 'node:test';

import { handleIntegrationsGet } from '../app/api/integrations/handlers';

test('/api/integrations does not expose OpenAI through generic integration cards', async () => {
  const response = await handleIntegrationsGet(async () => ({
    userId: 'user_openai_safety',
    tenantId: 'tenant_openai_safety',
    tenantSlug: 'tenant-openai-safety',
    role: 'tenant_admin',
  }));
  const body = (await response.json()) as {
    supported_platforms: string[];
    cards: Array<Record<string, unknown>>;
  };

  assert.equal(response.status, 200);
  assert.equal(body.supported_platforms.includes('openai'), false);
  assert.equal(body.cards.some((card) => card.platform === 'openai'), false);

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('ChatGPT / OpenAI'), false);
  assert.equal(serialized.includes('"openai"'), false);
});
