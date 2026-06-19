import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';

import ConnectPlatformsStep, {
  filterMetaAndInstagram,
  findCardByPlatform,
  hasAtLeastOneMetaConnection,
  type IntegrationCard,
  type IntegrationsResponse,
} from '../frontend/onboarding/pipeline-intake/steps/ConnectPlatformsStep';

function card(
  platform: string,
  connectionState: IntegrationCard['connection_state'],
  overrides: Partial<IntegrationCard> = {},
): IntegrationCard {
  return {
    platform,
    connection_state: connectionState,
    ...overrides,
  };
}

function nodeContainsText(node: unknown, text: string): boolean {
  if (node === null || node === undefined) return false;
  if (typeof node === 'string') return node.includes(text);
  if (typeof node === 'number') return String(node).includes(text);
  if (Array.isArray(node)) {
    return node.some((entry) => nodeContainsText(entry, text));
  }
  if (typeof node === 'object' && 'props' in (node as { props?: unknown })) {
    return nodeContainsText((node as { props?: { children?: unknown } }).props?.children, text);
  }
  return false;
}

function findContinueButton(root: ReactTestInstance): ReactTestInstance | null {
  const buttons = root.findAllByType('button');
  return (
    buttons.find((btn) => nodeContainsText(btn.props.children, 'Continue')) ?? null
  );
}

test('hasAtLeastOneMetaConnection returns false for null, undefined, and empty card lists', () => {
  assert.equal(hasAtLeastOneMetaConnection(null), false);
  assert.equal(hasAtLeastOneMetaConnection(undefined), false);
  assert.equal(hasAtLeastOneMetaConnection([]), false);
});

test('hasAtLeastOneMetaConnection returns false when only non-Meta providers are connected', () => {
  const cards: IntegrationCard[] = [
    card('linkedin', 'connected'),
    card('x', 'connected'),
    card('tiktok', 'connected'),
    card('youtube', 'connected'),
  ];
  assert.equal(hasAtLeastOneMetaConnection(cards), false);
});

test('hasAtLeastOneMetaConnection returns false when Meta and Instagram are present but not connected', () => {
  const cards: IntegrationCard[] = [
    card('facebook', 'not_connected'),
    card('instagram', 'connection_error'),
  ];
  assert.equal(hasAtLeastOneMetaConnection(cards), false);
});

test('hasAtLeastOneMetaConnection returns true when only Facebook is connected', () => {
  const cards: IntegrationCard[] = [
    card('facebook', 'connected'),
    card('instagram', 'not_connected'),
    card('linkedin', 'not_connected'),
  ];
  assert.equal(hasAtLeastOneMetaConnection(cards), true);
});

test('hasAtLeastOneMetaConnection returns true when only Instagram is connected', () => {
  const cards: IntegrationCard[] = [
    card('facebook', 'not_connected'),
    card('instagram', 'connected'),
  ];
  assert.equal(hasAtLeastOneMetaConnection(cards), true);
});

test('hasAtLeastOneMetaConnection treats reauth_required and connection_error as not connected', () => {
  const cards: IntegrationCard[] = [
    card('facebook', 'reauth_required'),
    card('instagram', 'connection_error'),
  ];
  assert.equal(hasAtLeastOneMetaConnection(cards), false);
});

test('findCardByPlatform returns null when not present', () => {
  assert.equal(findCardByPlatform([], 'facebook'), null);
  assert.equal(findCardByPlatform(null, 'facebook'), null);
  assert.equal(
    findCardByPlatform([card('linkedin', 'connected')], 'facebook'),
    null,
  );
});

test('findCardByPlatform returns the matching card', () => {
  const fb = card('facebook', 'connected');
  const result = findCardByPlatform([card('linkedin', 'not_connected'), fb], 'facebook');
  assert.equal(result, fb);
});

