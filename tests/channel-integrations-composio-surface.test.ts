import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const channelPageSource = readFileSync(
  path.join(PROJECT_ROOT, 'app', 'dashboard', 'settings', 'channel-integrations', 'page.tsx'),
  'utf8',
);
const composioHandlersSource = readFileSync(
  path.join(PROJECT_ROOT, 'app', 'api', 'integrations', 'composio', 'handlers.ts'),
  'utf8',
);
const connectionsPageSource = readFileSync(
  path.join(PROJECT_ROOT, 'app', 'connections', 'page.tsx'),
  'utf8',
);

test('the dashboard Channel Integrations route renders the Composio connections surface inside the app shell', () => {
  // The connect surface must live in the dashboard shell (the "Channel
  // Integrations" nav entry), not only on a standalone page, so operators can
  // connect Facebook/Instagram via Composio from the dashboard itself.
  assert.match(channelPageSource, /ComposioConnectionsScreen/, 'page must render the Composio connections screen');
  assert.match(channelPageSource, /AppShellLayout/, 'page must wrap the screen in the dashboard app shell');
  assert.match(channelPageSource, /currentRouteId="channelIntegrations"/);
});

test('the Composio OAuth callback returns the operator to the in-dashboard connections surface', () => {
  assert.match(
    composioHandlersSource,
    /\/dashboard\/settings\/channel-integrations\?connected=\$\{platform\}/,
    'connect callback should land on the in-dashboard channel integrations page',
  );
  assert.ok(
    !composioHandlersSource.includes('`${base}/connections?connected='),
    'the old standalone /connections callback target should be replaced',
  );
});

test('the standalone /connections route redirects to the canonical in-dashboard surface', () => {
  assert.match(connectionsPageSource, /redirect\('\/dashboard\/settings\/channel-integrations'\)/);
});
