import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import PlatformCard from '../frontend/settings/platform-card';
import type { IntegrationCard } from '../lib/api/integrations';

type SyncAwareIntegrationCard = IntegrationCard & {
  sync_state?: 'current' | 'stale' | 'never_synced';
};

function connectedCard(overrides: Partial<SyncAwareIntegrationCard> = {}): SyncAwareIntegrationCard {
  return {
    platform: 'facebook',
    display_name: 'Meta',
    description: 'Meta is connected and ready.',
    connection_state: 'connected',
    health: 'healthy',
    available_actions: ['sync_now'],
    last_synced_at: null,
    sync_state: 'never_synced',
    expires_at: null,
    permissions: [],
    connected_account: {
      account_id: 'page-123',
      account_label: 'Aries AI',
    },
    ...overrides,
  };
}

function renderCard(card: SyncAwareIntegrationCard): string {
  return renderToStaticMarkup(React.createElement(PlatformCard, { card }));
}

test('connected integration card renders a never-synced empty state', () => {
  const markup = renderCard(connectedCard());

  assert.match(markup, /Last sync/);
  assert.match(markup, /Never synced/);
  assert.doesNotMatch(markup, /Stale/);
});

test('connected integration card renders the backend stale state', () => {
  const markup = renderCard(connectedCard({
    last_synced_at: '2026-07-19T08:30:00.000Z',
    sync_state: 'stale',
  }));

  assert.match(markup, /Last sync/);
  assert.match(markup, /Stale/);
  assert.doesNotMatch(markup, /Never synced/);
});

test('connected integration card renders a current last-sync timestamp without a warning', () => {
  const timestamp = '2026-07-19T11:50:00.000Z';
  const markup = renderCard(connectedCard({
    last_synced_at: timestamp,
    sync_state: 'current',
  }));
  const expectedLabel = new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  assert.match(markup, /Last sync/);
  assert.ok(markup.includes(expectedLabel));
  assert.doesNotMatch(markup, /Never synced|Stale/);
});

test('connected integration card treats an invalid timestamp as never synced', () => {
  const markup = renderCard(connectedCard({
    last_synced_at: 'not-a-timestamp',
    sync_state: 'stale',
  }));

  assert.match(markup, /Last sync/);
  assert.match(markup, /Never synced/);
  assert.doesNotMatch(markup, /Invalid Date|Stale/);
});

test('disconnected and disabled integration cards keep sync telemetry hidden', () => {
  for (const connectionState of ['not_connected', 'disabled'] as const) {
    const markup = renderCard(connectedCard({
      connection_state: connectionState,
      last_synced_at: '2026-07-19T08:30:00.000Z',
      sync_state: 'stale',
    }));

    assert.doesNotMatch(markup, /Last sync|Never synced|Stale/);
  }
});