test('filterMetaAndInstagram returns only Meta and Instagram, in stable order', () => {
  const cards: IntegrationCard[] = [
    card('linkedin', 'connected'),
    card('instagram', 'connected'),
    card('x', 'connected'),
    card('facebook', 'not_connected'),
    card('tiktok', 'connected'),
  ];
  const filtered = filterMetaAndInstagram(cards);
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0]?.platform, 'facebook');
  assert.equal(filtered[1]?.platform, 'instagram');
});

test('filterMetaAndInstagram drops missing platforms instead of synthesizing them', () => {
  const cards: IntegrationCard[] = [card('facebook', 'connected')];
  const filtered = filterMetaAndInstagram(cards);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.platform, 'facebook');
});

test('Continue button is disabled when no Meta or Instagram connection exists', async () => {
  const { act, create } = await import('react-test-renderer');
  let root!: import('react-test-renderer').ReactTestRenderer;

  const initialCards: IntegrationCard[] = [
    card('facebook', 'not_connected'),
    card('instagram', 'not_connected'),
  ];

  await act(async () => {
    root = create(
      React.createElement(ConnectPlatformsStep, {
        onNext: () => {},
        onBack: () => {},
        initialCards,
        loadIntegrations: async () => ({ status: 'ok', cards: initialCards }),
      }),
    );
  });

  const continueButton = findContinueButton(root.root);
  assert.ok(continueButton, 'Continue button should render in the step container');
  assert.equal(continueButton?.props.disabled, true);
});

test('Continue button enables once a Meta connection arrives', async () => {
  const { act, create } = await import('react-test-renderer');
  let root!: import('react-test-renderer').ReactTestRenderer;

  const startCards: IntegrationCard[] = [
    card('facebook', 'not_connected'),
    card('instagram', 'not_connected'),
  ];

  await act(async () => {
    root = create(
      React.createElement(ConnectPlatformsStep, {
        onNext: () => {},
        onBack: () => {},
        initialCards: startCards,
        loadIntegrations: async () => ({ status: 'ok', cards: startCards }),
      }),
    );
  });

  assert.equal(findContinueButton(root.root)?.props.disabled, true);

  const connectedCards: IntegrationCard[] = [
    card('facebook', 'connected', { display_name: 'Meta' }),
    card('instagram', 'not_connected'),
  ];

  const refreshButton = root.root.findByProps({
    'data-testid': 'connect-platforms-refresh',
  });

  await act(async () => {
    root.update(
      React.createElement(ConnectPlatformsStep, {
        onNext: () => {},
        onBack: () => {},
        initialCards: connectedCards,
        loadIntegrations: async (): Promise<IntegrationsResponse> => ({
          status: 'ok',
          cards: connectedCards,
        }),
      }),
    );
  });

  assert.equal(findContinueButton(root.root)?.props.disabled, false);
  assert.ok(refreshButton, 'refresh button should be present in the step');
});

test('Continue button enables when Instagram alone is connected', async () => {
  const { act, create } = await import('react-test-renderer');
  let root!: import('react-test-renderer').ReactTestRenderer;

  const cards: IntegrationCard[] = [
    card('facebook', 'not_connected'),
    card('instagram', 'connected'),
  ];

  await act(async () => {
    root = create(
      React.createElement(ConnectPlatformsStep, {
        onNext: () => {},
        onBack: () => {},
        initialCards: cards,
        loadIntegrations: async () => ({ status: 'ok', cards }),
      }),
    );
  });

  const continueButton = findContinueButton(root.root);

  assert.equal(continueButton?.props.disabled, false);
});

test('Connect step renders both Meta and Instagram cards even if only one comes back from API', async () => {
  const { act, create } = await import('react-test-renderer');
  let root!: import('react-test-renderer').ReactTestRenderer;

  await act(async () => {
    root = create(
      React.createElement(ConnectPlatformsStep, {
        onNext: () => {},
        onBack: () => {},
        initialCards: [card('facebook', 'connected')],
        loadIntegrations: async () => ({
          status: 'ok',
          cards: [card('facebook', 'connected')],
        }),
      }),
    );
  });

  const fbCard = root.root.findByProps({ 'data-testid': 'connect-card-facebook' });
  const igCard = root.root.findByProps({ 'data-testid': 'connect-card-instagram' });
  assert.ok(fbCard, 'Meta card should render');
  assert.ok(igCard, 'Instagram card should render with synthesized fallback');
  assert.equal(igCard.props['data-state'], 'not_connected');
});

