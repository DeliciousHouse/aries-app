import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

async function withDraftEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-onboarding-draft-route-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;

  try {
    return await run();
  } finally {
    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = previousCodeRoot;
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('/api/onboarding/draft creates, reads, and updates an onboarding draft by explicit token', async () => {
  await withDraftEnv(async () => {
    const route = await import('../app/api/onboarding/draft/route');

    const createdResponse = await route.POST();
    const createdBody = (await createdResponse.json()) as {
      draft: { draftId: string; status: string };
    };

    assert.equal(createdResponse.status, 201);
    assert.equal(createdBody.draft.status, 'draft');

    const patchResponse = await route.PATCH(
      new Request(`http://localhost/api/onboarding/draft?draft=${encodeURIComponent(createdBody.draft.draftId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          businessName: 'The FrameX',
          websiteUrl: 'https://theframex.com',
          channels: ['meta-ads'],
          goal: 'Book more design consultations',
          status: 'ready_for_auth',
        }),
      }),
    );
    const patchedBody = (await patchResponse.json()) as {
      draft: { businessName: string; websiteUrl: string; channels: string[]; goal: string; status: string };
    };

    assert.equal(patchResponse.status, 200);
    assert.equal(patchedBody.draft.businessName, 'The FrameX');
    assert.equal(patchedBody.draft.websiteUrl, 'https://theframex.com/');
    assert.deepEqual(patchedBody.draft.channels, ['meta-ads']);
    assert.equal(patchedBody.draft.goal, 'Book more design consultations');
    assert.equal(patchedBody.draft.status, 'ready_for_auth');

    const getResponse = await route.GET(
      new Request(`http://localhost/api/onboarding/draft?draft=${encodeURIComponent(createdBody.draft.draftId)}`),
    );
    const getBody = (await getResponse.json()) as {
      draft: { businessName: string; status: string };
    };

    assert.equal(getResponse.status, 200);
    assert.equal(getBody.draft.businessName, 'The FrameX');
    assert.equal(getBody.draft.status, 'ready_for_auth');
  });
});

test('/api/onboarding/draft rejects reads and writes without an explicit draft token', async () => {
  await withDraftEnv(async () => {
    const route = await import('../app/api/onboarding/draft/route');

    const getResponse = await route.GET(new Request('http://localhost/api/onboarding/draft'));
    const getBody = (await getResponse.json()) as { error: string };
    assert.equal(getResponse.status, 400);
    assert.equal(getBody.error, 'draft_token_required');

    const patchResponse = await route.PATCH(
      new Request('http://localhost/api/onboarding/draft', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ businessName: 'The FrameX' }),
      }),
    );
    const patchBody = (await patchResponse.json()) as { error: string };
    assert.equal(patchResponse.status, 400);
    assert.equal(patchBody.error, 'draft_token_required');
  });
});
