import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import AriesBusinessProfileScreen from '../frontend/aries-v1/business-profile-screen';
import { publishConfigFromChannels } from '../backend/marketing/runtime-state';
import { normalizeMetaProvider } from '../backend/integrations/meta-publishing';
import { canonicalizePublishReviewPlatformSlug } from '../backend/marketing/publish-review-asset-ids';
import { connectablePlatforms } from '../backend/integrations/providers/integration-config';
import { updateBusinessProfileWithDiagnostics } from '../backend/tenant/business-profile';
import { PATCH as saveProfile } from '../app/api/business/profile/route';
import { handleComposioConnect } from '../app/api/integrations/composio/handlers';
import { selectableMarketingChannels } from '../lib/marketing-channels';
import MetaAdsChannel from '../frontend/integrations/meta-ads-channel';

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('Facebook Page and legacy meta generate organic Facebook publishing, never ads', () => {
  for (const channel of ['facebook', 'meta']) {
    assert.deepEqual(publishConfigFromChannels([channel, 'instagram']), {
      platforms: ['facebook', 'instagram'], live_publish_platforms: ['facebook', 'instagram'], video_render_platforms: [],
    });
    assert.equal(normalizeMetaProvider(channel), 'facebook');
    assert.equal(canonicalizePublishReviewPlatformSlug(channel), 'facebook');
  }
  assert.equal(canonicalizePublishReviewPlatformSlug('meta-ads'), 'meta-ads');
});

test('Meta Ads cannot use organic Composio connect or be selected as an organic generation target', async () => {
  assert.equal(connectablePlatforms({ NODE_ENV: 'test' }).includes('meta_ads'), false);
  const connect = await handleComposioConnect(new Request('https://aries.example.com/api/integrations/composio/meta_ads/connect', { method: 'POST' }), 'meta_ads');
  assert.equal(connect.status, 400);
  for (const channel of ['meta-ads', 'meta_ads', 'Meta Ads', 'facebook-ads']) {
    const client = { query() { throw new Error('must reject before accessing the database'); } };
    await assert.rejects(updateBusinessProfileWithDiagnostics(client as never, {
      tenantId: '75', channels: [channel],
    }), /meta_ads_coming_soon/);
    const response = await saveProfile(new Request('https://aries.example.com/api/business/profile', {
      method: 'PATCH', body: JSON.stringify({ channels: [channel] }), headers: { 'content-type': 'application/json' },
    }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'meta_ads_coming_soon' });
  }
  assert.match(source('app/api/business/profile/route.ts'), /meta_ads_coming_soon[\s\S]*status: 400/);
});

test('resumed legacy selections use Facebook and never reselect disabled ads', () => {
  assert.deepEqual(selectableMarketingChannels(['meta', 'facebook', 'meta-ads', 'instagram']), ['facebook', 'instagram']);
});

test('paid generation stays disabled; profile and integrations expose the separate Ads connection', () => {
  for (const file of ['frontend/aries-v1/onboarding-flow.tsx', 'frontend/aries-v1/business-profile-screen.tsx']) {
    const text = source(file);
    assert.match(text, /id: 'facebook',[\s\S]*?label: 'Facebook Page'/);

    assert.match(text, /disabled=\{channel.disabled\}/);
    assert.match(text, /Coming soon/);
    assert.match(text, /if \(CHANNEL_OPTIONS.find\(.*\)\?\.disabled\) return;/);
    assert.doesNotMatch(text, /Paid social for direct-response demand capture and retargeting/);
  }
  assert.match(source('frontend/aries-v1/onboarding-flow.tsx'), /id: 'meta-ads',[\s\S]*?label: 'Meta Ads account',[\s\S]*?disabled: true/);
  assert.match(source('frontend/aries-v1/business-profile-screen.tsx'), /<MetaAdsChannel \/>/);
  const connections = source('frontend/integrations/composio-connections-screen.tsx');
  assert.match(connections, /facebook: 'Facebook Page'/);
  assert.match(connections, /<MetaAdsChannel \/>/);
});

test('rendered business profile keeps the Ads account separate from organic channel saves', async (t) => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const originalAct = globals.IS_REACT_ACT_ENVIRONMENT;
  const originalSelf = globals.self;
  globals.self = globalThis;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const profile = {
    businessName: 'Example Studio', websiteUrl: 'https://example.com', channels: ['meta'],
    brandKit: null,
  };
  let saved: { channels: string[] } | undefined;
  const fetcher: typeof fetch = async (url, init) => {
    if (init?.method === 'PATCH') {
      saved = JSON.parse(String(init.body));
      return Response.json({ profile: { ...profile, channels: saved?.channels } });
    }
    if (String(url).includes('/api/business/profile')) return Response.json({ profile });
    if (String(url).includes('/api/integrations')) return Response.json({ status: 'ok', cards: [] });
    return Response.json({ profiles: [] });
  };
  t.mock.method(globalThis, 'fetch', fetcher);
  let root!: ReactTestRenderer;
  t.after(async () => {
    if (root) await act(async () => root.unmount());
    globals.IS_REACT_ACT_ENVIRONMENT = originalAct;
    globals.self = originalSelf;
  });
  await act(async () => { root = create(React.createElement(AriesBusinessProfileScreen)); });
  const text = (node: { children: unknown[] }): string => node.children.map((child) =>
    typeof child === 'string' ? child : child && typeof child === 'object' && 'children' in child ? text(child as { children: unknown[] }) : '',
  ).join(' ');
  const page = root.root.find((node) => node.type === 'button' && text(node).includes('Facebook Page'));
  assert.ok(root.root.findByType(MetaAdsChannel));
  assert.equal(page.props.disabled, undefined);
  assert.equal(page.props['aria-pressed'], true, 'legacy meta loads as the organic selection');

  await act(async () => { page.props.onClick(); });
  assert.equal(page.props['aria-pressed'], false);
  await act(async () => { page.props.onClick(); });
  const save = root.root.find((node) => node.type === 'button' && /Save profile/.test(text(node)));
  await act(async () => { await save.props.onClick(); });
  assert.deepEqual(saved?.channels, ['facebook']);
});