test('Connect cards route to the Composio channel-integrations surface, not legacy OAuth', async () => {
  // Regression guard for #704: the onboarding ConnectPlatformsStep CTAs must
  // point to /dashboard/settings/channel-integrations (the Composio connect
  // surface), NOT the legacy /oauth/connect/* direct-Meta OAuth path.
  const { act, create } = await import('react-test-renderer');
  let root!: import('react-test-renderer').ReactTestRenderer;

  await act(async () => {
    root = create(
      React.createElement(ConnectPlatformsStep, {
        onNext: () => {},
        onBack: () => {},
        initialCards: [
          card('facebook', 'not_connected'),
          card('instagram', 'not_connected'),
        ],
        loadIntegrations: async () => ({
          status: 'ok',
          cards: [
            card('facebook', 'not_connected'),
            card('instagram', 'not_connected'),
          ],
        }),
      }),
    );
  });

  const fbCta = root.root.findByProps({ 'data-testid': 'connect-card-cta-facebook' });
  const igCta = root.root.findByProps({ 'data-testid': 'connect-card-cta-instagram' });
  assert.equal(fbCta.props.href, '/dashboard/settings/channel-integrations',
    'FB connect CTA must route to the Composio surface, not /oauth/connect/*');
  assert.equal(igCta.props.href, '/dashboard/settings/channel-integrations',
    'IG connect CTA must route to the Composio surface, not /oauth/connect/*');
  // Explicit anti-regression: neither CTA may reference the legacy path.
  assert.ok(!fbCta.props.href.startsWith('/oauth/connect/'),
    'FB connect CTA must not reference the legacy /oauth/connect/ path');
  assert.ok(!igCta.props.href.startsWith('/oauth/connect/'),
    'IG connect CTA must not reference the legacy /oauth/connect/ path');
});

test('Connect step never renders LinkedIn, X, TikTok, YouTube, or Reddit cards', async () => {
  const { act, create } = await import('react-test-renderer');
  let root!: import('react-test-renderer').ReactTestRenderer;

  const cards: IntegrationCard[] = [
    card('facebook', 'not_connected'),
    card('instagram', 'not_connected'),
    card('linkedin', 'connected'),
    card('x', 'connected'),
    card('tiktok', 'not_connected'),
    card('youtube', 'not_connected'),
    card('reddit', 'not_connected'),
  ];

  await act(async () => {
    root = create(
      React.createElement(ConnectPlatformsStep, {
        onNext: () => {},
        onBack: () => {},
        initialCards: cards,
        loadIntegrations: async () => ({ status: 'ok', cards }),
      }),
    );
  });

  for (const platform of ['linkedin', 'x', 'tiktok', 'youtube', 'reddit']) {
    const matches = root.root.findAllByProps({ 'data-testid': `connect-card-${platform}` });
    assert.equal(matches.length, 0, `connect-card-${platform} should not render in the onboarding connect step`);
  }
});

test('Connect step does not surface "campaign" or render any user-facing campaign copy', async () => {
  const { act, create } = await import('react-test-renderer');
  let root!: import('react-test-renderer').ReactTestRenderer;

  await act(async () => {
    root = create(
      React.createElement(ConnectPlatformsStep, {
        onNext: () => {},
        onBack: () => {},
        initialCards: [
          card('facebook', 'connected'),
          card('instagram', 'not_connected'),
        ],
        loadIntegrations: async () => ({
          status: 'ok',
          cards: [
            card('facebook', 'connected'),
            card('instagram', 'not_connected'),
          ],
        }),
      }),
    );
  });

  const tree = JSON.stringify(root.toJSON());
  assert.equal(
    /\bcampaign\b/i.test(tree),
    false,
    'The connect step should not surface "campaign" in user-facing copy.',
  );
});
