import assert from 'node:assert/strict';
import test from 'node:test';

import { AutoPublisherProvider } from '../backend/integrations/providers/auto-providers';
import { MetaPublishError } from '../backend/integrations/meta-publishing';
import {
  ComposioConnectionMissingError,
  ComposioToolError,
} from '../backend/integrations/composio/errors';
import type { PublisherProvider } from '../backend/integrations/providers/interfaces';
import type { PublishPostInput, PublishResult } from '../backend/integrations/providers/types';

function publishInput(): PublishPostInput {
  return {
    tenantId: '15',
    platform: 'facebook',
    content: 'hi',
    mediaUrls: ['https://x/y.png'],
    approved: true,
    dryRun: false,
  };
}

function fakePublisher(behavior: {
  supports?: boolean;
  publishPost: () => Promise<PublishResult>;
}): PublisherProvider {
  return {
    kind: 'composio',
    supports: () => behavior.supports ?? true,
    publishPost: behavior.publishPost,
  } as unknown as PublisherProvider;
}

const directResult: PublishResult = {
  provider: 'direct_meta',
  platform: 'facebook',
  externalPostId: 'fb_direct',
  externalCampaignId: null,
  externalAdId: null,
  status: 'published',
  url: null,
  rawResponse: {},
};

test('auto falls back to direct when Composio fails with a definitely-never-posted error', async () => {
  let directCalled = false;
  const composio = fakePublisher({
    publishPost: async () => {
      throw new ComposioConnectionMissingError('facebook');
    },
  });
  const direct = fakePublisher({
    publishPost: async () => {
      directCalled = true;
      return directResult;
    },
  });

  const out = await new AutoPublisherProvider(composio, direct).publishPost(publishInput());
  assert.equal(directCalled, true, 'a never-posted Composio failure should fall back to direct');
  assert.equal(out.externalPostId, 'fb_direct');
});

test('auto falls back when Composio reports an explicit unsuccessful verdict (ComposioToolError)', async () => {
  let directCalled = false;
  const composio = fakePublisher({
    publishPost: async () => {
      throw new ComposioToolError('FACEBOOK_CREATE_POST', 'unsuccessful');
    },
  });
  const direct = fakePublisher({
    publishPost: async () => {
      directCalled = true;
      return directResult;
    },
  });

  await new AutoPublisherProvider(composio, direct).publishPost(publishInput());
  assert.equal(directCalled, true, 'broker successful:false means never posted → safe to fall back');
});

test('auto does NOT fall back (rethrows) on an outcome-unknown Composio failure — never duplicate', async () => {
  let directCalled = false;
  const transportErr = new Error('ECONNRESET mid-publish');
  const composio = fakePublisher({
    publishPost: async () => {
      throw transportErr;
    },
  });
  const direct = fakePublisher({
    publishPost: async () => {
      directCalled = true;
      return directResult;
    },
  });

  await assert.rejects(
    () => new AutoPublisherProvider(composio, direct).publishPost(publishInput()),
    (err: unknown) => err === transportErr,
  );
  assert.equal(directCalled, false, 'an outcome-unknown failure must NOT re-publish via direct (duplicate)');
});

test('auto does NOT fall back when Composio raises a MetaPublishError(outcomeUnknown)', async () => {
  let directCalled = false;
  const ou = new MetaPublishError('x', 'maybe live', { outcomeUnknown: true });
  const composio = fakePublisher({
    publishPost: async () => {
      throw ou;
    },
  });
  const direct = fakePublisher({
    publishPost: async () => {
      directCalled = true;
      return directResult;
    },
  });

  await assert.rejects(
    () => new AutoPublisherProvider(composio, direct).publishPost(publishInput()),
    (err: unknown) => err === ou,
  );
  assert.equal(directCalled, false);
});
