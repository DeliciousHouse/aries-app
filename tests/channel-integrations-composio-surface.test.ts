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

// ─── #703: Clear affordance for stuck rows in ComposioConnectionsScreen ───────

const composioConnectionsScreenSource = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'integrations', 'composio-connections-screen.tsx'),
  'utf8',
);

test('#703: composio-connections-screen defines hasClearableRow for pending/reauthorization_required/error', () => {
  // The hasClearableRow gate must cover exactly the three non-terminal stuck
  // statuses. A not_connected row has no existing connection record to clear.
  assert.ok(
    composioConnectionsScreenSource.includes("hasClearableRow"),
    'screen must define a hasClearableRow variable to gate the Clear button',
  );
  // All three stuck statuses must be in the gate.
  const gateIdx = composioConnectionsScreenSource.indexOf('hasClearableRow');
  const gateBlock = composioConnectionsScreenSource.slice(gateIdx, gateIdx + 200);
  assert.ok(
    gateBlock.includes("'pending'") || gateBlock.includes('"pending"'),
    'hasClearableRow must include pending status',
  );
  assert.ok(
    gateBlock.includes("'reauthorization_required'") || gateBlock.includes('"reauthorization_required"'),
    'hasClearableRow must include reauthorization_required status',
  );
  assert.ok(
    gateBlock.includes("'error'") || gateBlock.includes('"error"'),
    'hasClearableRow must include error status',
  );
  // not_connected must NOT appear in the hasClearableRow gate.
  assert.ok(
    !gateBlock.includes("'not_connected'") && !gateBlock.includes('"not_connected"'),
    'hasClearableRow must NOT include not_connected — that status has no record to clear',
  );
});

test('#703: composio-connections-screen renders a Clear button gated on hasClearableRow, wired to disconnect', () => {
  // The Clear button must only appear when hasClearableRow is true (i.e. not for
  // not_connected rows) and must call the same disconnect handler as the
  // connected-branch Disconnect button.
  const clearBtnIdx = composioConnectionsScreenSource.indexOf("'Clear'");
  assert.ok(clearBtnIdx >= 0, "screen must render a 'Clear' button label");

  // The block around the Clear button must be guarded by hasClearableRow.
  // Look back up to 900 chars from the button label for the hasClearableRow gate.
  // (The gate expression is ~776 chars before the Clear string label in the render output.)
  const windowBefore = composioConnectionsScreenSource.slice(
    Math.max(0, clearBtnIdx - 900),
    clearBtnIdx,
  );
  assert.ok(
    windowBefore.includes('hasClearableRow'),
    'Clear button must be wrapped in a hasClearableRow conditional',
  );

  // The onClick must call disconnect.
  // The onClick attribute is ~318 chars before the 'Clear' string label, so use a 400-char lookback.
  const btnBlock = composioConnectionsScreenSource.slice(clearBtnIdx - 400, clearBtnIdx + 50);
  assert.ok(
    btnBlock.includes('disconnect('),
    "Clear button's onClick must call the disconnect handler",
  );
});

test('#703: composio-connections-screen connected branch renders Disconnect (not Clear)', () => {
  // The connected branch renders a Disconnect button. This is distinct from the
  // non-connected branch's Clear button: a live connection must say "Disconnect",
  // not "Clear" (which is for stuck/partial rows).
  const isConnectedBranchIdx = composioConnectionsScreenSource.indexOf('isConnected ?');
  assert.ok(isConnectedBranchIdx >= 0, 'screen must have an isConnected branch');

  // Within ~450 chars of the isConnected branch the Disconnect label appears
  // (the button text is inside the button children, after the className prop).
  const connectedBlock = composioConnectionsScreenSource.slice(
    isConnectedBranchIdx,
    isConnectedBranchIdx + 500,
  );
  assert.ok(
    connectedBlock.includes("'Disconnect'") || connectedBlock.includes('"Disconnect"'),
    'the connected branch must render a Disconnect button, not a Clear button',
  );
  assert.ok(
    !connectedBlock.includes("'Clear'") && !connectedBlock.includes('"Clear"'),
    'the connected branch must not render a Clear button — that is only for stuck rows',
  );
});
